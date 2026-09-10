import type { RegisteredChannel, Identity, ChannelMessage } from "../../kernel/api";

/** One open connection, as whoever holds the wire sees it. */
export type Subscription = {
    /** Whether this connection may hear a channel at all. */
    isListening: (channel: string) => boolean;

    /** What the client said it listens to. Refused when it may not. */
    listenTo: (channel: string) => boolean;

    stopListening: (channel: string) => void;

    /** The connection closed: it hears nothing more. */
    close: () => void;
};

type SocketState = {
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
        declared ??= new Map(kernel.channels().map((one) => [one.channel, one]));

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

        return declared.requires.every((permission) => identity?.permissions.includes(permission) === true);
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

        if (message.reach === "viewer" || message.reach === "connection")
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
            const connection: SocketState = { identity, send, listening: new Set() };

            open.add(connection);

            return {
                isListening: (channel: string) => mayHear(channel, identity),

                listenTo: (channel: string): boolean =>
                {
                    if (!mayHear(channel, identity))
                    {
                        return false;
                    }

                    connection.listening.add(channel);

                    return true;
                },

                stopListening: (channel: string) => connection.listening.delete(channel),

                close: () => open.delete(connection),
            };
        },
    };
}
