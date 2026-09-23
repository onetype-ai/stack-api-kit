/** What a thrown thing says, in a shape that survives being written down. */
export function logRecord(cause: unknown): Readonly<Record<string, unknown>>
{
    if (cause instanceof Error)
    {
        return {
            error: cause.message,
            kind: cause.name,
            ...(cause.stack !== undefined && { stack: cause.stack }),
            ...(cause.cause !== undefined && { cause: logRecord(cause.cause) }),
        };
    }

    return { error: String(cause) };
}
