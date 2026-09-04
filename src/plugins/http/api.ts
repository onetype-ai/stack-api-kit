import { always } from "./internal/headers";
import { identifier, serve, type Serving } from "./internal/serve";

export type Server = ReturnType<typeof serve>;

export { always, identifier, serve };
export type { Serving };

