import { isIP } from "node:net";

/** What stands in for what a line may not carry. */
export const REDACTED = "[redacted]";

/**
 * Keys whose value is a credential, matched with case and separators removed, so `api_key`, `apiKey` and
 * `X-Api-Key` are one key. Broad on purpose: a key redacted for nothing costs a field, a key missed costs a secret.
 */
const SECRET_KEYS = [/pass(word|wd|phrase)?$/u, /pwd$/u, /secret/u, /token/u, /key$/u, /^auth(?!or)/u, /authoriz/u, /cookie/u, /session/u, /credential/u, /signature/u, /^sig$/u, /jwt/u, /bearer/u, /otp$/u];

/** Keys whose value is a person's address or contact: masked only where the project asks, since some keep them. */
const PERSONAL_KEYS = [/email/u, /phone/u, /^ip$/u, /^ip(address|v4|v6)$/u, /(client|remote|peer|source)(ip|address)$/u, /forwardedfor$/u];

/** A count of something sensitive is not the thing: `promptTokens`, `tokenCount`, `keyLength`. */
const COUNT = /(tokens|count|total|length|size|ms|seconds)$/u;

/** Credentials found inside a value: every reader of the line would read them too. */
const SECRET_VALUES: readonly (readonly [RegExp, string])[] = [
    [/\bBearer\s+[^\s"',;]+/giu, "Bearer [redacted]"],
    [/\beyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]*/gu, "[jwt]"],
    [/\b(sk|pk|rk)[-_](live|test|proj)?[-_]?[A-Za-z0-9]{12,}\b/gu, "[secret]"],
    [/([?&;\s](?:access_token|refresh_token|id_token|token|api_key|apikey|key|password|secret|signature|sig|code)=)[^&\s"']+/giu, "$1[redacted]"],
];

const EMAIL = /[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+\.[a-z]{2,}/giu;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/gu;
const IPV6_CANDIDATE = /\[?[0-9a-f]*:[0-9a-f:]*:[0-9a-f.]*\]?/giu;

/** What a log line keeps back: credentials always, a person's details where asked. */
export type RedactionOptions = {
    personal?: boolean;
};

function plainKey(key: string): string
{
    return key.toLowerCase().replace(/[^a-z0-9]/gu, "");
}

/** Whether a field of this name is not to be written. */
export function isHiddenKey(key: string, options: RedactionOptions = {}): boolean
{
    const plain = plainKey(key);

    if (options.personal === true && PERSONAL_KEYS.some((pattern) => pattern.test(plain)))
    {
        return true;
    }

    return !COUNT.test(plain) && SECRET_KEYS.some((pattern) => pattern.test(plain));
}

/** Text with the credentials in it masked, and a person's email and address where asked. */
export function maskText(text: string, options: RedactionOptions = {}): string
{
    const masked = SECRET_VALUES.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), text);

    if (options.personal !== true)
    {
        return masked;
    }

    return masked.replace(EMAIL, "[email]").replace(IPV4, "[ip]").replace(IPV6_CANDIDATE, (candidate) => isIP(candidate.replace(/^\[|\]$/gu, "")) === 6 ? "[ip]" : candidate);
}

/** A value made safe to write: hidden keys replaced, text masked, an error read apart, every level walked once. */
export function redact(value: unknown, options: RedactionOptions = {}, seen: WeakSet<object> = new WeakSet()): unknown
{
    if (typeof value === "string")
    {
        return maskText(value, options);
    }

    if (typeof value !== "object" || value === null)
    {
        return value;
    }

    if (seen.has(value))
    {
        return "[circular]";
    }

    seen.add(value);

    if (value instanceof Error)
    {
        return {
            message: maskText(value.message, options),
            ...(value.stack !== undefined && { stack: maskText(value.stack, options) }),
            ...(value.cause !== undefined && { cause: redact(value.cause, options, seen) }),
        };
    }

    if (Array.isArray(value))
    {
        return value.map((item: unknown) => redact(item, options, seen));
    }

    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, isHiddenKey(key, options) ? REDACTED : redact(item, options, seen)]));
}
