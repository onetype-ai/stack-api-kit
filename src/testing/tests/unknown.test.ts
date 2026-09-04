import { expect, test } from "vitest";

import { definePlugin } from "../../plugins/kernel/api";
import { booting } from "../booting";

test("an option booting does not take is refused, not ignored", async () =>
{
    const plugin = definePlugin("thing", { version: "1.0.0", describe: "A thing." });

    await expect(booting({ plugins: [plugin], database: { file: "app.db" } } as never))
        .rejects.toThrow(/"database", which it does not take/);
});

test("and it names what it does take", async () =>
{
    const plugin = definePlugin("thing", { version: "1.0.0", describe: "A thing." });

    await expect(booting({ plugins: [plugin], scoped: true } as never))
        .rejects.toThrow(/plugins, config, answers, outbox, schedule, now/);
});
