/** A number that carries what it counts. */
export type Tagged<Unit extends string> = number & { readonly measure: Unit };

/** Names a unit, and answers the function that marks a number as one. */
export function measure<Unit extends string>(_unit: Unit)
{
    return (count: number): Tagged<Unit> => count as Tagged<Unit>;
}
