import { Hono } from "hono";
import type { Context as HonoContext } from "hono";

import type { Caller, Kernel, Method } from "../../kernel/api";
import { securityHeaders } from "./headers";
import { cors, type Allowing } from "./origin";
import { input } from "./input";

/** What serving needs to know. */
export type ServerOptions = {
    kernel: Kernel;

    /**
     * Who is calling. The project owns this entirely: a cookie, a bearer
     * token, a header, whatever it decided a session is.
     *
     * Throwing answers 401. Returning undefined is an anonymous caller, which
     * only a public route accepts.
     */
    identify?: ((c: HonoContext) => Caller | undefined | Promise<Caller | undefined>) | undefined;

    /**
     * What to count an anonymous caller by, for a rate limit: an address, an
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
function named(c: HonoContext, reads: readonly string[]): Readonly<Record<string, string>>
{
    const reading: Record<string, string> = {};

    for (const name of reads)
    {
        const value = c.req.header(name);

        if (value !== undefined)
        {
            reading[name] = value;
        }
    }

    return reading;
}

/** Which methods a declared path answers, matching `:param` segments. */
function matching(answering: ReadonlyMap<string, Set<string>>, path: string): Set<string> | undefined
{
    const direct = answering.get(path);

    if (direct !== undefined)
    {
        return direct;
    }

    const asked = path.split("/");

    for (const [declared, methods] of answering)
    {
        const parts = declared.split("/");

        if (parts.length !== asked.length)
        {
            continue;
        }

        if (parts.every((part, at) => part.startsWith(":") || part === asked[at]))
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
async function taken(stream: ReadableStream<Uint8Array> | null, bytes: number): Promise<Uint8Array | undefined>
{
    if (stream === null)
    {
        return new Uint8Array(0);
    }

    const reader = stream.getReader();
    const parts: Uint8Array[] = [];

    let held = 0;

    try
    {
        for (;;)
        {
            const { done, value } = await reader.read();

            if (done)
            {
                break;
            }

            held += value.byteLength;

            if (held > bytes)
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

    const all = new Uint8Array(held);

    let at = 0;

    for (const part of parts)
    {
        all.set(part, at);
        at += part.byteLength;
    }

    return all;
}

export function serve(serving: ServerOptions): Hono
{
    const app = new Hono();
    const bodyBytes = serving.bodyBytes ?? 1_000_000;
    const allowing: Allowing = {
        origins: serving.origins ?? [],
        methods: serving.methods ?? ["GET", "POST", "PUT", "PATCH", "DELETE"],
        headers: serving.headers ?? ["content-type", "authorization"],
        maxAge: serving.maxAge ?? 600,
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

        for (const [name, value] of Object.entries(cors(allowing, c.req.header("origin"))))
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
    const answering = new Map<string, Set<string>>();

    // Two questions a deployment asks, and they are not the same one. Live
    // says the process is up, which is what decides a restart. Ready says the
    // kernel started, its migrations ran and its plugins are up, which is
    // what decides whether traffic may arrive. A process that answers live
    // but not ready is one that should be left alone to finish starting,
    // never killed and never sent a request.
    app.get("/live", (c) => c.json({ live: true }));

    app.get("/ready", (c) =>
    {
        const ready = serving.kernel.started();

        return c.json({ ready }, ready ? 200 : 503);
    });

    for (const route of serving.kernel.routes())
    {
        const methods = answering.get(route.path) ?? new Set<string>();

        methods.add(route.method);
        answering.set(route.path, methods);
    }

    app.options("*", (c) =>
    {
        const methods = matching(answering, c.req.path);

        if (methods === undefined)
        {
            return c.json({ code: "NOT_FOUND", message: "No such route." }, 404);
        }

        c.header("access-control-allow-methods", [...methods].sort().join(", "));

        return c.body(null, 204);
    });

    for (const route of serving.kernel.routes())
    {
        const path = route.path.replace(/:([a-z0-9-]+)/g, ":$1");

        app.on(route.method, path, async (c) =>
        {
            const requestId = requestIds.get(c.req.raw) ?? "";

            let caller: Caller | undefined;

            try
            {
                caller = await serving.identify?.(c);
            }
            catch (cause)
            {
                // Whatever went wrong reading a session, the caller is not
                // signed in. A 500 here would turn an expired token into an
                // outage, and tell whoever sent it that it was interesting.
                serving.log?.("warn", "identify threw", { requestId, error: cause instanceof Error ? cause.message : String(cause) });

                return c.json({ code: "UNAUTHENTICATED", message: "This request needs to be signed in." }, 401);
            }

            let body: unknown;

            if (CARRIES.has(route.method))
            {
                const claimed = Number(c.req.header("content-length") ?? "0");

                if (Number.isFinite(claimed) && claimed > bodyBytes)
                {
                    return c.json({ code: "TOO_LARGE", message: "The request body is too large." }, 413);
                }

                // Read as bytes, and counted as bytes while they arrive.
                // `content-length` is what the caller claimed and a chunked
                // request sends none, so the limit above lets one through;
                // buffering it whole first would let a caller spend the
                // server's memory before anything refuses it. Measuring the
                // decoded string instead counts UTF-16 units, so a body of
                // Japanese passes a limit three times smaller than what
                // actually arrived.
                const raw = await taken(c.req.raw.body, bodyBytes);

                if (raw === undefined)
                {
                    return c.json({ code: "TOO_LARGE", message: "The request body is too large." }, 413);
                }

                if (raw.byteLength > 0)
                {
                    try
                    {
                        body = JSON.parse(new TextDecoder().decode(raw));
                    }
                    catch
                    {
                        return c.json({ code: "INVALID_JSON", message: "The request body is not valid JSON." }, 400);
                    }
                }
            }

            const answer = await serving.kernel.handle({
                method: route.method as Method,
                path: route.path,
                input: input({ params: c.req.param(), query: c.req.queries() as Record<string, string[]>, body }),
                caller,
                headers: named(c, route.reads),
                ...(serving.from !== undefined && { from: serving.from(c) }),
            });

            if (answer.status >= 500)
            {
                serving.log?.("error", `${route.method} ${route.path} failed`, { requestId, plugin: route.plugin });
            }

            for (const [name, value] of Object.entries(answer.headers ?? {}))
            {
                c.header(name, value);
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
        serving.log?.("error", "the server threw outside a route", {
            requestId: requestIds.get(c.req.raw) ?? "",
            error: cause instanceof Error ? cause.message : String(cause),
            ...(cause instanceof Error && cause.stack !== undefined && { stack: cause.stack }),
        });

        return c.json({ code: "INTERNAL", message: "The request could not be completed." }, 500);
    });

    return app;
}
