import { expect, test } from "vitest";
import { z } from "zod";

import { definePlugin } from "../../plugins/kernel/api";
import { booting } from "../booting";

test("a test drives its own clock and asks for what is due", async () =>
{
    const ran: string[] = [];
    let clock = 1_000_000;

    const plugin = definePlugin("holds", {
        version: "1.0.0",
        describe: "Releases a hold later.",
        commands: {
            "holds.release": {
                describe: "Releases one.",
                schema: z.object({ id: z.string() }),
                run: (input) => { ran.push((input as { id: string }).id); },
            },
        },
    });

    const api = await booting({ plugins: [plugin], schedule: true, now: () => clock });

    api.kernel.context("holds").commands.later("holds.release", { id: "one" }, 600);

    await api.due();

    expect(ran).toEqual([]);

    clock += 601_000;

    await api.due();

    expect(ran).toEqual(["one"]);

    await api.stop();
});
