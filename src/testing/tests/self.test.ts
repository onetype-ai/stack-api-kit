import { join } from "node:path";
import { expect, test } from "vitest";

import { wiring } from "../wiring";

test("nothing this package declares goes unread", () =>
{
    expect(wiring(join(process.cwd(), "src"), false)).toEqual([]);
});
