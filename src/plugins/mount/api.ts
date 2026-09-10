import type { DatabaseOptions, Store } from "../database/api";
import type { Subscription, ServerOptions } from "../http/api";
import type { RateLimiter, HttpClient, Identity, Kernel, Logger, Plugin } from "../kernel/api";
import type { HttpClientOptions } from "../outbound/api";
import { discover, discoverFrom } from "./internal/discover";
import { start } from "./internal/start";

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

    /** What counts requests against a route's declared limit. */
    rateLimiter?: RateLimiter | undefined;

    /** Whether anything counts them at all. */
    limits?: boolean | undefined;

    /** Whether events are kept until a listener has heard them. */
    outbox?: boolean | undefined;

    /** Whether a plugin may ask for work later. */
    schedule?: boolean | undefined;

    log?: Logger | undefined;
};

export type RunningApp = {
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
export type { DiscoveryResult, SkippedFolder } from "./internal/discover";
