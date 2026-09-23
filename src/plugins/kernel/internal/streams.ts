import type { Context, Route } from "./contract";
import { logRecord } from "./logRecord";
import { pruneRecords } from "./records";
import { refusalBodyFor, ServerEvent, type EventsReply, type Reply } from "./refusal";
import { isKitHeader, SHARED_CACHE } from "./replyHeaders";

type RequestLog = (level: "debug" | "info" | "warn" | "error", plugin: string, line: string, about?: Readonly<Record<string, unknown>>) => void;

/** How a stream ended that its handler did not end. GONE is the caller leaving, and nobody is there to tell. */
export type StreamEnding = "EXPIRED" | "RESTARTING" | "GONE";

/** What a caller reads when a stream ends under it: either way, it reconnects. */
const ENDINGS: Readonly<Record<Exclude<StreamEnding, "GONE">, string>> = {
    EXPIRED: "The stream reached its time limit. Reconnect to continue.",
    RESTARTING: "The service is restarting. Reconnect shortly.",
};

/** How long one stream lives when its route names nothing. */
export const STREAM_SECONDS = 300;

/** One open stream: counted against its caller, ended by its lifetime, by the kernel stopping, or by the caller leaving. */
export type OpenStream = {
    /** Aborts on any of those, which is what `ctx.signal` is. */
    signal: AbortSignal;
    ended: Promise<StreamEnding>;
    end: (ending: StreamEnding) => void;
    release: () => void;
};

/** Every open stream, and how many one caller holds. */
export type StreamRegistry = {
    perCaller: Map<string, number>;
    active: Set<OpenStream>;
    most: number;
};

/** A raw data line, written as given rather than as JSON: what some clients read as the end of a stream. */
export class RawFrame
{
    readonly raw: string;

    constructor(raw: string)
    {
        this.raw = raw;
    }
}

/** Takes a stream slot for a caller, which the stream gives back however it ends. */
export function openStream(registry: StreamRegistry, caller: string, callerSignal: AbortSignal | undefined, seconds: number): OpenStream
{
    const stopper = new AbortController();

    let ending: (code: StreamEnding) => void = () => undefined;

    const ended = new Promise<StreamEnding>((resolve) =>
    {
        ending = resolve;
    });

    const end = (code: StreamEnding): void =>
    {
        ending(code);
        stopper.abort();
    };

    const lifetime = setTimeout(() =>
    {
        end("EXPIRED");
    }, seconds * 1000);

    lifetime.unref?.();

    callerSignal?.addEventListener("abort", () =>
    {
        end("GONE");
    }, { once: true });

    registry.perCaller.set(caller, (registry.perCaller.get(caller) ?? 0) + 1);

    let released = false;

    const handle: OpenStream = {
        signal: callerSignal === undefined ? stopper.signal : AbortSignal.any([stopper.signal, callerSignal]),
        ended,
        end,

        release: () =>
        {
            if (released)
            {
                return;
            }

            released = true;
            clearTimeout(lifetime);
            stopper.abort();
            registry.active.delete(handle);

            const left = (registry.perCaller.get(caller) ?? 1) - 1;

            if (left <= 0)
            {
                registry.perCaller.delete(caller);
            }
            else
            {
                registry.perCaller.set(caller, left);
            }
        },
    };

    registry.active.add(handle);

    return handle;
}

/** What a `Reply.events` carries that the route did not declare, or undefined when it holds. */
export function eventsRefusal(route: Route<Context>, reply: Reply & { events: EventsReply }): string | undefined
{
    for (const [name, value] of Object.entries(reply.headers))
    {
        if (!(route.sends ?? []).includes(name) || isKitHeader(name))
        {
            return `sent header "${name}", which the route does not declare in sends`;
        }

        if (typeof value !== "string" || value.length > 256 || !/^[\x20-\x7e]*$/u.test(value))
        {
            return `sent header "${name}" with a value that is not up to 256 printable characters`;
        }

        if (name === "cache-control" && route.public !== true && SHARED_CACHE.test(value))
        {
            return "let a shared cache keep a stream only its caller may see";
        }
    }

    const end = reply.events.end;

    if (end !== undefined && (typeof end !== "string" || end.length === 0 || end.length > 64 || !/^[\x20-\x7e]+$/u.test(end)))
    {
        return "ended its events with a last frame that is not 1 to 64 printable characters on one line";
    }

    if (reply.events.error !== undefined && typeof reply.events.error !== "function")
    {
        return "gave an error frame that is not a function";
    }

    return undefined;
}

