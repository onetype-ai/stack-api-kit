import { equalsInConstantTime } from "./internal/compare";
import { limiter, type RateLimitResult, type RateLimitWindow } from "./internal/limit";
import { unlimited } from "./internal/unlimited";

export { limiter, unlimited, equalsInConstantTime };
export type { RateLimitResult, RateLimitWindow };

