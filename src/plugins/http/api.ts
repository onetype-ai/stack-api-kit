import { securityHeaders } from "./internal/headers";
import { requestId, serve, type ServerOptions } from "./internal/serve";
import { cookieIn, SessionHeaders, type SessionOptions } from "./internal/session";
import { sockets, type Joined } from "./internal/sockets";
import { claimedName, isUpload, type Upload } from "./internal/upload";

export type Server = ReturnType<typeof serve>;

export { securityHeaders, requestId, serve, sockets, cookieIn, SessionHeaders, isUpload, claimedName };
export type { Joined, ServerOptions, SessionOptions, Upload };

