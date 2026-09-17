/** What a request carries, as far as reading a header goes. */
export type HeaderCarrier = { req: { header: (name: string) => string | undefined } };

/**
 * Who a rate limit counts an unknown caller by.
 *
 * `x-forwarded-for` is only read where a proxy is known to set it: with
 * nothing in front of the process a caller writes it themselves, and every
 * budget becomes one they can reset at will.
 */
export function from(behindProxy: boolean): (carrier: HeaderCarrier) => string
{
    return (carrier: HeaderCarrier): string =>
    {
        const forwarded = behindProxy
            ? carrier.req.header("x-forwarded-for")?.split(",")[0]?.trim()
            : undefined;

        return forwarded !== undefined && forwarded !== "" ? forwarded : "anonymous";
    };
}
