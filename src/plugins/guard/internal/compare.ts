import { timingSafeEqual } from "node:crypto";

/** Answers false on a length mismatch before comparing, because `timingSafeEqual` throws on unequal lengths, and that throw is itself a timing signal. */
export function equalsInConstantTime(left: string, right: string): boolean
{
    const leftBytes = Buffer.from(left, "utf8");
    const rightBytes = Buffer.from(right, "utf8");

    if (leftBytes.length !== rightBytes.length)
    {
        return false;
    }

    return timingSafeEqual(leftBytes, rightBytes);
}
