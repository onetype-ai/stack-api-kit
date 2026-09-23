import type { RegisteredChannel, Identity, ChannelMessage } from "../../kernel/api";

/** One open connection, as whoever holds the wire sees it. */
export type Subscription = {
    /** This connection, told apart from every other one the same person has open. */
    id: string;

    /** Whether this connection may hear a channel at all. */
    mayHear: (channel: string) => boolean;

    /** What the client said it listens to. Refused when it may not. */
    listen: (channel: string) => boolean;

    /** What the client said it stopped listening to. */
    unlisten: (channel: string) => void;

    /** The connection closed: it hears nothing more. */
    close: () => void;

    /** The same socket's caller, identified again: what it may hear and whether it counts as present follow at once. */
    reidentify: (identity: Identity | undefined) => void;
};

type SocketState = {
    id: string;
    identity: Identity | undefined;
    send: (text: string) => void;
    listening: Set<string>;
};

/** Every open connection, and how far what a plugin pushes travels. */
/** One open socket as presence counts it: who, in which scope, holding what. */
export type Present = { id: string; scope: string; permissions: readonly string[] };

/** Every open connection, and how far what a plugin pushes travels; `changed` hears when who is present may have changed. */
export function sockets(kernel: { channels: () => readonly RegisteredChannel[] }, claim?: string, changed: () => void = () => undefined)
{
    const open = new Set<SocketState>();

    let declared: Map<string, RegisteredChannel> | undefined;

    const channelFor = (name: string): RegisteredChannel | undefined =>
    {
        declared ??= new Map(kernel.channels().map((channel) => [channel.channel, channel]));

        return declared.get(name);
    };

    const scopeOf = (identity: Identity | undefined): string | undefined =>
    {
        const claimed = claim === undefined ? undefined : identity?.claims[claim];

        return typeof claimed === "string" ? claimed : undefined;
    };

    const mayHear = (channel: string, identity: Identity | undefined): boolean =>
    {
        const declared = channelFor(channel);

        if (declared === undefined)
        {
            return false;
        }

        if (declared.reach !== "everyone" && identity === undefined)
        {
            return false;
        }

        if ((declared.reach === "scope" || declared.reach === "identity") && scopeOf(identity) === undefined)
        {
            return false;
        }

        if (declared.requires.length === 0)
        {
            return true;
        }

        // Array.isArray first: a string permissions field makes this
        // String.prototype.includes, and "hr.employee,hr.admin" then contains
        // "hr.admin". The HTTP path refuses that shape; this one must too.
        const granted = identity?.permissions;

        if (!Array.isArray(granted))
        {
            return false;
        }

        return declared.requires.every((permission) => granted.includes(permission));
    };

    const reaches = (message: ChannelMessage, listener: SocketState): boolean =>
    {
        if (!listener.listening.has(message.channel))
        {
            return false;
        }

        if (message.reach === "scope")
        {
            return scopeOf(listener.identity) === message.scope;
        }

        if (message.reach === "connection")
        {
            // the one socket that asked; without an id this read as "viewer"
            // and a per-tab secret went to every tab the person had open
            return message.fromConnection !== undefined && listener.id === message.fromConnection;
        }

        if (message.reach === "viewer")
        {
            return listener.identity?.id === message.from?.id;
        }

        if (message.reach === "identity")
        {
            return message.to !== undefined && listener.identity?.id === message.to && scopeOf(listener.identity) === message.scope;
        }

        return true;
    };

    return {
        push: (message: ChannelMessage): void =>
        {
            const text = JSON.stringify({ channel: message.channel, body: message.message });

            for (const listener of open)
            {
                if (reaches(message, listener) && mayHear(message.channel, listener.identity))
                {
                    listener.send(text);
                }
            }
        },

        /** This process's sockets as presence counts them: identified, inside a scope. */
        present: (): Present[] =>
        {
            const found: Present[] = [];

            for (const listener of open)
            {
                const scope = scopeOf(listener.identity);
                const granted = listener.identity?.permissions;

                if (listener.identity !== undefined && scope !== undefined)
                {
                    found.push({ id: listener.identity.id, scope, permissions: Array.isArray(granted) ? [...granted] : [] });
                }
            }

            return found;
        },

        connected: (scope: string, permission: string): readonly string[] =>
        {
            const ids = new Set<string>();

            for (const listener of open)
            {
                const granted = listener.identity?.permissions;

                if (listener.identity !== undefined && scopeOf(listener.identity) === scope && Array.isArray(granted) && granted.includes(permission))
                {
                    ids.add(listener.identity.id);
                }
            }

            return [...ids];
        },

        subscribe: (identity: Identity | undefined, send: (text: string) => void): Subscription =>
        {
            const connection: SocketState = { id: crypto.randomUUID(), identity, send, listening: new Set() };

            open.add(connection);
            changed();

            return {
                id: connection.id,

                mayHear: (channel: string) => mayHear(channel, connection.identity),

                listen: (channel: string): boolean =>
                {
                    if (!mayHear(channel, connection.identity))
                    {
                        return false;
                    }

                    connection.listening.add(channel);

                    return true;
                },

                unlisten: (channel: string) => connection.listening.delete(channel),

                close: () =>
                {
                    open.delete(connection);
                    changed();
                },

                // a channel it may no longer hear is dropped at once, rather than at its next listen
                reidentify: (next: Identity | undefined): void =>
                {
                    connection.identity = next;
                    changed();

                    for (const channel of [...connection.listening])
                    {
                        if (!mayHear(channel, next))
                        {
                            connection.listening.delete(channel);
                        }
                    }
                },
            };
        },
    };
}
