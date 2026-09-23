import type { Context, Pipeline, PipelineStep } from "./contract";
import { KernelFault } from "./faults";

/** Where one step sits in a pipeline, and who put it there. */
export type ExplainedStep = {
    readonly id: string;
    readonly owner: string;
    readonly anchor?: { readonly before: string } | { readonly after: string } | undefined;
};

type Step = PipelineStep<Context>;

type Placed = ExplainedStep & { run: Step["run"] };

type Added = { plugin: string; step: Step };

const stopped = Symbol("stopped");

type Stopped = { [stopped]: true; result: unknown };

function anchorOf(step: Step): { before: string } | { after: string } | undefined
{
    if (step.before !== undefined)
    {
        return { before: step.before };
    }

    return step.after === undefined ? undefined : { after: step.after };
}

export function resolve(name: string, owner: string, pipeline: Pipeline<Context>, added: readonly Added[]): { placed: Placed[]; problems: string[] }
{
    const placed: Placed[] = pipeline.steps.map((step) => ({ id: step.id, owner, run: step.run }));
    const problems: string[] = [];
    const ids = new Set<string>();

    for (const step of [...placed, ...added.map(({ plugin, step: one }) => ({ id: one.id, owner: plugin }))])
    {
        if (ids.has(step.id))
        {
            problems.push(`Pipeline "${name}" has two steps named "${step.id}" (one from "${step.owner}"). Rename one.`);
        }

        ids.add(step.id);
    }

    for (const { plugin, step } of added)
    {
        if ((step.before === undefined) === (step.after === undefined))
        {
            problems.push(`Step "${step.id}" from "${plugin}" in pipeline "${name}" needs exactly one of before or after, naming the step it sits beside.`);
        }
        else if (!ids.has(step.before ?? step.after ?? ""))
        {
            problems.push(`Step "${step.id}" from "${plugin}" in pipeline "${name}" sits beside "${step.before ?? step.after}", which no step is named. Use an id from explain("${name}").`);
        }
    }

    if (problems.length > 0)
    {
        return { placed, problems };
    }

    // sorted, so a reader handed the plugins in any order (declarationsOf) places steps as start does
    let waiting = [...added].sort((first, second) => first.plugin.localeCompare(second.plugin) || first.step.id.localeCompare(second.step.id));
    const tails = new Map<string, string>();

    while (waiting.length > 0)
    {
        const left: Added[] = [];

        for (const one of waiting)
        {
            const { step, plugin } = one;
            const anchor = anchorOf(step);
            const beside = anchor !== undefined && "before" in anchor ? anchor.before : (anchor as { after: string }).after;
            const tail = "after" in (anchor ?? {}) ? tails.get(beside) ?? beside : beside;
            const at = placed.findIndex((each) => each.id === tail);

            if (at < 0)
            {
                left.push(one);

                continue;
            }

            placed.splice("before" in (anchor ?? {}) ? at : at + 1, 0, { id: step.id, owner: plugin, anchor, run: step.run });

            if ("after" in (anchor ?? {}))
            {
                tails.set(beside, step.id);
            }
        }

        if (left.length === waiting.length)
        {
            return { placed, problems: left.map(({ plugin, step }) => `Step "${step.id}" from "${plugin}" in pipeline "${name}" is in an anchor cycle. Anchor it to a step of "${owner}".`) };
        }

        waiting = left;
    }

    return { placed, problems };
}

export function pipelines()
{
    const declared = new Map<string, { owner: string; pipeline: Pipeline<Context>; added: Added[] }>();
    const resolved = new Map<string, Placed[]>();

    return {
        declare: (owner: string, name: string, pipeline: Pipeline<Context>): void =>
        {
            declared.set(name, { owner, pipeline, added: [] });
        },

        known: (name: string): boolean =>
        {
            return declared.has(name);
        },

        ownerOf: (name: string): string | undefined =>
        {
            return declared.get(name)?.owner;
        },

        add: (plugin: string, name: string, step: Step): void =>
        {
            declared.get(name)?.added.push({ plugin, step });
        },

        settle: (): string[] =>
        {
            const problems: string[] = [];

            for (const [name, { owner, pipeline, added }] of declared)
            {
                const answer = resolve(name, owner, pipeline, added);

                problems.push(...answer.problems);
                resolved.set(name, answer.placed);
            }

            return problems;
        },

        explain: (name: string): readonly ExplainedStep[] =>
        {
            const steps = resolved.get(name);

            if (steps === undefined)
            {
                throw new KernelFault("UNDECLARED_PIPELINE", `Pipeline "${name}" is not declared by any plugin.`);
            }

            return steps.map(({ id, owner, anchor }) => (anchor === undefined ? { id, owner } : { id, owner, anchor }));
        },

        run: async (name: string, input: unknown, contextOf: (plugin: string) => Context, trace: (step: string, ms: number, outcome: string) => void): Promise<unknown> =>
        {
            const one = declared.get(name);
            const steps = resolved.get(name);

            if (one === undefined || steps === undefined)
            {
                throw new KernelFault("UNDECLARED_PIPELINE", `Pipeline "${name}" is not declared by any plugin.`);
            }

            const entered = one.pipeline.input.safeParse(input);

            if (!entered.success)
            {
                throw new KernelFault("INVALID_PAYLOAD", `The input for pipeline "${name}" does not match its schema: ${entered.error.issues[0]?.message ?? "it was rejected"}.`, { plugin: one.owner });
            }

            let state: unknown = entered.data;
            const stop = (result: unknown): Stopped => ({ [stopped]: true, result });

            for (const step of steps)
            {
                const began = Date.now();
                let answer: unknown;

                try
                {
                    answer = await step.run(state as never, contextOf(step.owner), { stop });
                }
                catch (cause)
                {
                    trace(step.id, Date.now() - began, "threw");

                    throw new KernelFault("PIPELINE_FAILED", `Pipeline "${name}" stopped at step "${step.id}" from "${step.owner}": ${cause instanceof Error ? cause.message : String(cause)}`, { plugin: step.owner, cause });
                }

                if (typeof answer === "object" && answer !== null && stopped in answer)
                {
                    trace(step.id, Date.now() - began, "stopped");
                    state = (answer as Stopped).result;

                    break;
                }

                trace(step.id, Date.now() - began, "ok");
                state = answer;
            }

            const left = one.pipeline.output.safeParse(state);

            if (!left.success)
            {
                throw new KernelFault("INVALID_PAYLOAD", `Pipeline "${name}" answered what its output schema refuses: ${left.error.issues[0]?.message ?? "it was rejected"}. The last step to run must answer the output.`, { plugin: one.owner });
            }

            return left.data;
        },

        reset: (): void =>
        {
            declared.clear();
            resolved.clear();
        },
    };
}
