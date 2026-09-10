import { database } from "../plugins/database/api";
import { limiter } from "../plugins/guard/api";
import { createKernel } from "../plugins/kernel/api";
import { SECRET } from "../plugins/kernel/internal/validate";

import type { DrizzleDb, Store } from "../plugins/database/api";
import type { Identity, HttpClient, Kernel, HttpRequest, Plugin, ChannelMessage } from "../plugins/kernel/api";

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

    /** Whether events are kept until a listener has recorded them, as `start({ outbox: true })` does. */
    outbox?: boolean;

    /** Whether a plugin may ask for work later, as `start({ schedule: true })`. */
    schedule?: boolean;

    /** Whether a plugin may push, as `start({ sockets: true })` does. */
    sockets?: boolean;

    /** What the clock answers, so a test can reach tomorrow. */
    now?: () => number;
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

    /** Waits until every listener an emit started has finished. */
    flush: () => Promise<void>;

    /** Runs whatever the schedule says is due, once. */
    due: () => Promise<number>;

    /** Runs what is due, and what that starts, until nothing is left. */
    drain: (most?: number) => Promise<void>;

    stop: () => Promise<void>;
};

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
const TAKES: ReadonlySet<string> = new Set(["plugins", "config", "respondWith", "outbox", "schedule", "sockets", "now"]);

export async function startTestKernel(options: TestKernelOptions): Promise<TestKernel>
{
    const unknown = Object.keys(options).filter((key) => !TAKES.has(key));

    if (unknown.length > 0)
    {
        throw new TypeError(
            `startTestKernel was given ${unknown.map((key) => `"${key}"`).join(", ")}, which it does not take. It takes ${[...TAKES].join(", ")}.`,
        );
    }

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

    const answering: HttpClient = (call) =>
    {
        calls.push({ method: call.method, url: call.url, body: call.body, headers: redacted(call.headers) });

        return Promise.resolve(options.respondWith?.(call) ?? {});
    };

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

        beatMs: 24 * 60 * 60 * 1000,
        db: store,
        httpClient: answering,
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

        flush: async (): Promise<void> =>
        {
            for (let turn = 0; turn < 4; turn += 1)
            {
                await new Promise((done) => { setTimeout(done, 0); });
            }

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

/** An identity a test controls. */
export function createIdentity(
    permissions: readonly string[] = [],
    id = "11111111-1111-4111-8111-111111111111",
    claims: Readonly<Record<string, unknown>> = {},
): Identity
{
    return { id, permissions, claims };
}
