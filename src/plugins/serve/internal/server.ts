import { closeOnce, closeOnSignal } from "./closing";
import { from, type Trusting } from "./from";
import { listen, socketsOf, type SocketOptions } from "./listen";
import { watch } from "./watch";

import type { Logger } from "../../kernel/api";
import type { StartedApp } from "../../mount/api";

/** What putting a kernel on a port takes. */
export type OpenOptions = {
    port: number;
    log: Logger;

    /** Gone in 9.0 (`true` trusted a hop the caller writes, and is refused): name `trustedProxies` instead. */
    behindProxy?: false;

    /** The proxies in front, as addresses or ranges: a socket's caller is the rightmost hop none of them wrote, as `Server.from` reads it. */
    trustedProxies?: readonly string[];

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

    /** A stop that runs once, closing every socket 1012 first, for a caller stopping without a signal. */
    closeOnce,

    /** The sockets a listening server holds, for `closeOnce` to close. */
    socketsOf,

    open: (api: StartedApp, options: OpenOptions): void =>
    {
        const { port, log } = options;
        const server = listen(api, port, { ...options.sockets, from: from(options.trustedProxies === undefined ? (options.behindProxy as Trusting | undefined) ?? false : { trustedProxies: options.trustedProxies }), log: (level, line, about) => log[level](line, about) });

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
