import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { boundaries } from "./boundaries";
import { missing, oversized, undocumented, unexplained } from "./docs";
import { wiring } from "./wiring";

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

        return [
            ...Project.boundaries(checking.plugins ?? join(root, "src", "plugins")),
            ...Project.wiring(checking.plugins ?? join(root, "src", "plugins")),

            // Utils shared between plugins are checked too: a field nothing
            // reads is the same defect wherever it is declared, and code no
            // plugin owns is code nobody notices going stale.
            ...Project.wiring(checking.utils ?? join(root, "src", "utils"), false),
            ...Project.unexplained(checking.plugins ?? join(root, "src", "plugins")),
            ...Project.docs(root, docs, checking.required ?? Project.required, limit),
            ...Project.contract(checking.procedure ?? join(docs, "procedures", "plugin", "contract.md")),
        ];
    },

    boundaries: (at: string): ProjectProblem[] =>
    {
        return boundaries(at).map((wrong) => ({ check: "boundaries" as const, message: wrong.message }));
    },

    wiring: (at: string, apart = true): ProjectProblem[] =>
    {
        return wiring(at, apart).map((unread) => ({
            check: "wiring" as const,
            message: `${unread.file}: ${unread.shape}.${unread.field} is declared and nothing reads it.`,
        }));
    },

    unexplained: (at: string): ProjectProblem[] =>
    {
        return unexplained(at).map((name) => ({
            check: "unexplained" as const,
            message: `"${name}" has no usage.md. A plugin nobody can read is one nobody can depend on.`,
        }));
    },

    docs: (root: string, at: string, required: readonly string[], limit: number): ProjectProblem[] =>
    {
        return [
            ...oversized(at, limit).map((doc) => ({
                check: "oversized" as const,
                message: `${doc.path.replace(`${root}/`, "")} is ${String(doc.size)} characters, over ${String(limit)}.`,
            })),
            ...missing(root, required).map((path) => ({
                check: "missing" as const,
                message: `${path} is absent or says nothing.`,
            })),
        ];
    },

    contract: (procedure: string): ProjectProblem[] =>
    {
        return undocumented(readFileSync(CONTRACT, "utf8"), readFileSync(procedure, "utf8")).map((key) => ({
            check: "undocumented" as const,
            message: `The contract accepts "${key}" and ${procedure.split("/").slice(-1).join("")} never names it.`,
        }));
    },
};
