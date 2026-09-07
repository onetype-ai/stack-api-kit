/**
 * How a route's answer becomes a session cookie.
 *
 * A plugin never sets `set-cookie`: it says who this session is for and how
 * long it lasts, and this turns that into whatever the deployment keeps a
 * session in. That boundary is what lets a mobile client holding a token use
 * the same routes unchanged.
 */
export type SessionOptions = {
    /** The cookie's name. */
    name: string;

    /**
     * Whether to mark it `Secure`.
     *
     * A browser drops a `Secure` cookie sent over http, so a deployment on
     * localhost that set this would never keep one.
     */
    secure: boolean;

    sameSite?: "Strict" | "Lax" | "None";

    /** Where the cookie applies. Defaults to the whole origin. */
    path?: string;

    domain?: string;
};

/** What a route says about the session, and what never reaches the caller. */
export const SessionHeaders = {
    key: "x-session-key",
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

    // SameSite=None is only honoured on a secure cookie, so a deployment
    // asking for one over http gets a cookie no browser keeps.
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
        const at = part.indexOf("=");

        if (at > 0 && part.slice(0, at).trim() === name)
        {
            return decodeURIComponent(part.slice(at + 1).trim());
        }
    }

    return undefined;
}

export type SessionAnswer = {
    cookie: string | undefined;
    headers: Readonly<Record<string, string>>;
};

/**
 * What a route asked for, turned into a cookie and taken back out.
 *
 * The key must not also leave on a header a script can read: keeping it in one
 * the browser will not hand over is the whole point.
 */
export function sessionCookie(
    answered: Readonly<Record<string, string>>,
    options: SessionOptions,
    now: number,
): SessionAnswer
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
    const seconds = Number.isFinite(expires) ? (expires - now) / 1000 : 0;

    return { cookie: cookieFor(key, seconds, options), headers };
}
