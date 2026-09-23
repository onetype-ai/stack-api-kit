import { securityHeaders } from "./internal/headers";
import { requestId, serve, type ServerOptions } from "./internal/serve";
import { cookieIn, SessionHeaders, withSessionKey, type SessionOptions } from "./internal/session";
import { inProcessPubSub, relay } from "./internal/relay";
import { sockets, type Subscription } from "./internal/sockets";
import { currentRequestId } from "./internal/traced";
import { Locale } from "./internal/locale";
import { claimedName, isUploadedFile, type UploadedFile } from "./internal/upload";

/** The Hono app `serve` returns, with the kernel's routes, CORS and security headers already mounted. */
export type HonoApp = ReturnType<typeof serve>;

export { Locale, currentRequestId, securityHeaders, requestId, serve, sockets, inProcessPubSub, relay, cookieIn, SessionHeaders, withSessionKey, isUploadedFile, claimedName };
export type { Subscription, ServerOptions, SessionOptions, UploadedFile };

