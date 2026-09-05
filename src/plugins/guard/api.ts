import { equalsInConstantTime } from "./internal/compare";
import { limiter, type Verdict, type Window } from "./internal/limit";

export type Limiter = ReturnType<typeof limiter>;

export { limiter, equalsInConstantTime };
export type { Verdict, Window };

