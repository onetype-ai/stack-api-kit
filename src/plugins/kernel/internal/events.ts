import type { Event, EmittedEvent } from "./contract";
import { KernelFault } from "./faults";

export type ListenerFailure = {
    event: string;
    plugin: string;
    error: unknown;
    at: number;
};

export type PendingDelivery = {
    /** Its own, so an outbox can mark exactly this one delivered. */
    id: string;

    plugin: string;
    name: string;
    payload: unknown;
};

type EventOwner = {
    owner: string;
    event: Event;
};

/** How many listener failures are remembered. */
const MOST_REMEMBERED = 100;

type EventHandler<Context> = {
    plugin: string;
    listener: EmittedEvent<Context>;
};

type EventReport = (plugin: string, line: string, about: Readonly<Record<string, unknown>>) => void;

export function events<Context>(now: () => number = Date.now, report: EventReport = () => {})
{
    const published = new Map<string, EventOwner>();
    const subscribers = new Map<string, EventHandler<Context>[]>();
    const failures: ListenerFailure[] = [];

    /** Records a listener that failed, and says so. */
    function record(event: string, plugin: string, error: unknown): void
    {
        failures.push({ event, plugin, error, at: now() });

        if (failures.length > MOST_REMEMBERED)
        {
            failures.splice(0, failures.length - MOST_REMEMBERED);
        }

        report(plugin, `listening to "${event}" failed`, {
            event,
            error: error instanceof Error ? error.message : String(error),
            ...(error instanceof Error && error.stack !== undefined && { stack: error.stack }),
        });
    }

    function checkDeclared(plugin: string, name: string, payload: unknown): unknown
    {
        const publisher = published.get(name);

        if (publisher === undefined)
        {
            throw new KernelFault("UNDECLARED_EVENT", `"${plugin}" emitted "${name}", which no plugin declares. Add it to emits.`, { plugin });
        }

        if (publisher.owner !== plugin)
        {
            throw new KernelFault("UNDECLARED_EVENT", `"${plugin}" emitted "${name}", which belongs to "${publisher.owner}". A plugin emits only what it owns.`, { plugin, detail: { owner: publisher.owner } });
        }

        const parsed = publisher.event.schema.safeParse(payload);

        if (!parsed.success)
        {
            throw new KernelFault("WRONG_PAYLOAD", `The payload for "${name}" does not match its schema: ${parsed.error.issues[0]?.message ?? "it was rejected"}.`, { plugin });
        }

        return parsed.data;
    }

    return {
        checkDeclared,

        declare: (owner: string, name: string, event: Event): void =>
        {
            published.set(name, { owner, event });
        },

        listen: (plugin: string, name: string, listener: EmittedEvent<Context>): void =>
        {
            subscribers.set(name, [...(subscribers.get(name) ?? []), { plugin, listener }]);
        },

        /** Calls every listener, and answers when they have all settled. */
        deliver: (plugin: string, name: string, payload: unknown, ctx: (plugin: string) => Context): Promise<boolean> =>
        {
            const deliveries: Promise<boolean>[] = [];

            for (const subscriber of subscribers.get(name) ?? [])
            {
                if (subscriber.plugin === plugin)
                {
                    continue;
                }

                try
                {
                    const handling = subscriber.listener.handle(payload as never, ctx(subscriber.plugin));

                    deliveries.push(Promise.resolve(handling).then(() => true, (error: unknown) =>
                    {
                        record(name, subscriber.plugin, error);

                        return false;
                    }));
                }
                catch (error)
                {
                    record(name, subscriber.plugin, error);

                    deliveries.push(Promise.resolve(false));
                }
            }

            return Promise.all(deliveries).then((all) => all.every(Boolean));
        },

        failures: (): readonly ListenerFailure[] =>
        {
            return [...failures];
        },
    };
}
