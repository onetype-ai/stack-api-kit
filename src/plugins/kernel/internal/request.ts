import { refusalBodyFor, Reply, Refusal } from "./refusal";
import type { Identity, Context, HttpMethod, Route } from "./contract";
import { KernelFault } from "./faults";
import { createPermissions } from "./permissions";

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
};

/** What the kernel answers: a status, and a body already safe to send. */
export type KernelResponse = {
    status: number;
    body: unknown;
    headers?: Readonly<Record<string, string>>;
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
    context: (plugin: string, identity?: Identity, headers?: Readonly<Record<string, string>>, sent?: Uint8Array) => Context,
    log: RequestLog,
    rateLimiter?: RateLimiter,
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

        const returned = await route.handle(parsed.data, context(plugin, identity, allowedHeaders(route, incoming.headers), sent));

        const reply = returned instanceof Reply ? returned : undefined;

        const filtered = route.output.safeParse(reply === undefined ? returned : reply.body);

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

            return { status, body: null, ...(reply !== undefined && { headers: filterHeaders(reply.headers, plugin, route, log) }) };
        }

        if (reply !== undefined)
        {
            return { status, body: filtered.data, headers: filterHeaders(reply.headers, plugin, route, log) };
        }

        return { status, body: filtered.data };
    }
    catch (cause)
    {
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

/** What a thrown thing says, in a shape that survives being written down. */
function logRecord(cause: unknown): Readonly<Record<string, unknown>>
{
    if (cause instanceof Error)
    {
        return {
            error: cause.message,
            kind: cause.name,
            ...(cause.stack !== undefined && { stack: cause.stack }),
            ...(cause.cause !== undefined && { cause: logRecord(cause.cause) }),
        };
    }

    return { error: String(cause) };
}

/** What a reply may say about itself without declaring it. Everything that governs how a browser treats the response is the kit's. */
const REPLY_HEADERS: ReadonlySet<string> = new Set([
    "location",
    "retry-after",
    "content-disposition",
    "vary",
    "etag",
    "cache-control",
    "x-session-key",
    "x-session-expires",
    "x-session-end",
]);

/** Headers the kit answers for: policy, framing, transport, sniffing, cookies and content type. */
const KIT_HEADERS: ReadonlySet<string> = new Set([
    "set-cookie",
    "content-type",
    "content-length",
    "transfer-encoding",
    "connection",
    "content-security-policy",
    "content-security-policy-report-only",
    "x-content-type-options",
    "x-frame-options",
    "referrer-policy",
    "strict-transport-security",
    "permissions-policy",
    "x-xss-protection",
    "x-permitted-cross-domain-policies",
    "x-dns-prefetch-control",
]);

/** Whether a header is one only the kit may set, CORS and the cross-origin family included. */
export function isKitHeader(name: string): boolean
{
    return KIT_HEADERS.has(name) || name.startsWith("access-control-") || name.startsWith("cross-origin-") || name.startsWith("sec-");
}

/** Directives that let a shared cache keep the body: fine for a public route, one caller's answer handed to the next for any other. */
const SHARED_CACHE = /(^|,)\s*(public|s-maxage|proxy-revalidate)\b/iu;

/** The headers a handler asked for, minus the ones it may not set. */
function filterHeaders(
    asked: Readonly<Record<string, string>>,
    plugin: string,
    route: Route<Context>,
    log: RequestLog,
): Readonly<Record<string, string>>
{
    const outgoing: Record<string, string> = {};

    for (const [name, value] of Object.entries(asked))
    {
        const lower = name.toLowerCase();

        if (!REPLY_HEADERS.has(lower) && !(route.sends ?? []).includes(lower))
        {
            log("warn", plugin, `${route.method} ${route.path} tried to set "${lower}", which it may not: declare it in sends, unless the kit answers for it`);

            continue;
        }

        if (/[\r\n]/.test(value))
        {
            log("warn", plugin, `${route.method} ${route.path} tried to set "${lower}" to a value carrying a newline`);

            continue;
        }

        if (lower === "cache-control" && route.public !== true && SHARED_CACHE.test(value))
        {
            log("warn", plugin, `${route.method} ${route.path} tried to let a shared cache keep an answer only its caller may see`);

            continue;
        }

        outgoing[lower] = value;
    }

    return outgoing;
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
