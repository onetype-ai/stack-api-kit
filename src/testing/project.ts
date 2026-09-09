import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { findCopiedVocabulary, findImportViolations, findSharedNames, findSplitVocabulary } from "./boundaries";
import { findMissingDocs, findOversizedDocs, findUndocumentedKeys, findUnexplainedPlugins } from "./docs";
import { findUnusedFields } from "./wiring";

export type ProjectProblem = {
    check: "boundaries" | "wiring" | "oversized" | "missing" | "unexplained" | "undocumented" | "twice" | "split";
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

    /**
     * Signatures two plugins may each keep, because they answer different questions.
     *
     * Written as the signature itself, so an entry names what it excuses and
     * goes stale loudly when the signature changes rather than quietly.
     */
    sharing?: readonly string[];

    /**
     * Enum names two plugins may each declare, where the two are not one idea.
     *
     * A word means what its domain says: a Role among accounts and a Role in
     * a conversation share nothing but the word.
     */
    apart?: readonly string[];

    /**
     * Plugins that may leave the process, each named on purpose.
     *
     * A plugin whose whole job is to run a program is not a defect, and a
     * check with no way to say so would have the application delete the
     * capability to go green. Writing the name here is the declaration the
     * contract cannot hold: it sits in the repository, in a file a reviewer
     * reads, rather than in nobody's memory.
     */
    leaving?: readonly string[];
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

        const procedure = checking.procedure ?? join(docs, "procedures", "plugin", "contract.md");

        return [
            ...Project.findImportViolations(checking.plugins ?? join(root, "src", "plugins"), checking.leaving ?? []),
            ...Project.findUnusedFields(checking.plugins ?? join(root, "src", "plugins")),

            // Utils shared between plugins are checked too: a field nothing
            // reads is the same defect wherever it is declared, and code no
            // plugin owns is code nobody notices going stale.
            ...Project.findUnusedFields(checking.utils ?? join(root, "src", "utils"), false),
            ...Project.findUnexplainedPlugins(checking.plugins ?? join(root, "src", "plugins")),
            ...Project.findSharedNames(checking.plugins ?? join(root, "src", "plugins"), checking.sharing ?? []),
            ...Project.findSplitVocabulary(checking.plugins ?? join(root, "src", "plugins"), checking.apart ?? []),
            ...Project.findCopiedVocabulary(checking.plugins ?? join(root, "src", "plugins"), checking.apart ?? []),
            ...(existsSync(procedure) ? Project.contract(procedure) : []),
        ];
    },

    findImportViolations: (at: string, leaving: readonly string[] = []): ProjectProblem[] =>
    {
        return findImportViolations(at)
            .filter((wrong) => !(wrong.rule === "escape" && leaving.some((name) => wrong.message.startsWith(`${name}/`))))
            .map((wrong) => ({ check: "boundaries" as const, message: wrong.message }));
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

    findCopiedVocabulary: (at: string, excused: readonly string[] = []): ProjectProblem[] =>
    {
        return findCopiedVocabulary(at)
            .filter((copied) => !excused.includes(copied.name))
            .map((copied) => ({
                check: "split" as const,
                message: `${copied.file} writes out [${copied.values.join(", ")}] where "${copied.owner}" declares the same set as ${copied.name}. A copy with no name is one nothing compares: the day ${copied.owner} adds a member, this one keeps refusing it. Reach for ${copied.owner}'s through dependsOn, or name it in "apart" if the two are not one idea.`,
            }));
    },

    findSplitVocabulary: (at: string, excused: readonly string[] = []): ProjectProblem[] =>
    {
        return findSplitVocabulary(at)
            .filter((split) => !excused.includes(split.name))
            .map((split) => ({
                check: "split" as const,
                message: `${split.plugins.join(" and ")} each declare an enum named "${split.name}", and the two do not agree on what it may be: both hold ${split.shared.join(", ")}, and ${split.apart.join(", ")} sits in one alone. ${split.files.join(", ")}. One idea in two places drifts, and the day one gains a value the other refuses a payload carrying it. Let one declare it and the other reach for it, or name them apart. If they are genuinely two ideas, name it in "apart".`,
            }));
    },

    findSharedNames: (at: string, excused: readonly string[] = []): ProjectProblem[] =>
    {
        return findSharedNames(at)
            .filter((shared) => !excused.includes(shared.signature))
            .map((shared) => ({
                check: "twice" as const,
                message: `${shared.plugins.length} plugins each write "${shared.signature}": ${shared.files.join(", ")}. A util a second plugin asks for belongs in src/utils, where one answer serves both. If the two answer different questions, say so in the signature, or name it in "sharing".`,
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
