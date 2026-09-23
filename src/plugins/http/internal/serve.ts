import { Hono } from "hono";
import { z } from "zod";
import type { Context as HonoContext } from "hono";

import type { Identity, Kernel, HttpMethod } from "../../kernel/api";
import { securityHeaders } from "./headers";
import { chunkStream } from "./download";
import { eventStream } from "./events";
import { cors, type CorsPolicy } from "./origin";
import { runTraced } from "./traced";
import { limiter } from "../../guard/api";
import { readInput, UNSAFE } from "./input";
import { cookieIn, sessionCookie, withSessionKey, type SessionOptions } from "./session";
import { formBody, type UploadedFile } from "./upload";

/** What `serve` needs to know. */
export type ServerOptions = {
    kernel: Kernel;

    /** Who is calling, where the project answers rather than a plugin. */
    identify?: ((c: HonoContext) => Identity | undefined | Promise<Identity | undefined>) | undefined;

    /** What to count an anonymous identity by for a rate limit; the project decides, because reading a forwarded header blindly lets anyone spend anyone's budget. */
    from?: ((c: HonoContext) => string) | undefined;

    origins?: readonly string[];
    methods?: readonly string[];
    headers?: readonly string[];
    maxAge?: number;

    /** Response headers a page on an allowed origin may read: retry-after, x-request-id, etag and content-disposition when left out. */
    exposes?: readonly string[];

    /** The largest body accepted, before it is parsed. */
    bodyBytes?: number;

    /** What a session is kept in, when it is a cookie. */
    session?: SessionOptions | undefined;

    /** Where a line goes. */
    log?: ((level: "info" | "warn" | "error", line: string, about?: Readonly<Record<string, unknown>>) => void) | undefined;

    /** Where a browser reports what went wrong on its side: off unless given. Bounded, counted per address, and written to the log only. */
    clientLogs?: { path?: string; maxBytes?: number; requests?: number; seconds?: number } | undefined;

    /** Tells browsers to reach this origin over https only, for `maxAge` seconds; off unless given, since it cannot be taken back until it expires. */
    hsts?: { maxAge: number; includeSubDomains?: boolean } | undefined;

    /** Whether each request leaves one line saying what it asked, by the route's pattern, how it was answered and how long it took; on unless false. Probes leave one only when they fail. */
    accessLog?: boolean | undefined;

    /** What GET /ready answers once the kernel has started: 200 when `ready`, 503 otherwise, the object as the body, so it names only coarse states. Left out, /ready answers whether the kernel started. GET /live and GET /health always answer 200 while the process serves. */
    readiness?: (() => Promise<{ ready: boolean } & Readonly<Record<string, unknown>>>) | undefined;
};

/** What a browser may report: a level, one line, where it was, and a bounded detail. */
const CLIENT_REPORT = z.object({
    level: z.enum(["warn", "error"]),
    message: z.string().min(1).max(500),
    page: z.string().max(300).optional(),
    detail: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/u), z.union([z.string().max(1000), z.number(), z.boolean(), z.null()])).refine((detail) => Object.keys(detail).length <= 20).optional(),
}).strict();

/** What an orchestrator asks every few seconds: a line for each would drown the rest. */
const PROBES: ReadonlySet<string> = new Set(["/live", "/health", "/ready"]);

/** Which methods a caller may send a body with, and we will read one from. */
const CARRIES: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** Answers the caller's `x-request-id` only when it is 1-64 of `[A-Za-z0-9_-]`, and a fresh UUID otherwise, so a caller cannot write arbitrary text into every log line. */
export function requestId(header: string | undefined): string
{
    return header !== undefined && /^[A-Za-z0-9_-]{1,64}$/.test(header) ? header : crypto.randomUUID();
}

/** The headers a route declared, read off the request in lowercase. */
function readHeaders(c: HonoContext, reads: readonly string[]): Readonly<Record<string, string>>
{
    const headers: Record<string, string> = {};

    for (const name of reads)
    {
        const value = c.req.header(name);

        if (value !== undefined)
        {
            headers[name] = value;
        }
    }

    return headers;
}

