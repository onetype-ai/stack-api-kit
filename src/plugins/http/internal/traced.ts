import { AsyncLocalStorage } from "node:async_hooks";

/** The request the running code serves, for every line it logs to carry. */
const tracing = new AsyncLocalStorage<{ requestId: string }>();

/** Runs a request's work where every line logged within it can name the request. */
export function runTraced<Result>(requestId: string, work: () => Result): Result
{
    return tracing.run({ requestId }, work);
}

/** The id of the request the running code serves, or undefined outside one. */
export function currentRequestId(): string | undefined
{
    return tracing.getStore()?.requestId;
}
