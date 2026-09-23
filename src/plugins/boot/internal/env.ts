/**
 * Every rule, over a value already read.
 *
 * Kept apart from the reading so a caller whose values arrive from somewhere
 * else — a bundler replacing `import.meta.env`, a config file — holds to the
 * same rules without a second implementation of them.
 */
export const rules = {
    text: (name: string, given: string | undefined, fallback?: string): string | undefined =>
    {
        if (given === undefined)
        {
            return fallback;
        }

        if (given.length === 0)
        {
            throw new Error(`${name} must be a non-empty string when it is set.`);
        }

        return given;
    },

    number: (name: string, given: string | undefined, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number =>
    {
        const value = rules.text(name, given);

        if (value === undefined)
        {
            return fallback;
        }

        const asNumber = value.trim() === "" ? Number.NaN : Number(value);

        if (!Number.isInteger(asNumber) || asNumber < min || asNumber > max)
        {
            throw new Error(`${name} must be a whole number from ${String(min)} to ${String(max)}. Received "${value}".`);
        }

        return asNumber;
    },

    flag: (name: string, given: string | undefined, fallback: boolean): boolean =>
    {
        const value = rules.text(name, given);

        if (value === undefined)
        {
            return fallback;
        }

        if (value !== "true" && value !== "false")
        {
            throw new Error(`${name} must be "true" or "false". Received "${value}".`);
        }

        return value === "true";
    },

    list: (given: string | undefined): readonly string[] =>
    {
        return (given ?? "")
            .split(",")
            .map((part) => part.trim())
            .filter(Boolean);
    },

    oneOf: <Allowed extends string>(name: string, given: string | undefined, allowed: readonly Allowed[], fallback: Allowed): Allowed =>
    {
        const value = rules.text(name, given, fallback) ?? fallback;

        if (!allowed.includes(value as Allowed))
        {
            throw new Error(`${name} must be one of ${allowed.join(", ")}. Received "${value}".`);
        }

        return value as Allowed;
    },
};

const read = (name: string): string | undefined => process.env[name];

/** Configuration read from `process.env`, refused by name rather than repaired; `rules` holds the same checks over a value read elsewhere. */
export const Env = {
    rules,

    text: (name: string, fallback?: string): string | undefined => rules.text(name, read(name), fallback),

    required: (name: string): string =>
    {
        const value = Env.text(name);

        if (value === undefined)
        {
            throw new Error(`${name} is required and was not set.`);
        }

        return value;
    },

    number: (name: string, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number =>
        rules.number(name, read(name), fallback, min, max),

    flag: (name: string, fallback: boolean): boolean => rules.flag(name, read(name), fallback),

    /** Whether this process runs as production: `NODE_ENV=production`. What must never happen there asks here itself, so no caller can vouch for it. */
    isProduction: (): boolean => read("NODE_ENV") === "production",

    /** Whether a plugin marked `fake` may run in production anyway: `ALLOW_FAKE=true`, a decision written where the deployment is. */
    allowsFake: (): boolean => rules.flag("ALLOW_FAKE", read("ALLOW_FAKE"), false),

    list: (name: string): readonly string[] => rules.list(read(name)),

    oneOf: <Allowed extends string>(name: string, allowed: readonly Allowed[], fallback: Allowed): Allowed =>
        rules.oneOf(name, read(name), allowed, fallback),
};
