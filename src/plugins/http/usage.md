# http

## Description

The Hono app the kernel's routes are mounted on: body limits, security
headers, request ids, and one error shape.

## Purpose

Everything reaching the server crosses here, so the limits belong here rather
than in each route. A plugin that had to remember to bound a body is a plugin
that will forget once.

It carries no auth model. A project passes `identify`, which turns a request
into a caller; the kernel enforces what that caller may do.

## Usage

```ts
const app = serve({
    kernel,
    identify: (c) => Auth.session(kernel.context("auth"), c.req.header("cookie")),
    origins: ["https://app.example.com"],
});

export default { fetch: app.fetch, port: 3000 };
```

- Every kernel route is mounted with its method and path.
- A body over `bodyBytes` (1 MB by default) is refused before it is parsed,
  so a JSON bomb never reaches a parser.
- `identify` runs once per request. Throwing from it answers 401, never 500.
- Query and path parameters reach the route as one object, merged under the
  body, and the route's own input schema decides what any of it means. A
  header arrives only where the route named it in `reads`.
- Each response carries `x-request-id`, and every log line for that request
  carries the same one.

## Refuses

- An origin not in `origins`, with no CORS headers rather than permissive
  ones.
- A body that is not JSON when the method carries one.
- Anything the kernel refuses, in the kernel's own shape: `code`, `message`,
  and `fields` when an input schema named them.