/** Which methods a declared path answers, matching `:param` segments. */
function methodsFor(answering: ReadonlyMap<string, Set<string>>, path: string): Set<string> | undefined
{
    const direct = answering.get(path);

    if (direct !== undefined)
    {
        return direct;
    }

    const segments = path.split("/");

    for (const [pattern, methods] of answering)
    {
        const parts = pattern.split("/");

        if (parts.length !== segments.length)
        {
            continue;
        }

        if (parts.every((part, index) => part.startsWith(":") || part === segments[index]))
        {
            return methods;
        }
    }

    return undefined;
}


/** The body, or nothing when it outgrows what is allowed. */
async function readBytes(stream: ReadableStream<Uint8Array> | null, bytes: number): Promise<Uint8Array | undefined>
{
    if (stream === null)
    {
        return new Uint8Array(0);
    }

    const reader = stream.getReader();
    const parts: Uint8Array[] = [];

    let read = 0;

    try
    {
        for (;;)
        {
            const { done, value } = await reader.read();

            if (done)
            {
                break;
            }

            read += value.byteLength;

            if (read > bytes)
            {
                return undefined;
            }

            parts.push(value);
        }
    }
    finally
    {
        await reader.cancel().catch(() => undefined);
    }

    const all = new Uint8Array(read);

    let written = 0;

    for (const part of parts)
    {
        all.set(part, written);
        written += part.byteLength;
    }

    return all;
}

/** What a route was sent, or the refusal to answer instead. */
type BodyResult =
    | { body: unknown; uploads: Readonly<Record<string, UploadedFile | UploadedFile[]>>; sent?: Uint8Array }
    | { refused: { code: string; message: string }; status: number };

const TOO_LARGE = { refused: { code: "TOO_LARGE", message: "The request body is too large." }, status: 413 } as const;

/**
 * Whether a request could have been sent by another site riding on the caller's session cookie: an unsafe
 * method carrying the cookie, in a content type a page may send without asking (anything but JSON, which a
 * cross-site page cannot send without a preflight the CORS policy answers), from an origin not allowed.
 */
function isForgeable(request: Request, method: string, session: SessionOptions | undefined, origins: readonly string[]): boolean
{
    if (session === undefined || !CARRIES.has(method) || cookieIn(request.headers.get("cookie") ?? undefined, session.name) === undefined)
    {
        return false;
    }

    const contentType = (request.headers.get("content-type") ?? "").toLowerCase();
    const origin = request.headers.get("origin");

    return !JSON_TYPE.test(contentType) && (origin === null || !origins.includes(origin));
}

/** What a JSON body is sent as: application/json, or a type ending in +json, with parameters after. */
const JSON_TYPE = /^application\/(?:[\w.+-]+\+)?json\s*(?:;|$)/u;

/** The most fields a URL-encoded form may carry, so one request of repeated names costs as much to read as its size. */
const MOST_FIELDS = 1000;

/**
 * A form a provider posts: the bytes kept as they arrived for its signature, the fields decoded as strings,
 * a name sent twice as a list, as a query is.
 */
async function urlencodedBody(request: Request, route: { keepsRaw?: boolean }, contentType: string, bytes: number): Promise<BodyResult>
{
    if (!contentType.startsWith("application/x-www-form-urlencoded"))
    {
        return { refused: { code: "UNSUPPORTED_BODY", message: "This route reads a URL-encoded form. Send application/x-www-form-urlencoded." }, status: 415 };
    }

    const raw = await readBytes(request.body, bytes);

    if (raw === undefined)
    {
        return TOO_LARGE;
    }

    // no prototype, and a repeat pushed rather than copied, so a request of repeated names is read in its own size
    const fields = Object.create(null) as Record<string, string | string[]>;

    let count = 0;

    for (const [key, value] of new URLSearchParams(new TextDecoder().decode(raw)))
    {
        count += 1;

        if (count > MOST_FIELDS)
        {
            return { refused: { code: "TOO_LARGE", message: `The form has more than ${String(MOST_FIELDS)} fields.` }, status: 413 };
        }

        if (UNSAFE.has(key))
        {
            continue;
        }

        const held = fields[key];

        if (held === undefined)
        {
            fields[key] = value;
        }
        else if (Array.isArray(held))
        {
            held.push(value);
        }
        else
        {
            fields[key] = [held, value];
        }
    }

    return { body: fields, uploads: {}, ...(route.keepsRaw === true && { sent: raw }) };
}

