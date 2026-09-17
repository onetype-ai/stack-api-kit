import { closeOnSignal } from "./closing";
import { from } from "./from";
import { listen } from "./listen";
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
};

/** A started kernel, put on a port and taken off one cleanly. */
export const Server = {
    from,
    listen,
    watch,

    open: (api: StartedApp, options: OpenOptions): void =>
    {
        const { port, log } = options;
        const server = listen(api, port);

        if ((options.watchSeconds ?? 0) > 0)
        {
            watch(api, log, (options.watchSeconds ?? 0) * 1000);
        }

        log.info("listening", { port, routes: api.kernel.routes().length });

        closeOnSignal({
            server,
            api,
            log,
            exit: (code) =>
            {
                process.exit(code);
            },
            ...(options.stopTimeoutMs === undefined ? {} : { stopTimeoutMs: options.stopTimeoutMs }),
            ...(options.drainMs === undefined ? {} : { drainMs: options.drainMs }),
        });
    },
};
