import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { z } from "zod";

import { Stored } from "../plugins/kernel/api";

import type { Plugin } from "../plugins/kernel/api";

// JSON Schema as z.toJSONSchema writes it, read loosely: only the keywords a change can narrow.
type Shape = Readonly<Record<string, unknown>>;

export type Snapshots = Readonly<Record<string, Shape>>;

export type Accepted = { name: string; reason: string; at: string };

export type Lock = { version: 1; contracts: Snapshots; accepted: readonly Accepted[] };

export type Breach = { name: string; path: string; change: string };

const LOWER_BOUNDS = ["minLength", "minimum", "exclusiveMinimum", "minItems", "minProperties"] as const;
const UPPER_BOUNDS = ["maxLength", "maximum", "exclusiveMaximum", "maxItems", "maxProperties"] as const;
const FIXED = ["pattern", "format", "const"] as const;

const isShape = (value: unknown): value is Shape =>
{
    return typeof value === "object" && value !== null && !Array.isArray(value);
};

const sorted = (value: unknown): unknown =>
{
    if (Array.isArray(value))
    {
        return value.map(sorted);
    }

    if (isShape(value))
    {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
    }

    return value;
};

const typesOf = (shape: Shape): string[] | undefined =>
{
    const type = shape["type"];

    return typeof type === "string" ? [type] : Array.isArray(type) ? type.filter((each): each is string => typeof each === "string") : undefined;
};

const listOf = (value: unknown): readonly unknown[] =>
{
    return Array.isArray(value) ? value : [];
};

const same = (first: unknown, second: unknown): boolean =>
{
    return JSON.stringify(sorted(first)) === JSON.stringify(sorted(second));
};

