/**
 * A number that carries what it counts.
 *
 * Two plugins exchanging a bare `number` agree on a unit nobody wrote down,
 * and the compiler endorses whatever they meant. That is not hypothetical:
 * one project counted storage in bytes, read a quota in gigabytes, and
 * refused every caller on their first file. The types were right the whole
 * time.
 */
export type Measured<Unit extends string> = number & { readonly measure: Unit };

/**
 * Names a unit, and answers the function that marks a number as one.
 *
 * The kit knows no units: a project names its own, and two of them are
 * different types from that moment on.
 *
 * ```ts
 * const bytes = measure("bytes");
 * const gigabytes = measure("gigabytes");
 *
 * type Bytes = ReturnType<typeof bytes>;
 * ```
 *
 * Comparison, interpolation and division all work as they do on a number.
 * Adding two answers a number, so a sum says its unit again — which is the
 * point: a total of bytes and gigabytes should not compile either.
 */
export function measure<Unit extends string>(_unit: Unit)
{
    return (many: number): Measured<Unit> => many as Measured<Unit>;
}
