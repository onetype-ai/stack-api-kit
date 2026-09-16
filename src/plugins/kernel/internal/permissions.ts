import type { Identity } from "./contract";

/** What the caller of this request may do. */
export function createPermissions(identity: () => Identity | undefined)
{
    const granted = (): ReadonlySet<string> =>
    {
        const granted = identity()?.permissions;

        // identifies may be written in JavaScript: a string here becomes a set
        // of its letters, so "admin" granted "a" and every other single letter
        return Array.isArray(granted) ? new Set(granted.filter((each) => typeof each === "string")) : new Set<string>();
    };

    return {
        has: (permission: string): boolean =>
        {
            return granted().has(permission);
        },

        all: (wanted: readonly string[]): boolean =>
        {
            const carries = granted();

            return wanted.every((permission) => carries.has(permission));
        },

        /** Read back as it was given, and never interpreted here. */
        claims: (): Readonly<Record<string, unknown>> =>
        {
            return identity()?.claims ?? {};
        },
    };
}
