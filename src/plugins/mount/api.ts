import type { DatabaseOptions, Store } from "../database/api";
import type { ServerOptions } from "../http/api";
import type { Budget, Dialer, Kernel, Logger, Plugin } from "../kernel/api";
import type { DialerOptions } from "../outbound/api";
import { discover } from "./internal/discover";
import { start } from "./internal/start";

export type StartOptions = {
    plugins: readonly Plugin[];

    /**
     * Where the database is, or a store the project built itself.
     *
     * Given a path, the kit opens SQLite and migrates. Given a store, it uses
     * that one and migrates only if it can: a project running Postgres, or
     * anything else answering `Store`, replaces the database without the kit
     * knowing which one it got.
     */
    database: DatabaseOptions | Store;

    config?: Readonly<Record<string, unknown>> | undefined;

    /**
     * Who is calling.
     *
     * Given the kernel, because anything reading a session reads it from a
     * plugin, and the kernel is what reaches one. Passing the function
     * directly would mean holding a kernel that does not exist yet.
     */
    identify?: ((kernel: Kernel) => ServerOptions["identify"]) | undefined;
    http?: Omit<ServerOptions, "kernel" | "identify" | "log"> | undefined;

    /**
     * How outbound calls are carried, or how the built-in one is configured.
     *
     * A dialler of its own is how a project reaches what the kit's cannot: a
     * proxy, a signed request, a protocol that is not https. The kernel still
     * refuses a host the plugin did not declare, whichever dialler carries it.
     */
    outbound?: DialerOptions | Dialer | undefined;

    /**
     * What counts requests against a route's declared limit.
     *
     * Omitted, the kit keeps one in memory, which counts for this process
     * only. A deployment behind more than one process passes its own, so a
     * limit means the same thing whichever process answered.
     */
    budget?: Budget | undefined;

    /**
     * Whether events are kept until a listener has heard them.
     *
     * Off by default, and that is a real choice rather than a default nobody
     * revisits: without it an event lives only in memory, so a process that
     * stops between a commit and its delivery leaves work done that nothing
     * was ever told about. On, delivery is at least once and a listener that
     * writes must survive hearing the same event twice.
     */
    outbox?: boolean | undefined;

    /**
     * Whether a plugin may ask for work later.
     *
     * Off by default. On, the kit keeps a schedule in the same database and
     * asks it every second what is due. It knows seconds from now and nothing
     * about calendars: work that repeats schedules itself again when it ends.
     */
    schedule?: boolean | undefined;

    log?: Logger | undefined;
};

export type RunningApp = {
    kernel: Kernel;
    store: Store;
    app: ReturnType<typeof import("../http/api").serve>;

    /** What a runtime serves: `export default { fetch }`. */
    fetch: (request: Request) => Response | Promise<Response>;

    stop: () => Promise<void>;
};

export { discover, start };
