import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { findCopiedVocabulary, findImportViolations, findSharedNames, findSplitVocabulary, findUnscopedReach } from "./boundaries";
import { findMissingDocs, findOversizedDocs, findUndocumentedKeys, findUnexplainedPlugins } from "./docs";
import { findMigrationDrift, findSqliteOnlyCalls } from "./dialects";
import { findUnusedFields } from "./wiring";

/** One finding from any `Project` check, already written out as a sentence a person can act on; `check` says which check spoke. */
export type ProjectProblem = {
    check: "boundaries" | "wiring" | "oversized" | "missing" | "unexplained" | "undocumented" | "twice" | "split" | "unscoped" | "migrations" | "dialect";
    message: string;
};

export type ProjectCheckOptions = {
    root?: string;
    plugins?: string;

    /** Where pure code shared between plugins lives. */
    utils?: string;
    docs?: string;
    /** Documents this project asks itself to hold, read from `root`; none unless named. `Project.required` is the kit's suggestion. */
    required?: readonly string[];
    procedure?: string;
    limit?: number;

    /** Signatures two plugins may each keep, because they answer different questions. */
    sharing?: readonly string[];

    /** Enum names two plugins may each declare, where the two are not one idea. */
    apart?: readonly string[];

    /** Plugins that may leave the process, each named on purpose. */
    leaving?: readonly string[];
};

/** The kit's own contract, read to list the keys a plugin may declare. */
const CONTRACT = [
    join(dirname(fileURLToPath(import.meta.url)), "..", "plugins", "kernel", "internal", "contract.ts"),
    join(dirname(fileURLToPath(import.meta.url)), "contract.ts"),
].find((path) => existsSync(path)) ?? "";

/** Files a tool folds a folder into, so their size says nothing about a reader. */
const PACKED = new Set(["docs.md", "README.md"]);

