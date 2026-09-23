import { database } from "../plugins/database/api";
import { limiter } from "../plugins/guard/api";
import { createKernel } from "../plugins/kernel/api";
import { SECRET } from "../plugins/kernel/internal/validate";

import type { DrizzleDb, Store } from "../plugins/database/api";
import type { Identity, HttpClient, Kernel, HttpRequest, Lookup, Plugin, ChannelMessage, ResolvedAddress } from "../plugins/kernel/api";

/** One line a plugin logged, flattened: `level`, `plugin` and `line` are always there, and whatever the call passed as `about` is spread alongside them. */
export type LogLine = {
    level: string;
    plugin: string;
    line: string;
} & Readonly<Record<string, unknown>>;

/** One outbound call, as a test sees it. */
export type SentRequest = {
    method: string;
    url: string;
    body: unknown;

    /** What was sent, with a credential's value replaced by `"[redacted]"`. */
    headers: Readonly<Record<string, string>> | undefined;

    /** The address the call was dialled at, for a plugin reaching "anywhere". */
    address?: string;
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
    respondWith?: (request: HttpRequest) => unknown;

    /** Whether events are kept until a listener has recorded them, as `start({ outbox: true })` does. Left out it is off, and 9.0 turns it on: pass `true` to test as a deployment with an outbox runs. */
    outbox?: boolean;

    /** Holds every reply to the header allow-list, as `start({ strictReplyHeaders: true })` does. */
    strictReplyHeaders?: boolean;

    /** Whether a plugin may ask for work later, as `start({ schedule: true })`. */
    schedule?: boolean;

    /** Whether a plugin may push, as `start({ sockets: true })` does. */
    sockets?: boolean;

    /** What the clock answers, so a test can reach tomorrow. */
    now?: () => number;

    /** What a name resolves to for a plugin reaching "anywhere"; every name answers 93.184.215.14 when left out, so no test asks real DNS. */
    lookup?: Lookup;
};

/** One event, as a test sees it. */
export type SeenEvent = {
    plugin: string;
    event: string;
    payload: unknown;
};

export type TestKernel = {
    kernel: Kernel;
    store: Store<DrizzleDb>;
    logLines: LogLine[];
    sentRequests: () => SentRequest[];

    /** Every event emitted since boot, in order. */
    emittedEvents: () => SeenEvent[];

    /** Everything pushed since boot, in order, with how far each was to go. */
    pushed: () => ChannelMessage[];

    /** An identity whose permissions `grants` decided, from claims a test names. */
    granted: (claims: Readonly<Record<string, unknown>>, id?: string) => Promise<Identity>;

    /** Waits until every listener an emit started has finished, however long its work takes, outbox or not. */
    flush: () => Promise<void>;

    /** Runs whatever the schedule says is due, once. */
    due: () => Promise<number>;

    /** Runs what is due, and what that starts, until nothing is left. */
    drain: (maxRounds?: number) => Promise<void>;

    stop: () => Promise<void>;
};

