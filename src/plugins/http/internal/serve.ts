import { Hono } from "hono";
import type { Context as HonoContext } from "hono";

import type { Identity, Kernel, HttpMethod } from "../../kernel/api";
import { securityHeaders } from "./headers";
import { cors, type CorsPolicy } from "./origin";
import { readInput } from "./input";
import { sessionCookie, withSessionKey, type SessionOptions } from "./session";
import { formBody, type UploadedFile } from "./upload";

/** What options needs to know. */
export type ServerOptions = {
    kernel: Kernel;

    /** Who is calling, where the project answers rather than a plugin. */
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

    /** What a session is kept in, when it is a cookie. */
    session?: SessionOptions | undefined;

    /** Where a line goes. */
    log?: ((level: "info" | "warn" | "error", line: string, about?: Readonly<Record<string, unknown>>) => void) | undefined;
};

/** Which methods a caller may send a body with, and we will read one from. */
const CARRIES: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

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

/** The body a route asked for, bounded before anything parses it. */
async function requestBody(request: Request, route: { method: string; accepts?: "json" | "form"; keepsRaw?: boolean }, bytes: number): Promise<BodyResult>
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

    const kept = route.keepsRaw === true ? { sent: raw } : {};

    try
    {
        return { body: JSON.parse(new TextDecoder().decode(raw)) as unknown, uploads: {}, ...kept };
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
            if (name === "access-control-allow-methods" && c.req.method === "OPTIONS" && c.res.headers.has(name))
            {
                continue;
            }

            c.header(name, value);
        }

        c.header("x-request-id", traced);
    });

    const byPath = new Map<string, Set<string>>();

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
                identity = options.identify === undefined
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
