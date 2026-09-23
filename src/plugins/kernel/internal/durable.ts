import { z } from "zod";

/** What a durable step's scheduled command carries: the run, never its input, which the store holds. */
export const StepJob = z.object({ runId: z.string().min(1) }).strict();

/** What a durable run's failure tells: where, never why, since a fault's message may carry what the step read. */
export const PipelineFailure = z.object({ runId: z.string().min(1), step: z.string().min(1), scope: z.string() }).strict();

/** What only the kernel reaches on a durable pipeline: the step its scheduled command runs, and what that step writes. */
export const ADVANCE = Symbol("advance a durable run");
export const KEEP = Symbol("keep a step's result");
export const FAIL = Symbol("fail a durable run");

export type DurableSteps = {
    [ADVANCE]: (runId: string) => Promise<void>;
    [KEEP]: (runId: string, step: string, kept: unknown, isLast: boolean) => Promise<void>;
    [FAIL]: (runId: string, step: string) => Promise<void>;
};
