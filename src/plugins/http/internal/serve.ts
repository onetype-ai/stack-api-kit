import { Hono } from "hono";
import type { Context as HonoContext } from "hono";

import type { Identity, Kernel, Method } from "../../kernel/api";
import { securityHeaders } from "./headers";
import { cors, type CorsPolicy } from "./origin";
import { input } from "./input";
import { sessionCookie, withSessionKey, type SessionOptions } from "./session";
import { formBody, type Upload } from "./upload";

/** What options needs to know. */
export type ServerOptions = {
    kernel: Kernel;

    /**
     * Who is calling, where the project answers rather than a plugin.
     *
     * Left out, the kernel asks whichever plugin declared `identifies`, which
     * is where a session already lives. Passed, this wins: it was given by
     * name.
     *
     * Throwing answers 401. Undefined is a stranger, which only a public
     * route accepts.
     */
    identify?: ((c: HonoContext) => Identity | undefined | Promise<Identity | undefined>) | undefined;

    /**
     * What to count an anonymous identity by, for a rate limit: an address, an
     * api key, whatever the deployment can trust. Reading a forwarded header
     * blindly lets anyone spend anyone's budget, so the project decides.
     */
    from?: ((c: HonoContext) => string) | undefined;

    origins?: readonly string[];
    methods?: readonly string[];
    headers?: readonly string[];
    maxAge?: number;

    /** The largest body accepted, before it is parsed. */
    bodyBytes?: number;

    /**
     * What a session is kept in, when it is a cookie.
     *
     * A route answers `x-session-key` with `x-session-expires`, or
     * `x-session-end` to close one; this turns that into `set-cookie` and
     * takes the headers back out. Left out, they leave as they are and the
     * project decides what they mean: a token in a mobile client is the same
     * routes with nothing changed.
     */
    session?: SessionOptions | undefined;

    /** Where a line goes. */
    log?: ((level: "info" | "warn" | "error", line: string, about?: Readonly<Record<string, unknown>>) => void) | undefined;
};

/** Which methods a caller may send a body with, and we will read one from. */
const CARRIES: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Kept only when it is safe to write down: an id carrying a newline is how
// one request writes a second line into the log and calls it whatever it
// likes.
export function requestId(sent: string | undefined): string
{
    return sent !== undefined && /^[A-Za-z0-9_-]{1,64}$/.test(sent) ? sent : crypto.randomUUID();
}

/**
 * Builds the Hono app the kernel's routes are mounted on.
 *
 * Everything crossing into the process crosses here, which is why the limits
 * live here: a plugin that had to remember to bound a body is one that will
 * forget once.
 */
/** The headers a route declared, read off the request in lowercase. */
function headersOf(c: HonoContext, reads: readonly string[]): Readonly<Record<string, string>>
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

        if (parts.every((part, at) => part.startsWith(":") || part === segments[at]))
        {
            return methods;
        }
    }

    return undefined;
}


/**
 * The body, or nothing when it outgrows what is allowed.
 *
 * Counted chunk by chunk and abandoned the moment it is too big, so a caller
 * cannot make the server hold what it is about to refuse.
 */
async function bodyOf(stream: ReadableStream<Uint8Array> | null, bytes: number): Promise<Uint8Array | undefined>
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

    let at = 0;

    for (const part of parts)
    {
        all.set(part, at);
        at += part.byteLength;
    }

    return all;
}

/** What a route was sent, or the refusal to answer instead. */
type ReadBody =
    | { body: unknown; uploads: Readonly<Record<string, Upload | Upload[]>> }
    | { refused: { code: string; message: string }; status: number };

const TOO_LARGE = { refused: { code: "TOO_LARGE", message: "The request body is too large." }, status: 413 } as const;

/**
 * The body a route asked for, bounded before anything parses it.
 *
 * A form is read by the platform rather than a parser of ours, and only where
 * the route declared it takes one: a route expecting JSON cannot be handed a
 * file, and one expecting a form cannot be handed JSON. Both refusals are 415,
 * which says the body was the wrong kind rather than the wrong shape.
 */
