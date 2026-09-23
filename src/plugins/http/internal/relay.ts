import { z } from "zod";

import type { ChannelMessage, Logger, PubSub, Sockets } from "../../kernel/api";
import type { Present } from "./sockets";

/** How often a process tells the others who it holds, and how long silence means it is gone. */
const HEARTBEAT_MS = 10_000;
const SILENT_MS = 30_000;

/**
 * What crosses between processes for one push: everything the pusher decided, so the receiver only picks its sockets
 * by it and never works out a scope of its own. "connection" never crosses: that socket is in the pushing process.
 */
const Variant = z.object({ requires: z.array(z.string()), message: z.unknown() }).strict();

const common = { origin: z.string().min(1), channel: z.string().min(1), requires: z.array(z.string()), message: z.unknown(), variants: z.array(Variant).optional() };

// each reach carries exactly what it needs to pick its sockets: a frame short of it is refused, never read as a wider reach
const Envelope = z.discriminatedUnion("reach", [
    z.object({ ...common, reach: z.literal("scope"), scope: z.string().min(1) }).strict(),
    z.object({ ...common, reach: z.literal("identity"), scope: z.string().min(1), to: z.string().min(1) }).strict(),
    z.object({ ...common, reach: z.literal("viewer"), from: z.string().min(1) }).strict(),
    z.object({ ...common, reach: z.literal("everyone") }).strict(),
]);

const Snapshot = z.object({
    origin: z.string().min(1),
    present: z.array(z.object({ id: z.string(), scope: z.string(), permissions: z.array(z.string()) }).strict()),
}).strict();

/** A pub/sub within one process: what is published is heard at once, by this process alone. */
export function inProcessPubSub(): PubSub
{
    const topics = new Map<string, Set<(text: string) => void>>();

    return {
        publish: (topic, text) =>
        {
            for (const hear of [...(topics.get(topic) ?? [])])
            {
                hear(text);
            }
        },
        subscribe: (topic, hear) =>
        {
            const heard = topics.get(topic) ?? new Set();

            heard.add(hear);
            topics.set(topic, heard);

            return () =>
            {
                heard.delete(hear);
            };
        },
        close: () => Promise.resolve(),
    };
}

type Hub = Sockets & { present: () => Present[] };

/** The envelope a push crosses in: exactly what its reach needs, or none when it reaches nobody elsewhere. */
function envelopeOf(message: ChannelMessage, origin = ""): Record<string, unknown> | undefined
{
    const base = {
        origin,
        channel: message.channel,
        requires: message.requires,
        message: message.message,
        ...(message.variants === undefined ? {} : { variants: message.variants.map((variant) => ({ requires: variant.requires, message: variant.message })) }),
    };

    switch (message.reach)
    {
        case "scope":
            return message.scope === undefined ? undefined : { ...base, reach: "scope", scope: message.scope };
        case "identity":
            return message.scope === undefined || message.to === undefined ? undefined : { ...base, reach: "identity", scope: message.scope, to: message.to };
        case "viewer":
            return message.from === undefined ? undefined : { ...base, reach: "viewer", from: message.from.id };
        case "everyone":
            return { ...base, reach: "everyone" };
        default:
            return undefined;
    }
}

/**
 * The sockets of every process serving one application, as the kernel sees them. A push reaches this process's
 * sockets at once and crosses to the others on `kit.push`; presence is this process's sockets and a mirror of the
 * others', each refreshed by a heartbeat and forgotten after a silence. A frame that is not what the kit sends is
 * dropped and logged once, without its text: anyone reaching the transport could write one.
 */
export function relay(hub: Hub, pubsub: PubSub, log?: Logger)
{
    const origin = crypto.randomUUID();
    const mirror = new Map<string, { at: number; present: readonly Present[] }>();
    let warned = false;

    const dropped = (): void =>
    {
        if (!warned)
        {
            warned = true;
            log?.warn("sockets: a frame from another process was not what the kit sends, and was dropped");
        }
    };

    const read = <Shape>(schema: z.ZodType<Shape>, text: string): Shape | undefined =>
    {
        try
        {
            const parsed = schema.safeParse(JSON.parse(text));

            if (parsed.success)
            {
                return parsed.data;
            }
        }
        catch
        {
        }

        dropped();

        return undefined;
    };

    const tell = (): void =>
    {
        pubsub.publish("kit.presence", JSON.stringify({ origin, present: hub.present() }));
    };

    const stopPushes = pubsub.subscribe("kit.push", (text) =>
    {
        const heard = read(Envelope, text);

        if (heard === undefined || heard.origin === origin)
        {
            return;
        }

        hub.push({
            channel: heard.channel,
            message: heard.message,
            reach: heard.reach,
            requires: heard.requires,
            ...(heard.variants === undefined ? {} : { variants: heard.variants }),
            scope: "scope" in heard ? heard.scope : undefined,
            to: "to" in heard ? heard.to : undefined,
            from: "from" in heard ? { id: heard.from, permissions: [], claims: {} } : undefined,
            fromConnection: undefined,
        });
    });

    const stopPresence = pubsub.subscribe("kit.presence", (text) =>
    {
        const heard = read(Snapshot, text);

        if (heard !== undefined && heard.origin !== origin)
        {
            mirror.set(heard.origin, { at: Date.now(), present: heard.present });
        }
    });

    const beating = setInterval(tell, HEARTBEAT_MS);

    beating.unref();

    return {
        origin,

        /** What changes in this process's sockets is told at once, so the others need not wait for the heartbeat. */
        changed: tell,

        push: (message: ChannelMessage): void =>
        {
            hub.push(message);

            if (message.reach === "connection")
            {
                return;
            }

            const envelope = envelopeOf(message, origin);

            if (envelope !== undefined)
            {
                pubsub.publish("kit.push", JSON.stringify(envelope));
            }
        },

        connected: (scope: string, permission: string): readonly string[] =>
        {
            const ids = new Set(hub.connected?.(scope, permission) ?? []);
            const now = Date.now();

            for (const [from, told] of mirror)
            {
                if (now - told.at > SILENT_MS)
                {
                    mirror.delete(from);
                    continue;
                }

                for (const one of told.present)
                {
                    if (one.scope === scope && one.permissions.includes(permission))
                    {
                        ids.add(one.id);
                    }
                }
            }

            return [...ids];
        },

        stop: (): void =>
        {
            clearInterval(beating);
            stopPushes();
            stopPresence();
        },
    };
}
