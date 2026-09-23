import type { DatabaseOptions, Store } from "../database/api";
import type { Subscription, ServerOptions } from "../http/api";
import type { RateLimiter, HttpClient, Identity, Kernel, Logger, Lookup, Plugin } from "../kernel/api";
import type { HttpClientOptions } from "../outbound/api";
import { discover, discoverFrom } from "./internal/discover";
import { start } from "./internal/start";

/** Everything `start` takes; `outbox` and `schedule` are opt-in, while `sockets` and `limits` are on unless set to false. */
export type StartOptions = {
    plugins: readonly Plugin[];

    /** Where the database is, or a store the project built itself. */
    database?: DatabaseOptions | Store | undefined;

    config?: Readonly<Record<string, unknown>> | undefined;

    /** Whether the kernel holds open sockets, and what claim keeps them apart. */
    sockets?: boolean | { claim: string } | undefined;

    /** Who is calling. */
    identify?: ((kernel: Kernel) => ServerOptions["identify"]) | undefined;
    http?: Omit<ServerOptions, "kernel" | "identify" | "log"> | undefined;

    /** How outbound calls are carried, or how the built-in one is configured. */
    httpClient?: HttpClientOptions | HttpClient | undefined;

    /** How a name becomes addresses for a plugin reaching "anywhere"; the platform's resolver when left out. */
    lookup?: Lookup | undefined;

    /** What counts requests against a route's declared limit. */
    rateLimiter?: RateLimiter | undefined;

    /** How many streams one caller may hold open at once; 4 when left out. */
    mostStreamsPerCaller?: number | undefined;

    /** How long `stop` waits for open streams to end with RESTARTING, in milliseconds; 5000 when left out. */
    streamDrainMs?: number | undefined;

    /** Holds every reply to the header allow-list now; 9.0 makes it the default. */
    strictReplyHeaders?: boolean | undefined;

    /** Whether anything counts them at all. */
    limits?: boolean | undefined;

    /** Whether events are kept until a listener has heard them. */
    outbox?: boolean | undefined;

    /**
     * Whether a plugin may ask for work later: true also runs what is due here, "enqueue" only stores it for a process
     * that runs it. Each claim is a lease renewed while the command runs; one that ran out is claimed again and counted.
     */
    schedule?: boolean | "enqueue" | undefined;

    /** How long a claimed job stays claimed without a renewal: 60000 when left out, 1000 to 3600000. */
    jobLeaseMs?: number | undefined;

    /** How long a scheduled command is held while it runs: ten leases when left out. */
    jobRunMs?: number | undefined;

    /** How long an outbox row stays with the process delivering it without a renewal, and how long a written row waits before another process may deliver it: 60000 when left out, 1000 to 3600000. */
    outboxLeaseMs?: number | undefined;

    log?: Logger | undefined;
};

/** What `start` answers: the running kernel and store, the Hono app and its `fetch`, `sockets` only when sockets were asked for, and `stop`, which stops the kernel and closes the database. */
export type StartedApp = {
    kernel: Kernel;
    store: Store;
    app: ReturnType<typeof import("../http/api").serve>;

    /** What a runtime serves: `export default { fetch }`. */
    fetch: (request: Request) => Response | Promise<Response>;

    /** What a socket joins, when `sockets` was asked for. */
    sockets: { subscribe: (identity: Identity | undefined, send: (text: string) => void) => Subscription } | undefined;

    stop: () => Promise<void>;
};

export { discover, discoverFrom, start };
export type { DiscoveryResult, PluginModules, SkippedFolder } from "./internal/discover";