async function bodyFor(request: Request, route: { method: string; accepts?: "json" | "form" }, bytes: number): Promise<ReadBody>
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

    // Bounded first either way: what the platform reads, it reads whole, so a
    // form is counted before it is handed over rather than after.
    const raw = await bodyOf(request.body, bytes);

    if (raw === undefined)
    {
        return TOO_LARGE;
    }

    if (sentForm)
    {
        const read = await formBody(new Request(request.url, {
            method: request.method,
            headers: request.headers,
            body: raw,
        }));

        return { body: read.fields, uploads: read.uploads };
    }

    if (raw.byteLength === 0)
    {
        return { body: undefined, uploads: {} };
    }

    try
    {
        return { body: JSON.parse(new TextDecoder().decode(raw)) as unknown, uploads: {} };
    }
    catch
    {
        return { refused: { code: "INVALID_JSON", message: "The request body is not valid JSON." }, status: 400 };
    }
}

export function serve(options: ServerOptions): Hono
{
    const app = new Hono();
    const bodyBytes = options.bodyBytes ?? 1_000_000;
    const policy: CorsPolicy = {
        origins: options.origins ?? [],
        methods: options.methods ?? ["GET", "POST", "PUT", "PATCH", "DELETE"],
        headers: options.headers ?? ["content-type", "authorization"],
        maxAge: options.maxAge ?? 600,
    };

    const requestIds = new WeakMap<Request, string>();

    app.use("*", async (c, next) =>
    {
        const traced = requestId(c.req.header("x-request-id"));

        requestIds.set(c.req.raw, traced);

        await next();

        for (const [name, value] of Object.entries(securityHeaders))
        {
            c.header(name, value);
        }

        for (const [name, value] of Object.entries(cors(policy, c.req.header("origin"))))
        {
            // A preflight already said which methods its own path answers.
            if (name === "access-control-allow-methods" && c.req.method === "OPTIONS" && c.res.headers.has(name))
            {
                continue;
            }

            c.header(name, value);
        }

        c.header("x-request-id", traced);
    });

    // A preflight is answered only for a path some route declared, and only
    // for the methods that path actually answers: approving one for a route
    // that does not exist tells a browser it may send what nothing will take,
    // and maps out the surface for anyone asking.
    const byPath = new Map<string, Set<string>>();

    // Two questions a deployment asks, and they are not the same one. Live
    // says the process is up, which is what decides a restart. Ready says the
    // kernel started, its migrations ran and its plugins are up, which is
    // what decides whether traffic may arrive. A process that answers live
    // but not ready is one that should be left alone to finish starting,
    // never killed and never sent a request.
    app.get("/live", (c) => c.json({ live: true }));

    app.get("/ready", (c) =>
    {
        const ready = options.kernel.started();

        return c.json({ ready }, ready ? 200 : 503);
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

        c.header("access-control-allow-methods", [...methods].sort().join(", "));

        return c.body(null, 204);
    });

    for (const route of options.kernel.routes())
    {
        app.on(route.method, route.path, async (c) =>
        {
            const requestId = requestIds.get(c.req.raw) ?? "";

            let identity: Identity | undefined;

            try
            {
                // The project's own wins: it was passed by name, where the
                // kernel's comes from whichever plugin declared it.
                identity = options.identify === undefined
                    ? await options.kernel.identify?.(withSessionKey(c.req.raw, options.session))
                    : await options.identify(c);
            }
            catch (cause)
            {
                // Whatever went wrong reading a session, the caller is not
                // signed in. A 500 here would turn an expired token into an
                // outage, and tell whoever sent it that it was interesting.
                options.log?.("warn", "identify threw", { requestId, error: cause instanceof Error ? cause.message : String(cause) });

                return c.json({ code: "UNAUTHENTICATED", message: "This request needs to be signed in." }, 401);
            }

            const read = await bodyFor(c.req.raw, route, bodyBytes);

            if ("refused" in read)
            {
                return c.json(read.refused, read.status as 413);
            }

            const answer = await options.kernel.handle({
                method: route.method as Method,
                path: route.path,
                input: input({
                    params: c.req.param(),
                    query: c.req.queries() as Record<string, string[]>,
                    body: read.body,
                    uploads: read.uploads,
                }),
                identity,
                headers: headersOf(c, route.reads),
                ...(options.from !== undefined && { from: options.from(c) }),
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
