import { timingSafeEqual } from "node:crypto";

// A normal string comparison returns as soon as two bytes differ, so how long
// it took says how much of the secret was right. Repeated a few thousand
// times, that recovers a token one character at a time.
//
// The lengths are compared first and separately: that is public anyway, and
// timingSafeEqual throws on a mismatch rather than answering false.
export function same(left: string, right: string): boolean
{
    const first = Buffer.from(left, "utf8");
    const second = Buffer.from(right, "utf8");

    if (first.length !== second.length)
    {
        return false;
    }

    return timingSafeEqual(first, second);
}
