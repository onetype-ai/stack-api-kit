import type { Kernel, RegisteredRoute } from "../plugins/kernel/internal/kernel";

/** One finding from any `Started` check, written out as a sentence a person can act on; `check` says which check spoke. */
export type StartedProblem = {
    check: "unbounded";
    message: string;
};

export type StartedCheckOptions = {
    /** Routes deliberately left without a budget, each named `METHOD /path` on purpose. */
    unbounded?: readonly string[];
};

const named = (route: RegisteredRoute): string => `${route.method} ${route.path}`;

/**
 * Checks that need a kernel already started, each answering `StartedProblem[]`.
 *
 * `Project` reads files and says what a plugin declared; this reads what those
 * declarations became once every plugin was brought up together.
 *
 * Most of what a project would check here, `start` already refuses: a
 * permission no plugin declares, one belonging to a plugin nobody depends on,
 * a route reading a header that carries a credential. What is left is the one
 * thing the kit cannot decide for a project, because the right budget for a
 * route is the project's to know.
 */
export const Started = {
    findAll: (kernel: Kernel, checking: StartedCheckOptions = {}): StartedProblem[] =>
    {
        return Started.findUnboundedRoutes(kernel, checking.unbounded ?? []);
    },

    /** Where a closed route carries no budget, so one caller may spend the whole process on it. */
    findUnboundedRoutes: (kernel: Kernel, excused: readonly string[] = []): StartedProblem[] =>
    {
        return kernel.routes()
            .filter((route) => !route.public && route.limit === undefined)
            .filter((route) => !excused.includes(named(route)))
            .map((route) => ({
                check: "unbounded" as const,
                message: `${named(route)} is closed and carries no limit. Give it one, or name it in \`unbounded\` to say the cost is meant.`,
            }));
    },
};