/** Every project-wide check in one object, each answering `ProjectProblem[]`; `findAll` runs the lot against sensible defaults and answers an empty array when a project is clean. */
export const Project = {
    /** What a project is suggested to require of itself, the same list the app kit names. */
    required: ["#docs/usage.md", "#docs/architecture.md"] as const,

    findAll: (checking: ProjectCheckOptions = {}): ProjectProblem[] =>
    {
        const root = checking.root ?? process.cwd();
        const docs = checking.docs ?? join(root, "#docs");

        const procedure = checking.procedure ?? join(docs, "procedures", "plugin", "contract.md");

        return [
            ...Project.findImportViolations(checking.plugins ?? join(root, "src", "plugins"), checking.leaving ?? []),
            ...Project.findUnusedFields(checking.plugins ?? join(root, "src", "plugins")),
            ...Project.findUnscopedReach(checking.plugins ?? join(root, "src", "plugins")),
            ...Project.findMigrationDrift(checking.plugins ?? join(root, "src", "plugins")),
            ...Project.findSqliteOnlyCalls(checking.plugins ?? join(root, "src", "plugins")),

            ...Project.findUnusedFields(checking.utils ?? join(root, "src", "utils"), false),
            ...Project.findUnexplainedPlugins(checking.plugins ?? join(root, "src", "plugins")),
            ...Project.findSharedNames(checking.plugins ?? join(root, "src", "plugins"), checking.sharing ?? []),
            ...Project.findSplitVocabulary(checking.plugins ?? join(root, "src", "plugins"), checking.apart ?? []),
            ...Project.findCopiedVocabulary(checking.plugins ?? join(root, "src", "plugins"), checking.apart ?? []),
            ...(existsSync(procedure) ? Project.findUndocumentedKeys(procedure) : []),

            ...Project.findOversizedDocs(root, checking.limit ?? 1800),

            ...findMissingDocs(root, checking.required ?? []).map((path) => ({
                check: "missing" as const,
                message: `${path} is absent or says nothing, and this project asks itself for it.`,
            })),
        ];
    },

    findImportViolations: (root: string, leaving: readonly string[] = []): ProjectProblem[] =>
    {
        return findImportViolations(root)
            .filter((wrong) => !(wrong.rule === "escape" && leaving.some((name) => wrong.message.startsWith(`${name}/`))))
            .map((wrong) => ({ check: "boundaries" as const, message: wrong.message }));
    },

    /** Where a scoped table is reached without narrowing, which returns another tenant's rows with nothing reporting it. */
    findUnscopedReach: (root: string): ProjectProblem[] =>
    {
        return findUnscopedReach(root).map((reached) => ({ check: "unscoped" as const, message: reached.message }));
    },

    /** Where a plugin's SQLite and Postgres migrations went apart: a numbered step in one dialect's folder and not the other's. */
    findMigrationDrift: (root: string): ProjectProblem[] =>
    {
        return findMigrationDrift(root).map((drift) => ({ check: "migrations" as const, message: drift.message }));
    },

    /** Where a query ends in `.get()`, `.all()` or `.run()`, which only SQLite answers, with the portable replacement. */
    findSqliteOnlyCalls: (root: string): ProjectProblem[] =>
    {
        return findSqliteOnlyCalls(root).map((call) => ({ check: "dialect" as const, message: call.message }));
    },

    findUnusedFields: (root: string, apart = true): ProjectProblem[] =>
    {
        return findUnusedFields(root, apart).map((unread) => ({
            check: "wiring" as const,
            message: `${unread.file}: ${unread.shape}.${unread.field} is declared and nothing reads it.`,
        }));
    },

    findUnexplainedPlugins: (root: string): ProjectProblem[] =>
    {
        return findUnexplainedPlugins(root).map((name) => ({
            check: "unexplained" as const,
            message: `"${name}" has no usage.md. A plugin nobody can read is one nobody can depend on.`,
        }));
    },

    findCopiedVocabulary: (root: string, excused: readonly string[] = []): ProjectProblem[] =>
    {
        return findCopiedVocabulary(root)
            .filter((copied) => !excused.includes(copied.name))
            .map((copied) => ({
                check: "split" as const,
                message: `${copied.file} writes out [${copied.values.join(", ")}] where "${copied.owner}" declares the same set as ${copied.name}. A copy with no name is one nothing compares: the day ${copied.owner} adds a member, this one keeps refusing it. Reach for ${copied.owner}'s through dependsOn, or name it in "apart" if the two are not one idea.`,
            }));
    },

    findSplitVocabulary: (root: string, excused: readonly string[] = []): ProjectProblem[] =>
    {
        return findSplitVocabulary(root)
            .filter((split) => !excused.includes(split.name))
            .map((split) => ({
                check: "split" as const,
                message: `${split.plugins.join(" and ")} each declare an enum named "${split.name}", and the two do not agree on what it may be: both hold ${split.shared.join(", ")}, and ${split.apart.join(", ")} sits in one alone. ${split.files.join(", ")}. One idea in two places drifts, and the day one gains a value the other refuses a payload carrying it. Let one declare it and the other reach for it, or name them apart. If they are genuinely two ideas, name it in "apart".`,
            }));
    },

    findSharedNames: (root: string, excused: readonly string[] = []): ProjectProblem[] =>
    {
        return findSharedNames(root)
            .filter((shared) => !excused.includes(shared.signature))
            .map((shared) => ({
                check: "twice" as const,
                message: `${shared.plugins.length} plugins each write "${shared.signature}": ${shared.files.join(", ")}. A util a second plugin asks for belongs in src/utils, where one answer serves both. If the two answer different questions, say so in the signature, or name it in "sharing".`,
            }));
    },

    findOversizedDocs: (root: string, limit: number): ProjectProblem[] =>
    {
        return findOversizedDocs(root, limit)
            .filter((doc) => !PACKED.has(basename(doc.path)))
            .map((doc) => ({
                check: "oversized" as const,
                message: `${doc.path.replace(`${root}/`, "")} is ${String(doc.size)} characters, over ${String(limit)}.`,
            }));
    },

    findUndocumentedKeys: (procedure: string): ProjectProblem[] =>
    {
        return findUndocumentedKeys(readFileSync(CONTRACT, "utf8"), readFileSync(procedure, "utf8")).map((key) => ({
            check: "undocumented" as const,
            message: `The contract accepts "${key}" and ${procedure.split("/").slice(-1).join("")} never names it.`,
        }));
    },
};
