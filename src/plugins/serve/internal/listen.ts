import { serve, upgradeWebSocket } from "@hono/node-server";
import { Hono } from "hono";
import { WebSocketServer } from "ws";

import { handleSocketMessage } from "./socket";

import type { WebSocketServerLike } from "@hono/node-server";
import type { StartedApp } from "../../mount/api";

/** What `serve` answers: the listening server, for closing later. */
export type Listening = ReturnType<typeof serve>;

/** Puts a started kernel on a port, serving `/ws` where it carries a socket and `api.fetch` everywhere else. */
export function listen(api: StartedApp, port: number): Listening
{
    const sockets = api.sockets;

    if (sockets === undefined)
    {
        return serve({ fetch: api.fetch, port });
    }

    const app = new Hono();

    app.get("/ws", upgradeWebSocket(() =>
    {
        let subscription: ReturnType<typeof sockets.subscribe> | undefined;

        return {
            onOpen: (_event, socket) =>
            {
                subscription = sockets.subscribe(undefined, (text: string) =>
                {
                    socket.send(text);
                });
            },

            onMessage: (event, socket) =>
            {
                const payload = (event as { data?: unknown }).data;

                void handleSocketMessage(api, subscription, String(payload), (text: string) =>
                {
                    socket.send(text);
                });
            },

            onClose: () =>
            {
                subscription?.close();
            },
        };
    }));

    app.all("*", (c) => api.fetch(c.req.raw));

    return serve({
        fetch: app.fetch,
        port,
        websocket: { server: new WebSocketServer({ noServer: true }) as unknown as WebSocketServerLike },
    });
}