/** The body a route asked for, bounded before anything parses it. */
async function requestBody(request: Request, route: { method: string; accepts?: "json" | "form" | "urlencoded"; keepsRaw?: boolean }, bytes: number): Promise<BodyResult>
{
    if (!CARRIES.has(route.method))
    {
        return { body: undefined, uploads: {} };
    }

    const claimed = Number(request.headers.get("content-length") ?? "0");

    if (Number.isFinite(claimed) && claimed > bytes)
    {
        return TOO_LARGE;
    }

    const contentType = (request.headers.get("content-type") ?? "").toLowerCase();

    if (route.accepts === "urlencoded")
    {
        return urlencodedBody(request, route, contentType, bytes);
    }

    const wantsForm = route.accepts === "form";
    const sentForm = contentType.startsWith("multipart/form-data");

    if (sentForm !== wantsForm)
    {
        return {
            refused: {
                code: "UNSUPPORTED_BODY",
                message: wantsForm
                    ? "This route reads a form. Send multipart/form-data."
                    : "This route reads JSON. Send a JSON body.",
            },
            status: 415,
        };
    }

    const raw = await readBytes(request.body, bytes);

    if (raw === undefined)
    {
        return TOO_LARGE;
    }

    if (sentForm)
    {
        try
        {
            const read = await formBody(new Request(request.url, {
                method: request.method,
                headers: request.headers,
                body: raw,
            }));

            return { body: read.fields, uploads: read.uploads };
        }
        catch
        {
            return { refused: { code: "INVALID_FORM", message: "The request body is not a valid form." }, status: 400 };
        }
    }

    if (raw.byteLength === 0)
    {
        return { body: undefined, uploads: {} };
    }

    // a body named as something else is read as nothing else: text/plain holding JSON is how a form on another site posts
    if (!JSON_TYPE.test(contentType))
    {
        return { refused: { code: "UNSUPPORTED_BODY", message: "This route reads JSON. Send it as application/json." }, status: 415 };
    }

    const rawBody = route.keepsRaw === true ? { sent: raw } : {};

    try
    {
        return { body: JSON.parse(new TextDecoder().decode(raw)) as unknown, uploads: {}, ...rawBody };
    }
    catch
    {
        return { refused: { code: "INVALID_JSON", message: "The request body is not valid JSON." }, status: 400 };
    }
}

