import type { Event, EmittedEvent } from "./contract";
import { KernelFault } from "./faults";

export type Failure = {
    event: string;
    plugin: string;
    error: unknown;
    at: number;
};

export type Pending = {
    /** Its own, so an outbox can mark exactly this one delivered. */
    id: string;

    plugin: string;
    name: string;
    payload: unknown;
};

type Published = {
    owner: string;
    event: Event;
};

/**
 * How many listener failures are kept.
 *
 * Enough to see a pattern in what just broke, few enough that a listener
 * throwing on every event cannot exhaust the process.
 */
const KEPT = 100;

type Subscriber<Context> = {
    plugin: string;
    listener: EmittedEvent<Context>;
};

type Report = (plugin: string, line: string, about: Readonly<Record<string, unknown>>) => void;

export function events<Context>(now: () => number = Date.now, told: Report = () => {})
{
    const published = new Map<string, Published>();
    const subscribers = new Map<string, Subscriber<Context>[]>();
    const failures: Failure[] = [];

    /**
     * Records a listener that failed, and says so.
     *
     * Kept for a project to read, and logged as well: a failure only in a
     * list nobody polls is a failure nobody sees, and an event is the one
     * path where nothing is waiting to be told.
     *
     * Only the last few are kept. Each holds an Error, and an Error holds the
     * stack it was thrown from, so a listener failing on every event would
     * otherwise grow this list for as long as the process lives. The newest
     * are what a project reads; the oldest are what it has already seen.
     */
    function record(event: string, plugin: string, error: unknown): void
    {
        failures.push({ event, plugin, error, at: now() });

        if (failures.length > KEPT)
        {
            failures.splice(0, failures.length - KEPT);
        }

        told(plugin, `listening to "${event}" failed`, {
            event,
            error: error instanceof Error ? error.message : String(error),
            ...(error instanceof Error && error.stack !== undefined && { stack: error.stack }),
        });
    }

    function checked(plugin: string, name: string, payload: unknown): unknown
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
        checked,

        declare: (owner: string, name: string, event: Event): void =>
        {
            published.set(name, { owner, event });
        },

        listen: (plugin: string, name: string, listener: EmittedEvent<Context>): void =>
        {
            subscribers.set(name, [...(subscribers.get(name) ?? []), { plugin, listener }]);
        },

        // A listener that throws is recorded and reaches neither the emitter
        // nor the ones behind it: one plugin's bug is not another's failure.
        /**
         * Calls every listener, and answers when they have all settled.
         *
         * The emitter never waits on this: it returns void from `emit`, and
         * one plugin's slow listener is not another's slow request. What does
         * wait is an outbox, which cannot forget an event until something has
         * actually heard it.
         */
        // Answers whether every listener delivered it. An outbox may only forget an
        // event once one did, and a failure recorded but not reported would let
        // it forget one nobody delivered at all.
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

        failures: (): readonly Failure[] =>
        {
            return [...failures];
        },
    };
}
