/**
 * What every response carries, whatever it answers.
 *
 * An API serves data, not documents, so these are the ones that still mean
 * something: the browser protections that matter for a page are set by
 * whatever serves the page.
 *
 * - nosniff stops a browser guessing a content type it was already told.
 * - DENY in frame-options and frame-ancestors 'none' keeps an error page out
 *   of someone else's iframe.
 * - no-store keeps an authenticated answer out of a shared cache. An API
 *   response is per-caller, and a cache that kept one would hand it to the
 *   next.
 * - no-referrer keeps a path with an id in it from reaching another origin.
 */
export const always: Readonly<Record<string, string>> = {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
};
