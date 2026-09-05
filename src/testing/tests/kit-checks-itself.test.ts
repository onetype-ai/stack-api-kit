import { join } from "node:path";
import { expect, test } from "vitest";

import { findMissingDocs, findOversizedDocs } from "../docs";
import { findUnusedFields } from "../wiring";

test("nothing this package declares goes unread", () =>
{
    expect(findUnusedFields(join(process.cwd(), "src"), false)).toEqual([]);
});

/* The document checks a project inherits, run on the package that ships them.
   findImportViolations is not among them: it reads an application's plugin.ts,
   and a kit plugin declares itself through api.ts instead. */
test("and the documents this package ships pass its own checks", () =>
{
    const root = process.cwd();

    expect(findMissingDocs(root, ["#docs/architecture.md", "README.md"])).toEqual([]);
    expect(findOversizedDocs(join(root, "#docs"))).toEqual([]);
});
