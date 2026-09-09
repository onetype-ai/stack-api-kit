import { database } from "../plugins/database/api";
import { limiter } from "../plugins/guard/api";
import { createKernel } from "../plugins/kernel/api";
import { SECRET } from "../plugins/kernel/internal/validate";

import type { Handle, Store } from "../plugins/database/api";
import type { Identity, Dialer, Kernel, Outbound, Plugin, Pushed } from "../plugins/kernel/api";

export type LogLine = {
    level: string;
    plugin: string;
    line: string;
} & Readonly<Record<string, unknown>>;

/** One outbound call, as a test sees it. */
export type OutboundCall = {
    method: string;
    url: string;
    body: unknown;

    /**
     * What was sent, with a credential's value replaced by `"[redacted]"`.
     *
     * The name and its place stay, so a test still proves the key went to the
     * host that owns it. The value does not, because the commonest way a test
     * shows what it recorded is by failing, and a failure is printed into a
     * log that outlives the run and is often read by strangers.
     */
    headers: Readonly<Record<string, string>> | undefined;
};

/** A credential's value, held back from what a test prints. */
function redacted(headers: Readonly<Record<string, string>> | undefined): Readonly<Record<string, string>> | undefined
{
    if (headers === undefined)
    {
        return undefined;
    }

    return Object.fromEntries(Object.entries(headers).map(([name, value]) =>
        [name, SECRET.has(name.toLowerCase()) ? "[redacted]" : value]));
}

export type TestKernelOptions = {
    plugins: readonly Plugin[];
    config?: Readonly<Record<string, unknown>>;
    answers?: (call: Outbound) => unknown;

    /**
     * Whether events are kept until a listener has recorded them, as
     * `start({ outbox: true })` does.
     *
     * A test proving a listener survives hearing the same event twice needs
     * the same machinery the deployment runs, or it is proving something
     * else.
     */
    outbox?: boolean;

    /**
     * Whether a plugin may ask for work later, as `start({ schedule: true })`.
     *
     * A test drives it with `due()` rather than a beat: waiting a real second
     * to watch a job run is a slow test that fails on a busy machine.
     */
    schedule?: boolean;

    /**
     * Whether a plugin may push, as `start({ sockets: true })` does.
     *
     * Nothing here holds a wire: what was pushed is kept, so a test reads it
     * from `pushed()` rather than opening a socket to hear it.
     */
    sockets?: boolean;

    /** What the clock answers, so a test can reach tomorrow. */
    now?: () => number;
};

/** One event, as a test sees it. */
export type EmittedEvent = {
    plugin: string;
    event: string;
    payload: unknown;
};

export type TestKernel = {
    kernel: Kernel;
    store: Store<Handle>;
    logLines: LogLine[];
    outboundCalls: () => OutboundCall[];

    /**
     * Every event emitted since boot, in order.
     *
     * A plugin with no listener still emits, and proving that it did would
     * otherwise mean writing a plugin whose only purpose is to hear. This
     * listens to everything declared, so a test asserts on the emit itself.
     */
    emittedEvents: () => EmittedEvent[];

    /** Everything pushed since boot, in order, with how far each was to go. */
    pushed: () => Pushed[];

    /**
     * An identity whose permissions `grants` decided, from claims a test names.
     *
     * `createIdentity` takes the permissions written out, which makes a test
     * prove its own copy of the role table against that same copy: widen a
     * role and the assertion that a caller is refused stays green, because
     * nothing asked the plugin that decides.
     */
    granted: (claims: Readonly<Record<string, unknown>>, id?: string) => Promise<Identity>;

    /**
     * Waits until every listener an emit started has finished.
     *
     * `emit` returns void and a listener runs after the caller, so a test
     * that reads straight after emitting reads the state from before it.
     * Nothing in a plugin ever needs this; a test that asserts on what a
     * listener did always does.
     */
    settle: () => Promise<void>;

    /**
     * Runs whatever the schedule says is due, once.
     *
     * A test moves its own clock forward and asks, rather than waiting for a
     * beat: what is being proved is that the work runs at its moment, not
     * that an interval fired.
     *
     * Answers how many it took, so a chain is drained rather than counted.
     */
    due: () => Promise<number>;

    /**
     * Runs what is due, and what that starts, until nothing is left.
     *
     * A command asking for another needs one `due()` per link, which reads
     * as superstition in a test. `most` bounds it, because work that asks
     * for itself as it ends would otherwise never stop.
     */
    drain: (most?: number) => Promise<void>;

    stop: () => Promise<void>;
};

export const TestTables = {
    tables: (plugins: readonly Plugin[]): Readonly<Record<string, Readonly<Record<string, unknown>>>> =>
    {
        return Object.fromEntries(plugins.map((plugin) => [plugin.name, plugin.definition.tables ?? {}]));
    },

    migrations: (plugins: readonly Plugin[]): { plugin: string; from: string }[] =>
    {
        return plugins
            .filter((plugin) => plugin.definition.migrations !== undefined)
            .map((plugin) => ({ plugin: plugin.name, from: plugin.definition.migrations as string }));
    },
};

/** Everything `startTestKernel` knows how to be given. */
const TAKES: ReadonlySet<string> = new Set(["plugins", "config", "answers", "outbox", "schedule", "sockets", "now"]);

