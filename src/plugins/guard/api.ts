import { equalsInConstantTime } from "./internal/compare";
import { limiter, type Verdict, type Window } from "./internal/limit";
import { unlimited } from "./internal/unlimited";

export type Limiter = ReturnType<typeof limiter>;

export { limiter, unlimited, equalsInConstantTime };
export type { Verdict, Window };