/** Pulls the table declarations and migration sources out of a list of plugins, for a test building its own store rather than letting `startTestKernel` build one. */
export const testTables = {
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

/** Every option `startTestKernel` knows. */
const TAKES: ReadonlySet<string> = new Set(["plugins", "config", "respondWith", "outbox", "schedule", "sockets", "now", "lookup", "strictReplyHeaders"]);

/** Whether this process was already told that the outbox default changes in 9.0. */
let toldOfOutbox = false;

// example.com's address: public, so the check passes, and never dialled, since the test kernel answers calls itself.
const PUBLIC_ADDRESS: readonly ResolvedAddress[] = [{ address: "93.184.215.14", family: 4 }];

/** Where a test kernel finds the plugins a test did not pass: every plugin the project holds, and the config each boots with there (a non-secret fixture). */
export type TestKernelFixture = {
    plugins: readonly Plugin[];
    config: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
};

let resolving: ((missing: readonly string[]) => Promise<TestKernelFixture>) | undefined;

/** What every test kernel in this process starts from when a test does not say, from `configureTestKernels`. */
export type TestKernelDefaults = Pick<TestKernelOptions, "outbox" | "strictReplyHeaders" | "schedule" | "sockets">;

let defaults: TestKernelDefaults = {};

/** Every plugin the fixture has handed over in this process, and the config it named for each, by name. */
const discovered = new Map<string, Plugin>();
const discoveredConfig = new Map<string, Readonly<Record<string, unknown>>>();
const asked = new Set<string>();

/**
 * Registers, once per test process (a setup file), where missing dependencies come from. `resolve` is given the names
 * nothing passed provides, in waves as their own dependencies turn up, and each name is asked for once: a resolver
 * may load only those plugins, or answer every plugin it holds. A test that passes every plugin it needs never calls it.
 */
export function configureTestKernels(configuring: { resolve?: (missing: readonly string[]) => Promise<TestKernelFixture>; defaults?: TestKernelDefaults }): void
{
    resolving = configuring.resolve;
    defaults = { ...configuring.defaults };
    discovered.clear();
    discoveredConfig.clear();
    asked.clear();
}

/** The names a closure over these plugins needs that neither they nor the fixture's answers so far provide. */
function missingFrom(plugins: readonly Plugin[]): string[]
{
    const chosen = new Map(plugins.map((plugin) => [plugin.name, plugin]));
    const missing = new Set<string>();
    const seen = new Set<string>();
    const walk = (plugin: Plugin): void =>
    {
        if (seen.has(plugin.name))
        {
            return;
        }

        seen.add(plugin.name);

        for (const name of plugin.definition.dependsOn ?? [])
        {
            const next = chosen.get(name) ?? discovered.get(name);

            if (next === undefined)
            {
                missing.add(name);
            }
            else
            {
                walk(next);
            }
        }
    };

    plugins.forEach(walk);

    return [...missing];
}

/** Asks the fixture for what is missing, wave by wave, until nothing new can be found. */
async function discover(plugins: readonly Plugin[]): Promise<void>
{
    for (;;)
    {
        const wanted = missingFrom(plugins).filter((name) => !asked.has(name));

        if (resolving === undefined || wanted.length === 0)
        {
            return;
        }

        wanted.forEach((name) => asked.add(name));

        let answered: TestKernelFixture;

        try
        {
            answered = await resolving(wanted);
        }
        catch (cause)
        {
            // a failed read is tried again next time
            wanted.forEach((name) => asked.delete(name));

            throw cause;
        }

        for (const plugin of answered.plugins)
        {
            if (!discovered.has(plugin.name))
            {
                discovered.set(plugin.name, plugin);

                const config = answered.config[plugin.name];

                if (config !== undefined)
                {
                    discoveredConfig.set(plugin.name, config);
                }
            }
        }
    }
}

/** Whether any plugin names a dependency the list does not hold. */
function isMissingAny(plugins: readonly Plugin[]): boolean
{
    const names = new Set(plugins.map((plugin) => plugin.name));

    return plugins.some((plugin) => (plugin.definition.dependsOn ?? []).some((name) => !names.has(name)));
}

/**
 * The plugins with every transitive dependsOn added from the fixture: a plugin passed wins by name (a stand-in stays one, its own
 * dependsOn closed over too), dependencies come first, and otherwise the order given holds. Unchanged when nothing is missing or
 * no fixture is registered; throws naming the plugin and the dependency when neither the test nor the fixture has it.
 */
export async function withDependencies(plugins: readonly Plugin[]): Promise<Plugin[]>
{
    if (resolving === undefined || !isMissingAny(plugins))
    {
        return [...plugins];
    }

    await discover(plugins);

    const chosen = new Map(plugins.map((plugin) => [plugin.name, plugin]));
    const ordered: Plugin[] = [];
    const placed = new Set<string>();
    const visiting = new Set<string>();

    const visit = (plugin: Plugin): void =>
    {
        if (placed.has(plugin.name) || visiting.has(plugin.name))
        {
            return;
        }

        visiting.add(plugin.name);

        for (const name of plugin.definition.dependsOn ?? [])
        {
            const next = chosen.get(name) ?? discovered.get(name);

            if (next === undefined)
            {
                throw new TypeError(`startTestKernel: "${plugin.name}" depends on "${name}", which the test did not pass and no discovered plugin is named. Pass a plugin named "${name}", or remove it from dependsOn.`);
            }

            chosen.set(name, next);
            visit(next);
        }

        visiting.delete(plugin.name);
        placed.add(plugin.name);
        ordered.push(plugin);
    };

    for (const plugin of plugins)
    {
        visit(plugin);
    }

    return ordered;
}

// The fixture's config reaches only the plugins the closure added, never one the test passed (a stand-in, or a plugin
// whose config the test is proving wrong), and the test's own config for an added plugin wins field by field.
async function closedOver(options: TestKernelOptions): Promise<TestKernelOptions>
{
    const plugins = await withDependencies(options.plugins);

    if (plugins.length === options.plugins.length)
    {
        return options;
    }

    const config: Record<string, unknown> = { ...options.config };

    for (const plugin of plugins)
    {
        const added = !options.plugins.includes(plugin);
        const base = added && discovered.get(plugin.name) === plugin ? discoveredConfig.get(plugin.name) : undefined;
        const given = options.config?.[plugin.name];

        if (base !== undefined)
        {
            config[plugin.name] = typeof given === "object" && given !== null ? { ...base, ...given } : given ?? base;
        }
    }

    return { ...options, plugins, config };
}

/** Boots a kernel on an in-memory database with migrations already applied; a dependency the test did not pass is added from the fixture `configureTestKernels` registered, with the fixture's config under the test's own, field by field. It records every event, log line and outbound call, throws on an option it does not take, and outbound calls answer `{}` unless `respondWith` says otherwise. */
export async function startTestKernel(asked: TestKernelOptions): Promise<TestKernel>
{
    const unknown = Object.keys(asked).filter((key) => !TAKES.has(key));

    if (unknown.length > 0)
    {
        throw new TypeError(
            `startTestKernel was given ${unknown.map((key) => `"${key}"`).join(", ")}, which it does not take. It takes ${[...TAKES].join(", ")}.`,
        );
    }

    // a test's own options win over the process's defaults, key by key
    const options = await closedOver({ ...defaults, ...asked });

    const store = database({ file: ":memory:", tables: testTables.tables(options.plugins) });

    store.migrate(testTables.migrations(options.plugins));

    const lines: LogLine[] = [];
    const calls: SentRequest[] = [];
    const events: SeenEvent[] = [];

    const listening: Plugin = {
        name: "testing-ears",
        definition: {
            version: "1.0.0",
            describe: "Records every event, for a test to read.",
            listens: Object.fromEntries(
                options.plugins.flatMap((plugin) =>
                    Object.keys(plugin.definition.emits ?? {}).map((event) => [event, {
                        describe: `Records ${event}.`,

                        handle: (payload: never): void =>
                        {
                            events.push({ plugin: plugin.name, event, payload });
                        },
                    }]),
                ),
            ),
        },
    };

    const answering: HttpClient = (call, pin) =>
    {
        calls.push({ method: call.method, url: call.url, body: call.body, headers: redacted(call.headers), ...(pin !== undefined && { address: pin.address }) });

        return Promise.resolve(options.respondWith?.(call) ?? {});
    };

    // off unless asked until 9.0: with one, an event emitted outside a transaction is refused here, not first in production
    if (options.outbox === undefined && !toldOfOutbox)
    {
        toldOfOutbox = true;
        process.emitWarning("startTestKernel runs without an outbox when none is asked for, and 9.0 turns it on. Pass outbox: true to test as a deployment with an outbox runs, or outbox: false to keep testing without one.", { code: "STACK_API_KIT_TEST_OUTBOX" });
    }

    const outbox = options.outbox === true ? store.outbox?.() : undefined;
    const later = options.schedule === true ? store.schedule?.() : undefined;
    const scoping = options.plugins.some((plugin) => plugin.definition.scope !== undefined);

    const pushes: ChannelMessage[] = [];

    const kernel = createKernel({
        plugins: [...options.plugins, listening],
        ...(options.sockets === true && { sockets: { push: (sending: ChannelMessage) => pushes.push(sending) } }),
        ...(outbox !== undefined && { outbox }),
        ...(later !== undefined && { schedule: later }),
        ...(scoping && store.createScopeFilter !== undefined && { scopeFilter: store.createScopeFilter() }),
        ...(options.now !== undefined && { now: options.now }),

        // a test runs what is due and what failed itself, with due() and kernel.redeliver()
        beatMs: 24 * 60 * 60 * 1000,
        outboxBeatMs: 24 * 60 * 60 * 1000,
        db: store,
        httpClient: answering,
        lookup: options.lookup ?? (() => Promise.resolve(PUBLIC_ADDRESS)),
        ...(options.strictReplyHeaders !== undefined && { strictReplyHeaders: options.strictReplyHeaders }),
        rateLimiter: limiter(),
        config: options.config ?? {},
        log: (level, plugin, line, about) =>
        {
            lines.push({ level, plugin, line, ...about });
        },
    });

    await kernel.start();

    let seen = 0;

    const granting = options.plugins.find((plugin) => plugin.definition.grants !== undefined);

    return {
        kernel,
        store,
        logLines: lines,
        sentRequests: () => [...calls],
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

        drain: async (maxRounds = 20): Promise<void> =>
        {
            for (let round = 0; round < maxRounds; round += 1)
            {
                if (await kernel.due() === 0)
                {
                    return;
                }
            }
        },

        flush: async (): Promise<void> =>
        {
            for (let tick = 0; tick < 4; tick += 1)
            {
                await new Promise((done) => { setTimeout(done, 0); });
            }

            // every delivery an emit started, and those its listeners started in turn, however long their work takes
            await kernel.settled();

            const failed = kernel.events.failures().slice(seen);

            seen = kernel.events.failures().length;

            if (failed.length > 0)
            {
                const named = failed.map((failure) =>
                {
                    const reason = failure.error instanceof Error ? failure.error.message : String(failure.error);

                    return `  - ${failure.plugin} listening to "${failure.event}": ${reason}`;
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

/** An identity a test controls. */
export function createIdentity(
    permissions: readonly string[] = [],
    id = "11111111-1111-4111-8111-111111111111",
    claims: Readonly<Record<string, unknown>> = {},
): Identity
{
    return { id, permissions, claims };
}
