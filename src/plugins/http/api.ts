import { securityHeaders } from "./internal/headers";
import { requestId, serve, type ServerOptions } from "./internal/serve";

export type Server = ReturnType<typeof serve>;

export { securityHeaders, requestId, serve };
export type { ServerOptions };

