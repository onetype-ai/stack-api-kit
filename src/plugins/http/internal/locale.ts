import { KernelFault } from "../../kernel/api";

/** One candidate a caller named, with how much they want it. */
type Wanted = { tag: string; weight: number; at: number };

/** The tags an Accept-Language header names, heaviest first, ties in header order, `q=0` and `*` left out. */
function wantedOf(accepted: string | readonly string[]): string[]
{
    if (typeof accepted !== "string")
    {
        return [...accepted];
    }

    const wanted: Wanted[] = [];

    accepted.split(",").forEach((part, at) =>
    {
        const [tag = "", ...parameters] = part.trim().split(";");
        const q = parameters.map((parameter) => /^\s*q=([0-9.]+)\s*$/u.exec(parameter)?.[1]).find((value) => value !== undefined);
        const weight = q === undefined ? 1 : Number(q);

        if (tag.trim() !== "" && tag.trim() !== "*" && Number.isFinite(weight) && weight > 0)
        {
            wanted.push({ tag: tag.trim(), weight, at });
        }
    });

    return wanted.sort((first, second) => second.weight - first.weight || first.at - second.at).map((each) => each.tag);
}

/**
 * Which locale to answer in: the stored choice when it is supported, else each wanted tag in turn, exact
 * (case-insensitive) before language-only (`de-AT` finds `de`, `de` finds the first `de-*`), else the fallback.
 * The same contract, and the same cases, as the app kit's.
 */
export const Locale = {
    negotiate: (accepted: string | readonly string[], supported: readonly string[], fallback: string, chosen?: string): string =>
    {
        const lower = (tag: string): string => tag.toLowerCase();

        if (!supported.some((tag) => lower(tag) === lower(fallback)))
        {
            throw new KernelFault("INVALID_CONFIG", `Locale.negotiate was given fallback "${fallback}", which is not among supported (${supported.join(", ")}). Name one of them.`);
        }

        const exact = (tag: string): string | undefined => supported.find((each) => lower(each) === lower(tag));

        if (chosen !== undefined && exact(chosen) !== undefined)
        {
            return exact(chosen) as string;
        }

        for (const tag of wantedOf(accepted))
        {
            const language = lower(tag).split("-")[0] ?? "";
            const found = exact(tag) ?? supported.find((each) => lower(each) === language) ?? supported.find((each) => lower(each).split("-")[0] === language);

            if (found !== undefined)
            {
                return found;
            }
        }

        return exact(fallback) as string;
    },
};
