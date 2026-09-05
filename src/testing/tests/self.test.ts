import { join } from "node:path";
import { expect, test } from "vitest";

import { findUnusedFields } from "../wiring";

test("nothing this package declares goes unread", () =>
{
    expect(findUnusedFields(join(process.cwd(), "src"), false)).toEqual([]);
});