/**
 * The events a handler answered, each parsed by the route's `streams` schema.
 *
 * Everything before the first event was answered as any route answers. After it a
 * failure can no longer change the status, so it ends the stream with an error frame
 * carrying what a caller may know, and the cause goes to the log.
 */
export async function* streamedEvents(
    source: Iterable<unknown> | AsyncIterable<unknown>,
    route: Route<Context> & { streams: NonNullable<Route<Context>["streams"]> },
    plugin: string,
    log: RequestLog,
    stream: OpenStream | undefined,
    shaping: EventsReply | undefined,
): AsyncGenerator<ServerEvent | RawFrame>
{
    const failed = (body: { code: string; message: string }): ServerEvent =>
    {
        if (shaping?.error === undefined)
        {
            return new ServerEvent(body, { event: "error" });
        }

        try
        {
            const shaped = shaping.error(body.message);

            if (JSON.stringify(shaped) === undefined)
            {
                throw new TypeError("The error frame is not JSON.");
            }

            return new ServerEvent(shaped);
        }
        catch
        {
            // a route that shapes its errors has clients reading data-only frames: the neutral body stays one
            return new ServerEvent(body);
        }
    };

    const iterator = Symbol.asyncIterator in source ? source[Symbol.asyncIterator]() : source[Symbol.iterator]();
    const ended = stream?.ended.then((code) => ({ ended: code })) ?? new Promise<never>(() => undefined);

    try
    {
        for (;;)
        {
            const next = await Promise.race([Promise.resolve(iterator.next()), ended]);

            if ("ended" in next)
            {
                if (next.ended !== "GONE")
                {
                    yield failed({ code: next.ended, message: ENDINGS[next.ended] });
                }

                return;
            }

            if (next.done === true)
            {
                if (shaping?.end !== undefined)
                {
                    yield new RawFrame(shaping.end);
                }

                return;
            }

            const item: unknown = next.value;
            const event = item instanceof ServerEvent ? item : new ServerEvent(item);
            const framed = [event.event, event.id].every((field) => field === undefined || (typeof field === "string" && !/[\r\n]/u.test(field)));
            const filtered = route.streams.safeParse(pruneRecords(route.streams, event.data));

            if (!framed || !filtered.success)
            {
                log("error", plugin, `${route.method} ${route.path} streamed what its streams schema refuses`, {
                    issues: filtered.success ? ["event or id holds a line break"] : filtered.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
                });

                yield failed({ code: "INTERNAL", message: "The request could not be completed." });

                return;
            }

            yield new ServerEvent(filtered.data, { ...(event.event !== undefined && { event: event.event }), ...(event.id !== undefined && { id: event.id }) });
        }
    }
    catch (cause)
    {
        const refusal = refusalBodyFor(cause);

        if (refusal.status >= 500)
        {
            log("error", plugin, `${route.method} ${route.path} threw while streaming`, logRecord(cause));
        }
        else
        {
            log("warn", plugin, `${route.method} ${route.path} refused ${String(refusal.status)} while streaming`, { code: refusal.code });
        }

        yield failed({ code: refusal.code, message: refusal.message });
    }
    finally
    {
        stream?.release();

        // not awaited: a generator suspended inside its own await finishes that first, and ctx.signal, already aborted, is what tells it to
        void Promise.resolve(iterator.return?.()).catch(() => undefined);
    }
}
