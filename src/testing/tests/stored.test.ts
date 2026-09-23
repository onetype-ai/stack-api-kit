import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "vitest";
import { z } from "zod";

import { definePlugin, Stored } from "../../index";
import { StoredContracts } from "../storedContracts";

const lockAt = (): string => join(mkdtempSync(join(tmpdir(), "stored-")), "stored-contracts.lock.json");

const emitting = (payload: z.ZodType) => definePlugin("items", {
    version: "1.0.0",
    describe: "Announces an item.",
    emits: { "items.item.created": { describe: "An item was made.", schema: payload } },
});

describe("a schema that reads stored data, held to its lock", () =>
{
    const before = z.object({ id: z.string(), title: z.string() });

    test("takes a new field that is optional or defaulted", () =>
    {
        const lock = lockAt();

        StoredContracts.accept(lock, [emitting(before)]);

        expect(StoredContracts.checkFile(lock, [emitting(before.extend({ note: z.string().optional(), tags: z.array(z.string()).default([]) }))])).toEqual([]);
    });

    test.each([
        ["a new required field", before.extend({ owner: z.string() }), "new required field"],
        ["a removed field", z.object({ id: z.string() }), "removed field"],
        ["a narrowed type", z.object({ id: z.string(), title: z.number() }), "narrowed type"],
        ["a tighter bound", z.object({ id: z.string(), title: z.string().max(10) }), "narrowed maxLength"],
    ])("refuses %s, which an older row would fail", (_what, after, change) =>
    {
        const lock = lockAt();

        StoredContracts.accept(lock, [emitting(before)]);

        expect(StoredContracts.checkFile(lock, [emitting(after)])).toEqual([expect.objectContaining({ name: "event:items.item.created", change: expect.stringContaining(change) })]);
    });

    test("accepts a breaking change only when it is named with a reason, and keeps the reason", () =>
    {
        const lock = lockAt();
        const after = [emitting(before.extend({ owner: z.string() }))];

        StoredContracts.accept(lock, [emitting(before)]);

        expect(StoredContracts.accept(lock, after)).toHaveLength(1);
        expect(StoredContracts.accept(lock, after, { "event:items.item.created": "owner backfilled by migration 0007" })).toEqual([]);
        expect(StoredContracts.checkFile(lock, after)).toEqual([]);
    });

    test("holds a marked schema as it holds an event", () =>
    {
        const lock = lockAt();
        const settings = Stored.define("items.settings", z.object({ theme: z.string() }));

        StoredContracts.accept(lock, []);

        expect(StoredContracts.collect([])).toHaveProperty("items.settings");
        expect(() => Stored.define("items.settings", z.object({}))).toThrow("names two schemas");
        expect(settings).toBeDefined();
    });

    test("names the fix where there is no lock yet", () =>
    {
        expect(StoredContracts.checkFile(lockAt(), [])).toEqual([expect.objectContaining({ change: expect.stringContaining("StoredContracts.accept") })]);
    });
});