/** What an older stored row would fail against today, found from the lock a project commits. */
export const StoredContracts = {
    // What stored data must satisfy to be read: the input side, where a defaulted field is optional.
    snapshot: (schema: z.ZodType): Shape =>
    {
        return sorted(z.toJSONSchema(schema, { io: "input", unrepresentable: "any" })) as Shape;
    },

    // Every schema that reads stored data: each declared event's payload (kept in the outbox), each
    // command's input (kept in the schedule until it runs), and each Stored.define.
    collect: (plugins: readonly Plugin[]): Record<string, Shape> =>
    {
        const snapshots: Record<string, Shape> = {};

        for (const plugin of plugins)
        {
            for (const [name, event] of Object.entries(plugin.definition.emits ?? {}))
            {
                snapshots[`event:${name}`] = StoredContracts.snapshot(event.schema);
            }

            for (const [name, command] of Object.entries(plugin.definition.commands ?? {}))
            {
                snapshots[`command:${name}`] = StoredContracts.snapshot(command.schema);
            }
        }

        for (const [name, schema] of Stored.all())
        {
            snapshots[name] = StoredContracts.snapshot(schema);
        }

        return snapshots;
    },

    // What a row written under `before` would fail to be read by under `after`, or would be read as something else.
    breaches: (name: string, before: Shape, after: Shape, path = "$"): Breach[] =>
    {
        const found: Breach[] = [];
        const breach = (change: string, at = path): void =>
        {
            found.push({ name, path: at, change });
        };

        if ("default" in before && (!("default" in after) || !same(before["default"], after["default"])))
        {
            breach("changed default");
        }

        const wasTyped = typesOf(before);
        const isTyped = typesOf(after);

        if (isTyped !== undefined && (wasTyped === undefined || wasTyped.some((type) => !isTyped.includes(type) && !(type === "integer" && isTyped.includes("number")))))
        {
            breach(`narrowed type ${JSON.stringify(wasTyped ?? "any")} to ${JSON.stringify(isTyped)}`);
        }

        if (Array.isArray(after["enum"]))
        {
            const allowed = listOf(after["enum"]);
            const lost = Array.isArray(before["enum"]) ? listOf(before["enum"]).filter((value) => !allowed.some((each) => same(each, value))) : ["anything"];

            if (lost.length > 0)
            {
                breach(`narrowed enum, no longer taking ${JSON.stringify(lost)}`);
            }
        }

        for (const key of LOWER_BOUNDS)
        {
            const was = before[key];
            const is = after[key];

            if (typeof is === "number" && (typeof was !== "number" || is > was))
            {
                breach(`narrowed ${key} to ${String(is)}`);
            }
        }

        for (const key of UPPER_BOUNDS)
        {
            const was = before[key];
            const is = after[key];

            if (typeof is === "number" && (typeof was !== "number" || is < was))
            {
                breach(`narrowed ${key} to ${String(is)}`);
            }
        }

        for (const key of FIXED)
        {
            if (key in after && !same(before[key], after[key]))
            {
                breach(`narrowed ${key}`);
            }
        }

        if (after["additionalProperties"] === false && before["additionalProperties"] !== false)
        {
            breach("refuses fields it used to take");
        }

        const wasProperties = isShape(before["properties"]) ? before["properties"] : {};
        const isProperties = isShape(after["properties"]) ? after["properties"] : {};
        const wasRequired = new Set(listOf(before["required"]));
        const isRequired = new Set(listOf(after["required"]));

        for (const [field, shape] of Object.entries(wasProperties))
        {
            const next = isProperties[field];

            if (!isShape(next))
            {
                breach("removed field", `${path}.${field}`);
                continue;
            }

            if (isRequired.has(field) && !wasRequired.has(field))
            {
                breach("made a field required", `${path}.${field}`);
            }

            if (isShape(shape))
            {
                found.push(...StoredContracts.breaches(name, shape, next, `${path}.${field}`));
            }
        }

        for (const field of Object.keys(isProperties))
        {
            if (!(field in wasProperties) && isRequired.has(field))
            {
                breach("new required field", `${path}.${field}`);
            }
        }

        if (isShape(before["items"]) && isShape(after["items"]))
        {
            found.push(...StoredContracts.breaches(name, before["items"], after["items"], `${path}[]`));
        }

        for (const key of ["anyOf", "oneOf"] as const)
        {
            const was = listOf(before[key]).filter(isShape);
            const is = listOf(after[key]).filter(isShape);

            for (const option of was)
            {
                const kept = is.some((each) => StoredContracts.breaches(name, option, each).length === 0);

                if (is.length > 0 && !kept)
                {
                    breach(`dropped a ${key} option`);
                }
            }
        }

        return found;
    },

    // Every breach between the lock and today: a schema that disappeared counts too.
    check: (lock: Lock, today: Readonly<Record<string, Shape>>): Breach[] =>
    {
        const found: Breach[] = [];

        for (const [name, before] of Object.entries(lock.contracts))
        {
            const after = today[name];

            if (after === undefined)
            {
                found.push({ name, path: "$", change: "no schema reads it any more" });
                continue;
            }

            found.push(...StoredContracts.breaches(name, before, after));
        }

        return found;
    },

    /** Every breach between the lock file and these plugins; no lock is one breach naming how to write it. */
    checkFile: (lockFile: string, plugins: readonly Plugin[]): Breach[] =>
    {
        if (!existsSync(lockFile))
        {
            return [{ name: "*", path: "$", change: `no lock at ${lockFile}: write one with StoredContracts.accept` }];
        }

        return StoredContracts.check(JSON.parse(readFileSync(lockFile, "utf8")) as Lock, StoredContracts.collect(plugins));
    },

    /**
     * Rewrites the lock from today's schemas. A change an older row would fail against is refused unless each such
     * schema is named in `breaking` with why, and the migration that carries old rows over; the reason is kept in the lock.
     */
    accept: (lockFile: string, plugins: readonly Plugin[], breaking: Readonly<Record<string, string>> = {}): Breach[] =>
    {
        const today = StoredContracts.collect(plugins);
        const before: Lock = existsSync(lockFile) ? JSON.parse(readFileSync(lockFile, "utf8")) as Lock : { version: 1, contracts: {}, accepted: [] };
        const refused = StoredContracts.check(before, today).filter((breach) => (breaking[breach.name] ?? "").trim().length < 10);

        if (refused.length > 0)
        {
            return refused;
        }

        const at = new Date().toISOString();
        const accepted = [...before.accepted, ...Object.entries(breaking).map(([name, reason]) => ({ name, reason, at }))];

        writeFileSync(lockFile, `${JSON.stringify({ version: 1, contracts: sorted(today), accepted }, null, 4)}\n`);

        return [];
    },
};
