import type { Identity } from "./contract";

/** What the caller of this request may do. */
export function createPermissions(identity: () => Identity | undefined)
{
    const granted = (): ReadonlySet<string> =>
    {
        return new Set(identity()?.permissions ?? []);
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

        /**
         * What the project attached to this identity: a tenant, a role, a
         * session. Read back as it was given, and never interpreted here.
         */
        claims: (): Readonly<Record<string, unknown>> =>
        {
            return identity()?.claims ?? {};
        },
    };
}
