/** Postgres's answer to every statement after one failed in the same transaction. */
function isAborted(cause: unknown): boolean
{
    return typeof cause === "object" && cause !== null && ((cause as { code?: unknown }).code === "25P02" || String((cause as { message?: unknown }).message ?? "").includes("current transaction is aborted"));
}

/**
 * A driver client that remembers the first statement to fail through it. Postgres refuses every statement after a
 * failure until the transaction ends, so the error a caller sees is often that refusal, and the cause is gone.
 */
export function watchingFailures<Client extends object>(client: Client): { client: Client; explained: (cause: unknown) => unknown }
{
    let first: unknown;

    const watched = new Proxy(client, {
        get: (target, property, receiver) =>
        {
            const value: unknown = Reflect.get(target, property, receiver);

            if (property !== "query" || typeof value !== "function")
            {
                return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
            }

            return (...args: unknown[]) =>
            {
                const answered = (value as (...given: unknown[]) => unknown).apply(target, args);

                if (answered instanceof Promise)
                {
                    return answered.catch((cause: unknown) =>
                    {
                        first ??= isAborted(cause) ? undefined : cause;

                        throw cause;
                    });
                }

                return answered;
            };
        },
    });

    return {
        client: watched,
        explained: (cause) =>
        {
            if (!isAborted(cause) || first === undefined)
            {
                return cause;
            }

            const reason = first instanceof Error ? first.message : String(first);

            return new Error(`A statement failed inside this transaction (${reason}), and Postgres refuses every statement after it until the transaction ends. Let that failure end the transaction, or avoid it: onConflictDoNothing rather than catching a duplicate.`, { cause: first });
        },
    };
}
