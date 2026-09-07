# http

## Description

The Hono app the kernel's routes are mounted on: body limits, security
headers, request ids, sessions, forms, one error shape.

## Purpose

Everything reaching the server crosses here, so the limits belong here rather
than in each route: a plugin that had to bound a body will forget once. It
carries no auth model: `identify` turns a request into an identity, and the
kernel enforces what it may do.

## Usage

```ts
const app = serve({
    kernel,
    identify: (c) => Auth.session(ctx, cookieIn(c.req.header("cookie"), "app_session")),
    origins: ["https://app.example.com"],
    session: { name: "app_session", secure: true },
});

export default { fetch: app.fetch, port: 3000 };
```

- A body over `bodyBytes` (1 MB default) is refused before parsing, form
  included, so a bomb never reaches a parser.
- `identify` runs once per request; throwing answers 401, not 500.
- `session` turns a route's `x-session-key` (with `x-session-expires`) into a
  `HttpOnly` cookie and takes the headers back out; `x-session-end` clears
  one. Left out, they leave as they are, so a token client is unchanged.
- Query and path parameters reach the route as one object under the body; its
  input schema decides what any of it means. A header arrives only where the
  route named it in `reads`.
- `accepts: "form"` reads `multipart/form-data` through the platform: text
  parts become fields, file parts `Upload`s. A filename is the caller's claim,
  stripped of a path.
- Each response carries `x-request-id`, as does every log line for it.

## Refuses

- An origin not in `origins`, with no CORS headers rather than permissive.
- A body of the wrong kind, 415, or one that claims JSON and is not, 400.
- Anything the kernel refuses, in its own shape: `code`, `message`, `fields`.
