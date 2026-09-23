import type { z } from "zod";

const registered = new Map<string, z.ZodType>();

/**
 * Schemas that read what was written earlier: a JSON column, a published document. A row written under
 * yesterday's schema is read with today's, so a project's stored-contract check holds each to its lock.
 * Event payloads and command inputs need no marking: they are held to it as declared.
 */
export const Stored = {
    /** Marks a schema as one that reads stored data, under a name unique in the process: `"<plugin>.<thing>"`. */
    define: <Schema extends z.ZodType>(name: string, schema: Schema): Schema =>
    {
        const held = registered.get(name);

        if (held !== undefined && held !== schema)
        {
            throw new TypeError(`Stored.define: "${name}" names two schemas. Give each stored schema its own name, such as "<plugin>.<thing>".`);
        }

        registered.set(name, schema);

        return schema;
    },

    /** Every schema marked so far. */
    all: (): ReadonlyMap<string, z.ZodType> =>
    {
        return registered;
    },
};

/** Forgets every stored schema marked so far, for a test worker that keeps its modules across files. */
export function forgetStored(): void
{
    registered.clear();
}