/** Builds the Hono app the kernel's routes are mounted on. */
export function serve(options: ServerOptions): Hono
{
    const app = new Hono();
    const bodyBytes = options.bodyBytes ?? 1_000_000;
    const policy: CorsPolicy = {
        origins: options.origins ?? [],
        methods: options.methods ?? ["GET", "POST", "PUT", "PATCH", "DELETE"],
        headers: options.headers ?? ["content-type", "authorization"],
        maxAge: options.maxAge ?? 600,
        exposes: options.exposes ?? ["retry-after", "x-request-id", "etag", "content-disposition"],
    };

    const requestIds = new WeakMap<Request, string>();

    /** Requests a route any site may read answered, which get `*` and no credentials whoever asked. */
    const shared = new WeakSet<Request>();

    const anyOrigin = new Map<string, Set<string>>();

    for (const route of options.kernel.routes())
    {
        if (route.anyOrigin)
        {
            anyOrigin.set(route.path, new Set(["GET", "HEAD"]));
        }
    }

    /** The declared pattern each request matched, for its access line. */
    const patterns = new WeakMap<Request, string>();

    /** Requests a declared document answered, whose policy and framing the middleware leaves alone. */
    const documents = new WeakSet<Request>();

    app.use("*", async (c, next) =>
    {
        const traced = requestId(c.req.header("x-request-id"));
        const started = performance.now();

        requestIds.set(c.req.raw, traced);

        await runTraced(traced, next);

        const path = new URL(c.req.url).pathname;
        const probe = PROBES.has(path);

        // the declared pattern, never the path a caller wrote: an id, a slug or a token in a path stays out of the log
        if (options.accessLog !== false && (!probe || c.res.status >= 500))
        {
            options.log?.("info", "request", {
                requestId: traced,
                method: c.req.method,
                path: probe ? path : patterns.get(c.req.raw) ?? "(unmatched)",
                status: c.res.status,
                durationMs: Math.round(performance.now() - started),
            });
        }

        const document = documents.has(c.req.raw);

        for (const [name, value] of Object.entries(securityHeaders))
        {
            // always the kit's, with two exceptions it decided itself: a declared document's policy and
            // framing, and a cache-control the reply chose within what its route may say
            if ((document && (name === "content-security-policy" || name === "x-frame-options")) || (name === "cache-control" && c.res.headers.has(name)))
            {
                continue;
            }

            c.header(name, value);
        }

        // Vary stays: a handler may still answer by the Origin it reads, and a shared cache must keep those apart
        const allowed = shared.has(c.req.raw)
            ? { "access-control-allow-origin": "*", ...(policy.exposes.length > 0 && { "access-control-expose-headers": policy.exposes.join(", ") }), vary: "Origin" }
            : cors(policy, c.req.header("origin"));

        for (const [name, value] of Object.entries(allowed))
        {
            if (name === "access-control-allow-methods" && c.req.method === "OPTIONS" && c.res.headers.has(name))
            {
                continue;
            }

            c.header(name, value);
        }

        c.header("x-request-id", traced);

        if (options.hsts !== undefined)
        {
            c.header("strict-transport-security", `max-age=${String(Math.max(0, Math.floor(options.hsts.maxAge)))}${options.hsts.includeSubDomains === true ? "; includeSubDomains" : ""}`);
        }
    });

    const byPath = new Map<string, Set<string>>();

    app.get("/live", (c) => c.json({ live: true }));

    app.get("/health", (c) => c.json({ live: true }));

    const intake = options.clientLogs;

    if (intake !== undefined)
    {
        const counting = limiter();
        const most = intake.maxBytes ?? 8_000;

        // a public door: bounded before it is read, counted per address, and only ever written to the log, which redacts
        app.post(intake.path ?? "/client-logs", async (c) =>
        {
            const from = options.from?.(c) ?? "anonymous";

            if (!counting.spend(`client-logs:${from}`, { requests: intake.requests ?? 30, seconds: intake.seconds ?? 60 }).allowed)
            {
                return c.json({ code: "RATE_LIMITED", message: "Too many requests. Try again shortly." }, 429);
            }

            const raw = await readBytes(c.req.raw.body, most);
            let report: unknown;

            try
            {
                report = raw === undefined ? undefined : JSON.parse(new TextDecoder().decode(raw));
            }
            catch
            {
                report = undefined;
            }

            const parsed = CLIENT_REPORT.safeParse(report);

            if (!parsed.success)
            {
                return c.json({ code: "INVALID_INPUT", message: "The report is not valid." }, raw === undefined ? 413 : 400);
            }

            options.log?.(parsed.data.level === "error" ? "error" : "warn", `client: ${parsed.data.message}`, { client: true, ...(parsed.data.page !== undefined && { page: parsed.data.page }), ...(parsed.data.detail !== undefined && { detail: parsed.data.detail }) });

            return c.body(null, 204);
        });
    }

    app.get("/ready", async (c) =>
    {
        const readiness = options.readiness;

        if (!options.kernel.started() || readiness === undefined)
        {
            const ready = options.kernel.started();

            return c.json({ ready }, ready ? 200 : 503);
        }

        // what the project checks is its own; a check that throws is a component that is not ready, and says nothing more
        let answer: { ready: boolean } & Readonly<Record<string, unknown>>;

        try
        {
            answer = await readiness();
        }
        catch (cause)
        {
            options.log?.("warn", "the readiness check threw", { error: cause instanceof Error ? cause.message : String(cause) });
            answer = { ready: false };
        }

        return c.json(answer, answer.ready ? 200 : 503);
    });

    for (const route of options.kernel.routes())
    {
        const methods = byPath.get(route.path) ?? new Set<string>();

        methods.add(route.method);
        byPath.set(route.path, methods);
    }

    app.options("*", (c) =>
    {
        const methods = methodsFor(byPath, c.req.path);

        if (methods === undefined)
        {
            return c.json({ code: "NOT_FOUND", message: "No such route." }, 404);
        }

        const asked = (c.req.header("access-control-request-method") ?? "").toUpperCase();

        // a preflight for a read any site may make gets `*`; a write at the same path gets the ordinary policy
        if (methodsFor(anyOrigin, c.req.path)?.has(asked) === true)
        {
            shared.add(c.req.raw);
            c.header("access-control-allow-methods", "GET, HEAD");
            c.header("access-control-max-age", String(policy.maxAge));

            return c.body(null, 204);
        }

        c.header("access-control-allow-methods", [...methods].sort().join(", "));

        return c.body(null, 204);
    });

    for (const route of options.kernel.routes())
    {
        app.on(route.method, route.path, async (c) =>
        {
            const requestId = requestIds.get(c.req.raw) ?? "";

            let identity: Identity | undefined;

            patterns.set(c.req.raw, route.path);

            // the caller's own cookie cannot vouch for a request another page may have sent
            if (isForgeable(c.req.raw, route.method, options.session, policy.origins))
            {
                options.log?.("warn", "refused a cookie request from an origin not allowed", { requestId, origin: c.req.header("origin") ?? "" });

                return c.json({ code: "FORBIDDEN_ORIGIN", message: "This request may not use the session cookie from this origin." }, 403);
            }

            if (route.anyOrigin)
            {
                shared.add(c.req.raw);
            }

            try
            {
                // a route any site may read never reads a session, so its answer is the same for everyone
                identity = route.anyOrigin ? undefined : options.identify === undefined
                    ? await options.kernel.identify?.(withSessionKey(c.req.raw, options.session))
                    : await options.identify(c);
            }
            catch (cause)
            {
                options.log?.("warn", "identify threw", { requestId, error: cause instanceof Error ? cause.message : String(cause) });

                return c.json({ code: "UNAUTHENTICATED", message: "This request needs to be signed in." }, 401);
            }

            const read = await requestBody(c.req.raw, route, bodyBytes);

            if ("refused" in read)
            {
                return c.json(read.refused, read.status as 413);
            }

            const answer = await options.kernel.handle({
                method: route.method as HttpMethod,
                path: route.path,
                input: readInput({
                    params: c.req.param(),
                    query: c.req.queries() as Record<string, string[]>,
                    body: read.body,
                    uploads: read.uploads,
                }),
                identity,
                headers: readHeaders(c, route.reads),
                ...("sent" in read && read.sent !== undefined && { sent: read.sent }),
                ...(options.from !== undefined && { from: options.from(c) }),
                signal: c.req.raw.signal,
                ifNoneMatch: c.req.header("if-none-match"),
            });

            if (answer.status >= 500)
            {
                options.log?.("error", `${route.method} ${route.path} failed`, { requestId, plugin: route.plugin });
            }

            const session = options.session === undefined
                ? { cookie: undefined, headers: answer.headers ?? {} }
                : sessionCookie(answer.headers ?? {}, options.session, Date.now());

            for (const [name, value] of Object.entries(session.headers))
            {
                c.header(name, value);
            }

            if (session.cookie !== undefined)
            {
                c.header("set-cookie", session.cookie, { append: true });
            }

            if (answer.document === true)
            {
                documents.add(c.req.raw);
            }

            if (answer.status === 204 || answer.status === 205 || answer.status === 304)
            {
                return c.body(null, answer.status);
            }

            if (answer.file === true)
            {
                const body = answer.body;

                if (typeof body === "string")
                {
                    return c.body(body, answer.status as 200);
                }

                if (body instanceof Uint8Array)
                {
                    return c.body(new Uint8Array(body), answer.status as 200);
                }

                return c.body(chunkStream(body as AsyncIterable<Uint8Array>, c.req.raw.signal), answer.status as 200);
            }

            if (answer.document === true && typeof answer.body === "string")
            {
                return c.body(answer.body, answer.status as 200);
            }

            if (answer.body !== null && typeof answer.body === "object" && Symbol.asyncIterator in answer.body)
            {
                return c.body(eventStream(answer.body as AsyncIterable<{ data?: unknown }>, c.req.raw.signal), answer.status as 200);
            }

            return c.json(answer.body as Record<string, unknown>, answer.status as 200);
        });
    }

    app.notFound((c) =>
    {
        return c.json({ code: "NOT_FOUND", message: "No such route." }, 404);
    });

    app.onError((cause, c) =>
    {
        options.log?.("error", "the server threw outside a route", {
            requestId: requestIds.get(c.req.raw) ?? "",
            error: cause instanceof Error ? cause.message : String(cause),
            ...(cause instanceof Error && cause.stack !== undefined && { stack: cause.stack }),
        });

        return c.json({ code: "INTERNAL", message: "The request could not be completed." }, 500);
    });

    return app;
}
