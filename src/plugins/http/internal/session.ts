/** How a route's answer becomes a session cookie. */
export type SessionOptions = {
    /** The cookie's name. */
    name: string;

    /** Whether to mark it `Secure`. */
    secure: boolean;

    sameSite?: "Strict" | "Lax" | "None";

    /** Where the cookie applies. Defaults to the whole origin. */
    path?: string;

    domain?: string;
};

/** Before this, a number is a lifetime rather than a moment: 2001-09-09. */
const LEAST_MOMENT = 1_000_000_000_000;

/** What a route says about the session, and what never reaches the caller. */
export const SessionHeaders = {
    key: "x-session-key",

    /** When the session ends, in epoch milliseconds: `Date.now() + lifetime`. */
    expires: "x-session-expires",

    end: "x-session-end",
} as const;

/** One `set-cookie` line, or the one that clears it when seconds is zero. */
export function cookieFor(key: string, seconds: number, options: SessionOptions): string
{
    const parts = [
        `${options.name}=${encodeURIComponent(key)}`,
        `Path=${options.path ?? "/"}`,
        "HttpOnly",
        `SameSite=${options.sameSite ?? "Lax"}`,
        `Max-Age=${String(Math.max(0, Math.floor(seconds)))}`,
    ];

    if (options.domain !== undefined)
    {
        parts.push(`Domain=${options.domain}`);
    }

    if (options.secure || options.sameSite === "None")
    {
        parts.push("Secure");
    }

    return parts.join("; ");
}

/** Reads one cookie out of a request's header, by name. */
export function cookieIn(header: string | undefined, name: string): string | undefined
{
    for (const part of (header ?? "").split(";"))
    {
        const equals = part.indexOf("=");

        if (equals > 0 && part.slice(0, equals).trim() === name)
        {
            return decodeURIComponent(part.slice(equals + 1).trim());
        }
    }

    return undefined;
}

export type SessionResult = {
    cookie: string | undefined;
    headers: Readonly<Record<string, string>>;
};

/** What a route asked for, turned into a cookie and taken back out. */
export function sessionCookie(
    answered: Readonly<Record<string, string>>,
    options: SessionOptions,
    now: number,
): SessionResult
{
    const key = answered[SessionHeaders.key];
    const ending = answered[SessionHeaders.end];

    if (key === undefined && ending === undefined)
    {
        return { cookie: undefined, headers: answered };
    }

    const headers = { ...answered };

    delete headers[SessionHeaders.key];
    delete headers[SessionHeaders.expires];
    delete headers[SessionHeaders.end];

    if (key === undefined)
    {
        return { cookie: cookieFor("", 0, options), headers };
    }

    const expires = Number(answered[SessionHeaders.expires] ?? 0);

    if (Number.isFinite(expires) && expires > 0 && expires < LEAST_MOMENT)
    {
        throw new TypeError(`${SessionHeaders.expires} is a moment in epoch milliseconds, and ${String(expires)} is a lifetime. Send Date.now() + lifetime.`);
    }

    const seconds = Number.isFinite(expires) ? (expires - now) / 1000 : 0;

    return { cookie: cookieFor(key, seconds, options), headers };
}

/** The same request, carrying the key its cookie holds. */
export function withSessionKey(request: Request, options: SessionOptions | undefined): Request
{
    if (options === undefined || request.headers.has(SessionHeaders.key))
    {
        return request;
    }

    const key = cookieIn(request.headers.get("cookie") ?? undefined, options.name);

    if (key === undefined)
    {
        return request;
    }

    const headers = new Headers(request.headers);

    headers.set(SessionHeaders.key, key);

    return new Request(request, { headers });
}
