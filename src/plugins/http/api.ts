import { securityHeaders } from "./internal/headers";
import { requestId, serve, type ServerOptions } from "./internal/serve";
import { cookieIn, SessionHeaders, withSessionKey, type SessionOptions } from "./internal/session";
import { sockets, type Subscription } from "./internal/sockets";
import { currentRequestId } from "./internal/traced";
import { claimedName, isUploadedFile, type UploadedFile } from "./internal/upload";

/** The Hono app `serve` returns, with the kernel's routes, CORS and security headers already mounted. */
export type HonoApp = ReturnType<typeof serve>;

export { currentRequestId, securityHeaders, requestId, serve, sockets, cookieIn, SessionHeaders, withSessionKey, isUploadedFile, claimedName };
export type { Subscription, ServerOptions, SessionOptions, UploadedFile };

