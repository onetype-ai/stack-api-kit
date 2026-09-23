/** Which cross-origin callers are answered, and what they are allowed. */
export type CorsPolicy = {
    origins: readonly string[];
    methods: readonly string[];
    headers: readonly string[];
    maxAge: number;

    /** Response headers a page may read: a browser hides every other but a handful. */
    exposes: readonly string[];
};

/** The CORS headers for one request. */
export function cors(policy: CorsPolicy, origin: string | undefined): Readonly<Record<string, string>>
{
    if (origin === undefined || !policy.origins.includes(origin))
    {
        return { vary: "Origin" };
    }

    return {
        "access-control-allow-origin": origin,
        "access-control-allow-credentials": "true",
        "access-control-allow-methods": policy.methods.join(", "),
        "access-control-allow-headers": policy.headers.join(", "),
        "access-control-max-age": String(policy.maxAge),
        ...(policy.exposes.length > 0 && { "access-control-expose-headers": policy.exposes.join(", ") }),
        vary: "Origin",
    };
}
