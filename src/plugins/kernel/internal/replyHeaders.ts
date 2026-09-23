import type { Context, Route } from "./contract";

type RequestLog = (level: "debug" | "info" | "warn" | "error", plugin: string, line: string, about?: Readonly<Record<string, unknown>>) => void;

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
export const SHARED_CACHE = /(^|,)\s*(public|s-maxage|proxy-revalidate)\b/iu;

/** The headers a handler asked for, minus the ones it may not set. */
export function filterHeaders(
    asked: Readonly<Record<string, string>>,
    plugin: string,
    route: Route<Context>,
    log: RequestLog,
    allowed: (name: string) => boolean = (name) => REPLY_HEADERS.has(name) || (route.sends ?? []).includes(name),
): Readonly<Record<string, string>>
{
    const outgoing: Record<string, string> = {};

    for (const [name, value] of Object.entries(asked))
    {
        const lower = name.toLowerCase();

        if (!allowed(lower))
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
