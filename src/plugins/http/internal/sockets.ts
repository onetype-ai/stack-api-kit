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
};

type SocketState = {
    id: string;
    identity: Identity | undefined;
    send: (text: string) => void;
    listening: Set<string>;
};

/** Every open connection, and how far what a plugin pushes travels. */
export function sockets(kernel: { channels: () => readonly RegisteredChannel[] }, claim?: string)
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

        if (declared.reach === "scope" && scopeOf(identity) === undefined)
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

        subscribe: (identity: Identity | undefined, send: (text: string) => void): Subscription =>
        {
            const connection: SocketState = { id: crypto.randomUUID(), identity, send, listening: new Set() };

            open.add(connection);

            return {
                id: connection.id,

                mayHear: (channel: string) => mayHear(channel, identity),

                listen: (channel: string): boolean =>
                {
                    if (!mayHear(channel, identity))
                    {
                        return false;
                    }

                    connection.listening.add(channel);

                    return true;
                },

                unlisten: (channel: string) => connection.listening.delete(channel),

                close: () => open.delete(connection),
            };
        },
    };
}
