import { refusalBodyFor, Reply, Refusal } from "./refusal";
import { documentAnswer, tagged } from "./document";
import { pruneRecords } from "./records";
import { fileAnswer } from "./file";
import { eventsRefusal, openStream, STREAM_SECONDS, streamedEvents, type OpenStream, type StreamRegistry } from "./streams";
import type { z } from "zod";

import type { Identity, Context, HttpMethod, Route } from "./contract";
import { KernelFault } from "./faults";
import { createPermissions } from "./permissions";
import { replyHeaders, type ReplyHeaderPolicy } from "./replyHeaders";
import { logRecord } from "./logRecord";

/** What decides whether one identity has any allowance left on one route. */
export type RateLimiter = {
    spend: (key: string, window: { requests: number; seconds: number }) => { allowed: boolean; resetsInSeconds: number };

    /** Gives one spend back, for a route counting only what it guards against. */
    refund?: (key: string) => void;
};

/** One request, as it reaches the kernel. */
export type KernelRequest = {
    method: HttpMethod;
    path: string;
    input: unknown;
    identity?: Identity | undefined;

    /** The request's headers, lowercase. A route sees only what it declared. */
    headers?: Readonly<Record<string, string>> | undefined;

    /** The body's bytes as they arrived, for a route that declared `keepsRaw`. */
    sent?: Uint8Array | undefined;

    /** Where it came from when nobody is signed in. Only a rate limit reads it. */
    from?: string | undefined;

    /** Aborts when the caller goes away; handed to the route as `ctx.signal`. */
    signal?: AbortSignal | undefined;

    /** The request's If-None-Match, which the kit answers itself: a GET whose ETag matches gets a 304. */
    ifNoneMatch?: string | undefined;
};

/** What the kernel answers: a status, and a body already safe to send. */
export type KernelResponse = {
    status: number;
    body: unknown;
    headers?: Readonly<Record<string, string>>;

    /** Whether a declared document answered, so the body is sent as HTML under its own policy. */
    document?: boolean;

    /** Whether a declared file answered, so the body (text, bytes or chunks) is sent as a download. */
    file?: boolean;
};

/** A route the kernel holds, and who declared it. */
export type RouteOwner = {
    plugin: string;
    route: Route<Context>;
};

type RequestLog = (
    level: "debug" | "info" | "warn" | "error",
    plugin: string,
    line: string,
    about?: Readonly<Record<string, unknown>>,
) => void;

/** Nothing found. Said the same way whoever asked, so probing learns nothing. */
export const unknownRoute: KernelResponse = {
    status: 404,
    body: { code: "NOT_FOUND", message: "No such route." },
};

/** The kernel has stopped. A retry elsewhere is the only useful answer. */
export const notServing: KernelResponse = {
    status: 503,
    body: { code: "NOT_SERVING", message: "The service is shutting down." },
};

/** Statuses HTTP sends without a body; one written into them fails on the wire. */
const EMPTY_STATUSES: ReadonlySet<number> = new Set([204, 205]);

