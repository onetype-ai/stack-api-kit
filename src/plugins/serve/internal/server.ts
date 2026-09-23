import { closeOnSignal } from "./closing";
import { from } from "./from";
import { listen, socketsOf, type SocketOptions } from "./listen";
import { watch } from "./watch";

import type { Logger } from "../../kernel/api";
import type { StartedApp } from "../../mount/api";

/** What putting a kernel on a port takes. */
export type OpenOptions = {
    port: number;
    log: Logger;

    /** Whether something in front sets `x-forwarded-for`; without one, a caller writes their own address. */
    behindProxy?: boolean;

    /** How often to report listeners that failed; zero never looks. */
    watchSeconds?: number;
    stopTimeoutMs?: number;
    drainMs?: number;

    /** How the socket at `/ws` is held: its lifetime, how often it is identified again and pinged, how many one caller may hold. */
    sockets?: Omit<SocketOptions, "log" | "from">;
};

/** A started kernel, put on a port and taken off one cleanly. */
export const Server = {
    from,
    listen,
    watch,

    open: (api: StartedApp, options: OpenOptions): void =>
    {
        const { port, log } = options;
        const server = listen(api, port, { ...options.sockets, from: from(options.behindProxy ?? false), log: (level, line, about) => log[level](line, about) });

        if ((options.watchSeconds ?? 0) > 0)
        {
            watch(api, log, (options.watchSeconds ?? 0) * 1000);
        }

        log.info("listening", { port, routes: api.kernel.routes().length });

        closeOnSignal({
            server,
            api,
            log,
            sockets: socketsOf(server),
            exit: (code) =>
            {
                process.exit(code);
            },
            ...(options.stopTimeoutMs === undefined ? {} : { stopTimeoutMs: options.stopTimeoutMs }),
            ...(options.drainMs === undefined ? {} : { drainMs: options.drainMs }),
        });
    },
};