export async function startTestKernel(given: TestKernelOptions): Promise<TestKernel>
{
    // Refused rather than ignored: a key that looks like it worked is how an
    // author spends an afternoon on a test that was never wired to anything.
    const unknown = Object.keys(given).filter((key) => !TAKES.has(key));

    if (unknown.length > 0)
    {
        throw new TypeError(
            `startTestKernel was given ${unknown.map((key) => `"${key}"`).join(", ")}, which it does not take. It takes ${[...TAKES].join(", ")}.`,
        );
    }

    const store = database({ file: ":memory:", tables: TestTables.tables(given.plugins) });

    store.migrate(TestTables.migrations(given.plugins));

    const lines: LogLine[] = [];
    const calls: OutboundCall[] = [];
    const events: EmittedEvent[] = [];

    // A plugin that hears everything, added to the ones under test. Named so
    // it cannot collide with a real one, and declared as listening to every
    // event the given plugins publish.
    const listening: Plugin = {
        name: "testing-ears",
        definition: {
            version: "1.0.0",
            describe: "Records every event, for a test to read.",
            // Only what the given plugins declare: an ear on an event nobody
            // publishes fails the boot, blaming a plugin the author never
            // wrote and cannot find.
            listens: Object.fromEntries(
                given.plugins.flatMap((plugin) =>
                    Object.keys(plugin.definition.emits ?? {}).map((event) => [event, {
                        describe: `Records ${event}.`,

                        // The plugin recorded is the one that declared the
                        // event, not this one: ctx.name here is always the
                        // listener, which tells a test nothing.
                        handle: (payload: never): void =>
                        {
                            events.push({ plugin: plugin.name, event, payload });
                        },
                    }]),
                ),
            ),
        },
    };

    const dial: Dialer = (call) =>
    {
        calls.push({ method: call.method, url: call.url, body: call.body, headers: redacted(call.headers) });

        return Promise.resolve(given.answers?.(call) ?? {});
    };

    const outbox = given.outbox === true ? store.outbox?.() : undefined;
    const later = given.schedule === true ? store.schedule?.() : undefined;
    const scoping = given.plugins.some((plugin) => plugin.definition.scope !== undefined);

    const pushes: Pushed[] = [];

    const kernel = createKernel({
        plugins: [...given.plugins, listening],
        ...(given.sockets === true && { sockets: { push: (sending: Pushed) => pushes.push(sending) } }),
        ...(outbox !== undefined && { outbox }),
        ...(later !== undefined && { schedule: later }),
        ...(scoping && store.createScopeFilter !== undefined && { narrow: store.createScopeFilter() }),
        ...(given.now !== undefined && { now: given.now }),

        // Never a beat in a test: a job that fires on its own turns an
        // assertion into a race with an interval nobody controls.
        beat: 24 * 60 * 60 * 1000,
        db: store,
        dial,
        budget: limiter(),
        config: given.config ?? {},
        log: (level, plugin, line, about) =>
        {
            lines.push({ level, plugin, line, ...about });
        },
    });

    await kernel.start();

    // How many listener failures this test has already been told about, so
    // one it took deliberately is not raised again on the next settle.
    let seen = 0;

    const granting = given.plugins.find((plugin) => plugin.definition.grants !== undefined);

    return {
        kernel,
        store,
        logLines: lines,
        outboundCalls: () => [...calls],
        emittedEvents: () => [...events],
        pushed: () => [...pushes],

        granted: async (claims: Readonly<Record<string, unknown>>, id = "11111111-1111-4111-8111-111111111111"): Promise<Identity> =>
        {
            if (granting === undefined)
            {
                throw new Error("No plugin here declares grants, so nothing decides what an identity holds. Write the permissions with createIdentity instead.");
            }

            const who = { id, claims };
            const permissions = await granting.definition.grants?.(kernel.context(granting.name) as never, who) ?? [];

            return { ...who, permissions };
        },

        due: () => kernel.due(),

        drain: async (most = 20): Promise<void> =>
        {
            for (let turn = 0; turn < most; turn += 1)
            {
                if (await kernel.due() === 0)
                {
                    return;
                }
            }
        },

        settle: async (): Promise<void> =>
        {
            // Two turns, not one: a listener that writes hands its work to
            // the store's queue, and a chain of two listeners needs the
            // second to start before the first is done.
            for (let turn = 0; turn < 4; turn += 1)
            {
                await new Promise((done) => { setTimeout(done, 0); });
            }

            // A listener reaches nobody when it throws, so a test asserting
            // on what it wrote reads the state from before and passes. The
            // one place that knows is here, at the moment the test waited.
            //
            // From `seen`, not from when this call started: a synchronous
            // listener throws on the emit itself, before anything settles,
            // and only counting what failed during the wait would miss it.
            // Read `failures()` first to take one deliberately.
            const failed = kernel.events.failures().slice(seen);

            seen = kernel.events.failures().length;

            if (failed.length > 0)
            {
                const named = failed.map((one) =>
                {
                    const why = one.error instanceof Error ? one.error.message : String(one.error);

                    return `  - ${one.plugin} listening to "${one.event}": ${why}`;
                });

                throw new Error(
                    `${failed.length} ${failed.length === 1 ? "listener" : "listeners"} threw while settling, so what they were meant to write is not there:\n${named.join("\n")}\nRead kernel.events.failures() before settling to expect one.`,
                );
            }
        },
        stop: async (): Promise<void> =>
        {
            await kernel.stop();
            store.close();
        },
    };
}

/**
 * An identity a test controls.
 *
 * `claims` is what the project decided a caller carries: a tenant, a role, a
 * plan. The kernel never reads it, so a test proving that one tenant cannot
 * reach another's rows has to be able to say who this identity belongs to.
 */
export function createIdentity(
    permissions: readonly string[] = [],
    id = "11111111-1111-4111-8111-111111111111",
    claims: Readonly<Record<string, unknown>> = {},
): Identity
{
    return { id, permissions, claims };
}
