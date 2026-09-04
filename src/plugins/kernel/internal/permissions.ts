import type { Caller } from "./contract";

/**
 * What the caller of this request may do.
 *
 * Read from the caller every time rather than kept: one kernel serves every
 * request, and a cached list would answer for whoever asked before.
 *
 * A project decides what fills this. The kernel only compares it against what
 * a route declared, and never grants anything of its own.
 */
export function permissions(caller: () => Caller | undefined)
{
    const granted = (): ReadonlySet<string> =>
    {
        return new Set(caller()?.permissions ?? []);
    };

    return {
        has: (permission: string): boolean =>
        {
            return granted().has(permission);
        },

        all: (wanted: readonly string[]): boolean =>
        {
            const carries = granted();

            return wanted.every((one) => carries.has(one));
        },

        /**
         * What the project attached to this caller: a tenant, a role, a
         * session. Read back as it was given, and never interpreted here.
         *
         * The kernel cannot know what a tenant means, so it carries the value
         * and refuses to guess. A plugin scoping by tenant reads it and puts
         * it in its own queries.
         */
        claims: (): Readonly<Record<string, unknown>> =>
        {
            return caller()?.claims ?? {};
        },
    };
}