/** Answers one request. */
export async function respond(
    mounted: RouteOwner,
    incoming: KernelRequest,
    context: (plugin: string, identity?: Identity, headers?: Readonly<Record<string, string>>, sent?: Uint8Array, signal?: AbortSignal) => Context,
    log: RequestLog,
    rateLimiter?: RateLimiter,
    streams?: StreamRegistry,
    headerPolicy: ReplyHeaderPolicy = { strict: true, warned: new Set() },
): Promise<KernelResponse>
{
    const { plugin, route } = mounted;
    const identity = incoming.identity;
    const permissions = createPermissions(() => identity);

    /* identify may be written in JavaScript, where the type does not hold: an
       id of "" is nobody, and every such one would share one rate-limit bucket.
       A non-string id crashed here rather than reading as nobody. */
    const identityId = typeof identity?.id === "string" && identity.id.trim() !== "" ? identity.id : undefined;

    let spent: string | undefined;
    let stream: OpenStream | undefined;

    try
    {
        if (route.public !== true && identityId === undefined)
        {
            throw new KernelFault("UNAUTHENTICATED", `${route.method} ${route.path} needs a caller.`, { plugin });
        }

        if (route.limit !== undefined && rateLimiter !== undefined)
        {
            spent = `${identityId ?? incoming.from ?? "anonymous"}:${route.method} ${route.path}`;

            const verdict = rateLimiter.spend(spent, route.limit);

            if (!verdict.allowed)
            {
                spent = undefined;

                // this path returns before the catch below, so without a line
                // here a brute-force run left nothing behind at all
                log("warn", plugin, `${route.method} ${route.path} refused 429`, { code: "RATE_LIMITED" });

                return {
                    status: 429,
                    body: { code: "RATE_LIMITED", message: "Too many requests. Try again shortly." },
                    headers: { "retry-after": String(verdict.resetsInSeconds) },
                };
            }
        }

        const lacking = (route.requires ?? []).filter((permission) => !permissions.has(permission));

        if (lacking.length > 0)
        {
            throw new KernelFault(
                "PERMISSION_DENIED",
                `${route.method} ${route.path} needs ${lacking.map((permission) => `"${permission}"`).join(", ")}.`,
                { plugin, detail: { lacking } },
            );
        }

        const parsed = route.input.safeParse(incoming.input);

        if (!parsed.success)
        {
            throw new Refusal(400, "INVALID_INPUT", "The request is not valid.", fieldErrors(parsed.error));
        }

        const sent = route.keepsRaw === true ? incoming.sent : undefined;

        // a route answering either way takes a stream slot only once its handle answered events, so a JSON
        // answer never counts against the caller's open streams; its handle gets a signal the stream joins later
        const answersEither = route.streams !== undefined && route.output !== undefined;
        const caller = identityId ?? incoming.from ?? "anonymous";
        const seconds = route.streamSeconds ?? STREAM_SECONDS;

        const tooManyStreams = (): KernelResponse =>
        {
            log("warn", plugin, `${route.method} ${route.path} refused 429: too many open streams`, { code: "TOO_MANY_STREAMS" });

            return { status: 429, body: { code: "TOO_MANY_STREAMS", message: "Too many open streams. Close one and try again." } };
        };

        if (route.streams !== undefined && streams !== undefined && !answersEither)
        {
            if ((streams.perCaller.get(caller) ?? 0) >= streams.most)
            {
                return tooManyStreams();
            }

            stream = openStream(streams, caller, incoming.signal, seconds);
        }

        const early = answersEither ? new AbortController() : undefined;
        const handed = early === undefined ? undefined : incoming.signal === undefined ? early.signal : AbortSignal.any([early.signal, incoming.signal]);

        const returned = await route.handle(parsed.data, context(plugin, identity, allowedHeaders(route, incoming.headers), sent, stream?.signal ?? handed ?? incoming.signal));

        const chosen = returned instanceof Reply && returned.events !== undefined ? returned as Reply & { events: NonNullable<Reply["events"]> } : undefined;
        const source: unknown = chosen?.events.source ?? returned;
        const iterable = source !== null && typeof source === "object" && (Symbol.asyncIterator in source || Symbol.iterator in source);

        // a route declaring output as well answers JSON whenever its handle did not answer events
        const answersJson = route.output !== undefined && chosen === undefined && !iterable;

        if (route.streams !== undefined && answersJson)
        {
            stream?.release();
        }

        if (route.streams !== undefined && !answersJson)
        {
            const refused = !iterable ? "answered something that is not an iterable of events" : chosen === undefined ? undefined : eventsRefusal(route, chosen);

            if (refused !== undefined)
            {
                stream?.release();
                log("error", plugin, `${route.method} ${route.path} streams, and its handle ${refused}`);

                return { status: 500, body: { code: "INTERNAL", message: "The request could not be completed." } };
            }

            if (answersEither && streams !== undefined)
            {
                if ((streams.perCaller.get(caller) ?? 0) >= streams.most)
                {
                    early?.abort();

                    return tooManyStreams();
                }

                stream = openStream(streams, caller, incoming.signal, seconds);
                stream.signal.addEventListener("abort", () => early?.abort(), { once: true });
            }

            if (spent !== undefined && route.limit?.countSuccess === false)
            {
                rateLimiter?.refund?.(spent);
            }

            return {
                status: 200,
                body: streamedEvents(source as Iterable<unknown> | AsyncIterable<unknown>, route as Route<Context> & { streams: z.ZodType }, plugin, log, stream, chosen?.events),
                headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no", ...chosen?.headers },
            };
        }

        if (route.document !== undefined)
        {
            return documentAnswer(returned, route as Route<Context> & { document: NonNullable<Route<Context>["document"]> }, plugin, log, incoming);
        }

        if (route.file !== undefined)
        {
            return fileAnswer(returned, route as Route<Context> & { file: NonNullable<Route<Context>["file"]> }, plugin, log, incoming);
        }

        const reply = returned instanceof Reply ? returned : undefined;

        if (reply?.document !== undefined || reply?.file !== undefined)
        {
            const kind = reply.document !== undefined ? "document" : "file";

            log("error", plugin, `${route.method} ${route.path} answered a ${kind}, and declares no ${kind}`);

            return { status: 500, body: { code: "INTERNAL", message: "The request could not be completed." } };
        }

        if (route.output === undefined)
        {
            log("error", plugin, `${route.method} ${route.path} answered, and declares nothing to answer with`);

            return { status: 500, body: { code: "INTERNAL", message: "The request could not be completed." } };
        }

        const filtered = route.output.safeParse(pruneRecords(route.output, reply === undefined ? returned : reply.body));

        if (!filtered.success)
        {
            log("error", plugin, `${route.method} ${route.path} returned what its output schema refuses`, {
                issues: filtered.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
            });

            return { status: 500, body: { code: "INTERNAL", message: "The request could not be completed." } };
        }

        const status = reply?.status ?? (route.method === "POST" ? 201 : 200);

        if (spent !== undefined && route.limit?.countSuccess === false && status < 400)
        {
            rateLimiter?.refund?.(spent);
        }

        if (EMPTY_STATUSES.has(status))
        {
            if (filtered.data !== undefined && filtered.data !== null)
            {
                log("warn", plugin, `${route.method} ${route.path} answered ${String(status)} with a body, which that status never carries; it was dropped`);
            }

            return { status, body: null, ...(reply !== undefined && { headers: replyHeaders(reply.headers, plugin, route, log, headerPolicy) }) };
        }

        if (reply !== undefined)
        {
            return tagged({ status, body: filtered.data, headers: replyHeaders(reply.headers, plugin, route, log, headerPolicy) }, route, incoming);
        }

        return tagged({ status, body: filtered.data }, route, incoming);
    }
    catch (cause)
    {
        stream?.release();

        const refusal = refusalBodyFor(cause);

        if (refusal.status >= 500)
        {
            log("error", plugin, `${route.method} ${route.path} threw`, logRecord(cause));
        }
        else
        {
            // every refusal, not only the ones that are our fault: a run of
            // 401s is what an attack looks like, and it left no trace at all
            log("warn", plugin, `${route.method} ${route.path} refused ${refusal.status}`, { code: refusal.code });
        }

        return {
            status: refusal.status,
            body: {
                code: refusal.code,
                message: refusal.message,
                ...(refusal.fields !== undefined && { fields: refusal.fields }),
            },
        };
    }
}

/** The headers a route named, and nothing else. */
function allowedHeaders(route: Route<Context>, sent: Readonly<Record<string, string>> = {}): Readonly<Record<string, string>>
{
    const sending: Record<string, string> = {};

    for (const name of route.reads ?? [])
    {
        const value = sent[name];

        if (value !== undefined)
        {
            sending[name] = value;
        }
    }

    return sending;
}

/** Which fields failed, and why. */
function fieldErrors(error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }): Record<string, string>
{
    const byField: Record<string, string> = {};

    for (const issue of error.issues)
    {
        const field = issue.path.map((segment) => String(segment)).join(".");

        if (field !== "" && byField[field] === undefined)
        {
            byField[field] = issue.message;
        }
    }

    return byField;
}
