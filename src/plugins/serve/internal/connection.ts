import type { WSContext, WSEvents } from "hono/ws";

import type { Subscription } from "../../http/api";
import type { Identity } from "../../kernel/api";
import type { StartedApp } from "../../mount/api";

import { handleSocketMessage } from "./socket";

/** Close codes a client acts on; 4000-4999 is the range RFC 6455 leaves to applications. */
export const CLOSE = {
    /** The socket reached its lifetime: redial at once. */
    LIFETIME: 4000,

    /** Its caller is no longer identified: wait until asked to reconnect. */
    SIGNED_OUT: 4001,

    /** Its origin may not carry a session cookie here: never redial. */
    FORBIDDEN: 4003,

    /** The server is restarting: redial after a jittered wait. */
    RESTARTING: 1012,

    /** The caller holds too many sockets: wait out the `$backoff` sent before. */
    OVERLOADED: 1013,
} as const;

/** How long a socket lives, how often its caller is identified again and told it is alive, and how many one caller may hold. */
export type SocketLimits = {
    lifetimeMs: number;
    reidentifyMs: number;
    pingMs: number;
    mostSocketsPerCaller: number;
    backoffMs: number;
};

/** What the upgrade decided about one socket before it opened. */
export type Upgraded = {
    identity: Identity | undefined;
    address: string | undefined;

    /** Why the socket may not stay, when its origin refused it; it opens only to be told. */
    refused: boolean;

    /** The upgrade request, kept to identify the caller again. */
    again: Request | undefined;
};

/** Every open socket, and how many each caller holds. */
export type OpenSockets = {
    all: Set<{ close: (code: number, reason: string) => void }>;
    perCaller: Map<string, number>;
};

/** The protocol-level ping a Node socket answers, where the adapter exposes it. */
type Pinging = { ping?: () => void; on?: (event: "pong", listener: () => void) => void; terminate?: () => void };

/**
 * One socket's life: it hears what its identity may hear, asks as that identity, is identified
 * again while it lives so a revoked credential stops hearing, and ends at its lifetime.
 */
export function socketEvents(api: StartedApp, upgraded: Upgraded, open: OpenSockets, limits: SocketLimits, log: (level: "info" | "warn" | "error", line: string, about?: Readonly<Record<string, unknown>>) => void): WSEvents
{
    const identify = api.kernel.identify;
    const caller = upgraded.identity?.id ?? upgraded.address ?? "anonymous";
    const closing = new AbortController();

    let identity = upgraded.identity;
    let subscription: Subscription | undefined;
    let timers: ReturnType<typeof setInterval>[] = [];
    let counted = false;
    let closer: { close: (code: number, reason: string) => void } | undefined;

    // false once the credential behind the socket is gone, and the socket closed
    const refresh = async (socket: WSContext): Promise<boolean> =>
    {
        if (upgraded.again === undefined || identify === undefined)
        {
            return true;
        }

        identity = await identify(upgraded.again);

        if (identity === undefined)
        {
            socket.close(CLOSE.SIGNED_OUT, "Signed out. Reconnect when signed in.");

            return false;
        }

        subscription?.reidentify(identity);

        return true;
    };

    return {
        onOpen: (_event, socket) =>
        {
            if (upgraded.refused)
            {
                socket.close(CLOSE.FORBIDDEN, "This origin may not open a socket with a session cookie.");

                return;
            }

            if ((open.perCaller.get(caller) ?? 0) >= limits.mostSocketsPerCaller)
            {
                socket.send(JSON.stringify({ channel: "$backoff", ms: limits.backoffMs }));
                socket.close(CLOSE.OVERLOADED, "Too many sockets. Wait, then reconnect.");

                return;
            }

            counted = true;
            open.perCaller.set(caller, (open.perCaller.get(caller) ?? 0) + 1);
            closer = { close: (code, reason) => socket.close(code, reason) };
            open.all.add(closer);

            subscription = api.sockets?.subscribe(identity, (text) =>
            {
                socket.send(text);
            });

            socket.send(JSON.stringify({ channel: "$ready", connection: subscription?.id }));

            // the protocol ping finds a dead peer; the $ping frame is what a browser, which never sees protocol pings, can count
            const raw = socket.raw as Pinging | undefined;
            let alive = true;

            raw?.on?.("pong", () =>
            {
                alive = true;
            });

            const lifetime = setTimeout(() => socket.close(CLOSE.LIFETIME, "Lifetime reached. Reconnect."), limits.lifetimeMs);

            const beat = setInterval(() =>
            {
                if (!alive)
                {
                    raw?.terminate?.();

                    return;
                }

                alive = raw?.ping === undefined;
                raw?.ping?.();
                socket.send(JSON.stringify({ channel: "$ping" }));
            }, limits.pingMs);

            const recheck = setInterval(() =>
            {
                refresh(socket).catch((cause: unknown) =>
                {
                    log("error", "a socket could not be identified again", { error: cause instanceof Error ? cause.message : String(cause) });
                });
            }, limits.reidentifyMs);

            for (const timer of [lifetime, beat, recheck])
            {
                timer.unref?.();
            }

            timers = [lifetime, beat, recheck];
        },

        onMessage: (event, socket) =>
        {
            const text = String((event as { data?: unknown }).data);

            void (async (): Promise<void> =>
            {
                // who the socket is now decides what it may start hearing or asking, not who it was at the last check
                if (!await refresh(socket))
                {
                    return;
                }

                await handleSocketMessage(api, subscription, text, (answer) =>
                {
                    socket.send(answer);
                }, { identity, address: upgraded.address, signal: closing.signal });
            })().catch((cause: unknown) =>
            {
                log("error", "a socket frame failed", { error: cause instanceof Error ? cause.message : String(cause) });
            });
        },

        onClose: () =>
        {
            closing.abort();
            timers.forEach((timer) => clearTimeout(timer));
            subscription?.close();

            if (closer !== undefined)
            {
                open.all.delete(closer);
            }

            if (counted)
            {
                const left = (open.perCaller.get(caller) ?? 1) - 1;

                if (left <= 0)
                {
                    open.perCaller.delete(caller);
                }
                else
                {
                    open.perCaller.set(caller, left);
                }
            }
        },
    };
}
