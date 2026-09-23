import { serve, upgradeWebSocket } from "@hono/node-server";
import { Hono } from "hono";
import { WebSocketServer } from "ws";

import { socketEvents, type OpenSockets, type SocketLimits, type Upgraded } from "./connection";

import type { WebSocketServerLike } from "@hono/node-server";
import type { HeaderCarrier } from "./from";
import type { StartedApp } from "../../mount/api";

/** What `serve` answers: the listening server, for closing later. */
export type Listening = ReturnType<typeof serve>;

/** How the socket at `/ws` is held; each has a default a browser client is written against. */
export type SocketOptions = Partial<SocketLimits> & {
    /** Where a line goes. */
    log?: (level: "info" | "warn" | "error", line: string, about?: Readonly<Record<string, unknown>>) => void;

    /** Who a socket's caller is counted as, where the http side names no `from`. */
    from?: ((c: HeaderCarrier) => string) | undefined;
};

const DEFAULTS: SocketLimits = {
    lifetimeMs: 15 * 60_000,
    reidentifyMs: 30_000,
    pingMs: 25_000,
    mostSocketsPerCaller: 16,
    backoffMs: 5_000,
};

/** The sockets a listening server holds, so a stop can tell each one it is restarting. */
const held = new WeakMap<Listening, OpenSockets>();

/** Every open socket a server holds, for a stop to close. */
export function socketsOf(server: Listening): OpenSockets | undefined
{
    return held.get(server);
}

/**
 * Puts a started kernel on a port, serving `/ws` where it carries a socket and `api.fetch` everywhere else.
 *
 * The upgrade is identified as an HTTP request would be, by the plugin declaring `identifies`, the session
 * cookie read as the http side reads it. A cookie rides along with any page that opens a socket, so it proves
 * nothing about who opened it: an upgrade carrying one from an origin not allowed opens only to be closed
 * 4003. A frame is at most the http side's `bodyBytes`, and a larger one closes the socket 1009.
 */
export function listen(api: StartedApp, port: number, options: SocketOptions = {}): Listening
{
    const sockets = api.sockets;

    if (sockets === undefined)
    {
        return serve({ fetch: api.fetch, port });
    }

    const { log: _log, from: _from, ...given } = options;
    const limits: SocketLimits = { ...DEFAULTS, ...Object.fromEntries(Object.entries(given).filter(([, value]) => value !== undefined)) };
    const log = options.log ?? ((): void => undefined);
    const open: OpenSockets = { all: new Set(), perCaller: new Map() };
    const upgrades = new WeakMap<Request, Upgraded>();
    const app = new Hono();

    app.get("/ws", async (c, next) =>
    {
        const raw = c.req.raw;
        const ambient = api.served.session !== undefined && raw.headers.get("cookie")?.includes(`${api.served.session.name}=`) === true;
        const origin = raw.headers.get("origin");
        const refused = ambient && (origin === null || !api.served.origins.includes(origin));
        const address = (api.served.from ?? options.from)?.(c);

        if (refused)
        {
            log("warn", "socket refused: a session cookie from an origin not allowed", { origin: origin ?? "" });
        }

        const identity = refused ? undefined : await api.served.identify(c).catch(() => undefined);

        upgrades.set(raw, {
            identity,
            address,
            refused,
            again: identity === undefined ? undefined : c,
        });

        return next();
    }, upgradeWebSocket((c) =>
    {
        return socketEvents(api, upgrades.get(c.req.raw) ?? { identity: undefined, address: undefined, refused: false, again: undefined }, open, limits, log);
    }));

    app.all("*", (c) => api.fetch(c.req.raw));

    const server = serve({
        fetch: app.fetch,
        port,
        websocket: { server: new WebSocketServer({ noServer: true, maxPayload: api.served.bodyBytes }) as unknown as WebSocketServerLike },
    });

    held.set(server, open);

    return server;
}
