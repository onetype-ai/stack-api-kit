// Readonly is erased at runtime: frozen, so a dependency cannot downgrade
// these on every later response.
/** What every response carries, whatever it answers. */
export const securityHeaders: Readonly<Record<string, string>> = Object.freeze({
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'",
});
