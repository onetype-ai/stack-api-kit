# http

## Description

The Hono app the kernel's routes are mounted on: body limits, security
headers, request ids, sessions, forms, errors.

## Purpose

Everything reaching the server crosses here, so the limits live here, not in
each route. No auth model: `identify` turns a request into an identity.

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

- A body over `bodyBytes` (1 MB) is refused before anything parses it.
- `identify` runs once per request; a throw answers 401.
- `session` turns a route's `x-session-key` (with `x-session-expires`) into a
  `HttpOnly` cookie, `x-session-end` clears it. Left out, they pass as sent.
- Query and path parameters reach the route as one object over the body,
  with no prototype; its input schema decides what it means.
- `accepts: "form"` reads `multipart/form-data`: file parts become
  `UploadedFile`s, a filename stripped of a path. `"urlencoded"` reads string
  fields, a repeated name as a list; `keepsRaw` keeps the bytes to verify.
- `/live`, `/health` answer 200; `/ready` answers `readiness()`, 503 when
  not ready or it throws (`procedures/operations.md`).
- Each response and every line logged serving it carry `x-request-id`; one
  access line per request names the route's pattern.

## Refuses

- An origin not in `origins`, with no CORS headers; a non-JSON write carrying
  the session cookie from such an origin, 403 (another page could send it).
- A body of the wrong kind, 415; bad JSON, 400.
- Anything the kernel refuses, in its own shape: `code`, `message`, `fields`.
