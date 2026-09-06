import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { findMissingDocs, findOversizedDocs } from "../docs";
import { Project } from "../project";
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

/* A project may pack its documents into one file. The checks that read code
   are not the ones that read #docs, so they must still run and still report:
   a document check that throws would take the boundary check down with it. */
test("the structural checks run on a project whose documents are packed away", () =>
{
    const root = mkdtempSync(join(tmpdir(), "packed-"));

    mkdirSync(join(root, "src", "plugins", "ghost"), { recursive: true });
    writeFileSync(join(root, "src", "plugins", "ghost", "thing.ts"), "export const thing = 1;\n");

    const problems = Project.checks({ root });

    expect(problems.map((problem) => problem.check)).toContain("boundaries");
});
