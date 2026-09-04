import { expect, test } from "vitest";

import { definePlugin } from "../../plugins/kernel/api";
import { booting } from "../booting";

test("a boot failure never blames the testing plugin", async () =>
{
    const listener = definePlugin("ledger", {
        version: "1.0.0",
        describe: "Hears about orders.",
        listens: { "orders.placed": { describe: "Records.", handle: () => undefined } },
    });

    const failed = await booting({ plugins: [listener] }).catch((cause: unknown) => cause) as Error;

    expect(failed.message).not.toContain("testing-ears");
    expect(failed.message).toContain('"orders" would declare it');
});
