import type { Declared, Identity, Pushed } from "../../kernel/api";

/** One open connection, as whoever holds the wire sees it. */
export type Joined = {
    /** Whether this connection may hear a channel at all. */
    hears: (channel: string) => boolean;

    /** What the client said it listens to. Refused when it may not. */
    listen: (channel: string) => boolean;

    forget: (channel: string) => void;

    /** The connection closed: it hears nothing more. */
    left: () => void;
};

type Connection = {
    who: Identity | undefined;
    send: (text: string) => void;
    listening: Set<string>;
};

/**
 * Every open connection, and how far what a plugin pushes travels.
 *
 * The kernel decides nothing about wires: it hands this what was pushed, and
 * this decides who is close enough to hear it. What holds the wire calls
 * `joined` once per connection and speaks to it through what comes back.
 */
export function sockets(kernel: { channels: () => readonly Declared[] }, claim?: string)
{
    const open = new Set<Connection>();

    let declared: Map<string, Declared> | undefined;

    // Read on first use, not here: a kernel is built holding this, so what it
    // declares is not knowable until it has started.
    const channelFor = (name: string): Declared | undefined =>
    {
        declared ??= new Map(kernel.channels().map((one) => [one.channel, one]));

        return declared.get(name);
    };

    const within = (who: Identity | undefined): string | undefined =>
    {
        const held = claim === undefined ? undefined : who?.claims[claim];

        return typeof held === "string" ? held : undefined;
    };

    const mayHear = (channel: string, who: Identity | undefined): boolean =>
    {
        const one = channelFor(channel);

        if (one === undefined)
        {
            return false;
        }

        // A channel nobody signed in may hear says so; every other reach
        // needs somebody to be reaching.
        if (one.reach !== "everyone" && who === undefined)
        {
            return false;
        }

        if (one.reach === "scope" && within(who) === undefined)
        {
            return false;
        }

        return one.requires.every((permission) => who?.permissions.includes(permission) === true);
    };

    const reaches = (sending: Pushed, listener: Connection): boolean =>
    {
        if (!listener.listening.has(sending.channel))
        {
            return false;
        }

        if (sending.reach === "scope")
        {
            return within(listener.who) === sending.within;
        }

        if (sending.reach === "viewer" || sending.reach === "connection")
        {
            return listener.who?.id === sending.from?.id;
        }

        return true;
    };

    return {
        push: (sending: Pushed): void =>
        {
            const text = JSON.stringify({ channel: sending.channel, body: sending.message });

            for (const listener of open)
            {
                if (reaches(sending, listener) && mayHear(sending.channel, listener.who))
                {
                    listener.send(text);
                }
            }
        },

        joined: (who: Identity | undefined, send: (text: string) => void): Joined =>
        {
            const connection: Connection = { who, send, listening: new Set() };

            open.add(connection);

            return {
                hears: (channel: string) => mayHear(channel, who),

                listen: (channel: string): boolean =>
                {
                    if (!mayHear(channel, who))
                    {
                        return false;
                    }

                    connection.listening.add(channel);

                    return true;
                },

                forget: (channel: string) => connection.listening.delete(channel),

                left: () => open.delete(connection),
            };
        },
    };
}
