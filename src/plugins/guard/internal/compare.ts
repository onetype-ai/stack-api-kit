import { timingSafeEqual } from "node:crypto";

export function equalsInConstantTime(left: string, right: string): boolean
{
    const first = Buffer.from(left, "utf8");
    const second = Buffer.from(right, "utf8");

    if (first.length !== second.length)
    {
        return false;
    }

    return timingSafeEqual(first, second);
}
