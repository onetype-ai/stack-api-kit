import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { findImportViolations } from "./boundaries";
import { findMissingDocs, findOversizedDocs, findUndocumentedKeys, findUnexplainedPlugins } from "./docs";
import { findUnusedFields } from "./wiring";

export type ProjectProblem = {
    check: "boundaries" | "wiring" | "oversized" | "missing" | "unexplained" | "undocumented";
    message: string;
};

export type ProjectCheckOptions = {
    root?: string;
    plugins?: string;

    /** Where pure code shared between plugins lives. */
    utils?: string;
    docs?: string;
    required?: readonly string[];
    procedure?: string;
    limit?: number;
};

/**
 * The kit's own contract, read to list the keys a plugin may declare.
 *
 * Two places because there are two shapes: the source tree when a project
 * links this package, and beside the bundle when it installed it.
 */
const CONTRACT = [
    join(dirname(fileURLToPath(import.meta.url)), "..", "plugins", "kernel", "internal", "contract.ts"),
    join(dirname(fileURLToPath(import.meta.url)), "contract.ts"),
].find((path) => existsSync(path)) ?? "";

export const Project = {
    required: ["#docs/usage.md", "#docs/stack.md", "#docs/architecture.md", "README.md"] as const,

    checks: (checking: ProjectCheckOptions = {}): ProjectProblem[] =>
    {
        const root = checking.root ?? process.cwd();
        const docs = checking.docs ?? join(root, "#docs");
        const limit = checking.limit ?? 1800;

        const procedure = checking.procedure ?? join(docs, "procedures", "plugin", "contract.md");

        // The structural checks read code and run always. The document ones
        // read #docs, which a project may have packed into one file: a packed
        // project is not an unchecked one, so their absence skips them rather
        // than throwing and taking the structural checks down with it.
        const written = existsSync(docs);

        return [
            ...Project.findImportViolations(checking.plugins ?? join(root, "src", "plugins")),
            ...Project.findUnusedFields(checking.plugins ?? join(root, "src", "plugins")),

            // Utils shared between plugins are checked too: a field nothing
            // reads is the same defect wherever it is declared, and code no
            // plugin owns is code nobody notices going stale.
            ...Project.findUnusedFields(checking.utils ?? join(root, "src", "utils"), false),
            ...Project.findUnexplainedPlugins(checking.plugins ?? join(root, "src", "plugins")),
            ...(written ? Project.docs(root, docs, checking.required ?? Project.required, limit) : []),
            ...(existsSync(procedure) ? Project.contract(procedure) : []),
        ];
    },

    findImportViolations: (at: string): ProjectProblem[] =>
    {
        return findImportViolations(at).map((wrong) => ({ check: "boundaries" as const, message: wrong.message }));
    },

    findUnusedFields: (at: string, apart = true): ProjectProblem[] =>
    {
        return findUnusedFields(at, apart).map((unread) => ({
            check: "wiring" as const,
            message: `${unread.file}: ${unread.shape}.${unread.field} is declared and nothing reads it.`,
        }));
    },

    findUnexplainedPlugins: (at: string): ProjectProblem[] =>
    {
        return findUnexplainedPlugins(at).map((name) => ({
            check: "unexplained" as const,
            message: `"${name}" has no usage.md. A plugin nobody can read is one nobody can depend on.`,
        }));
    },

    docs: (root: string, at: string, required: readonly string[], limit: number): ProjectProblem[] =>
    {
        return [
            ...findOversizedDocs(at, limit).map((doc) => ({
                check: "oversized" as const,
                message: `${doc.path.replace(`${root}/`, "")} is ${String(doc.size)} characters, over ${String(limit)}.`,
            })),
            ...findMissingDocs(root, required).map((path) => ({
                check: "missing" as const,
                message: `${path} is absent or says nothing.`,
            })),
        ];
    },

    contract: (procedure: string): ProjectProblem[] =>
    {
        return findUndocumentedKeys(readFileSync(CONTRACT, "utf8"), readFileSync(procedure, "utf8")).map((key) => ({
            check: "undocumented" as const,
            message: `The contract accepts "${key}" and ${procedure.split("/").slice(-1).join("")} never names it.`,
        }));
    },
};
