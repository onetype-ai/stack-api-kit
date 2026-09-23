# Changelog

## 8.1.0

### Changes you may notice

- A test kernel keeps an outbox unless `outbox: false`, as a deployment
  does: an event emitted outside `ctx.tx` is now refused in tests too.
- Every GET answering 200 carries a weak `etag`, and a matching
  `If-None-Match` answers 304. A test comparing a GET's whole answer sees
  the header.
- A reply may set only location, retry-after, content-disposition, vary,
  etag, cache-control and the session headers, plus what its route names in
  `sends`; any other header is dropped with a warning. A `public`,
  `s-maxage` or `proxy-revalidate` cache-control passes only on a public
  route.
- A redirect answered to `ctx.fetch` is still refused, now as NETWORK with
  the status; the built-in client asks fetch for redirects by hand.
- `Route.output` is optional in the type, and a route declaring none of
  `output`, `streams`, `document` or `file` is refused at startup.
- `Project.findAll()` counts `watchesWork` as a contract key: a project's
  contract procedure must name it.
- `HttpRequestError` is exported from the kernel as well as from `outbound`.

### Added

- `ctx.fetch` to `"anywhere"` resolves every answer and dials the address it
  checked (`lookup`); `detail.reason` on a refusal.
- `accepts: "stream"`, per-call `timeoutMs`, `idleMs` and `maxBytes`,
  `mostTimeoutMs` and `mostMaxBytes`.
- `redirects: "manual" | "follow"` and `mostRedirects` under `"anywhere"`.
- `Route.streams` (Server-Sent Events), `ServerEvent`, `Reply.events`,
  `ctx.signal`, `mostStreamsPerCaller`, `streamSeconds`, `streamDrainMs`.
- `Route.document` with `DocumentPolicy` and `Reply.document`.
- `Route.file` with `FileType` and `Reply.file`.
- `z.record` in output when its keys are a closed or anchored set.
- `Route.sends`, `Route.anyOrigin`, `accepts: "urlencoded"`.
- `reach: "identity"` with `ctx.push(…, { to })`, `ctx.presence.connected`,
  `Subscription.reidentify`.
- Job leases (`jobLeaseMs`, `jobRunMs`) and `schedule: "enqueue"`.
- Outbox redelivery to the listeners that missed an event, dead letters,
  `kernel.redeliver()`, `kernel.work.failedEvents()` and `retryFailed(id)`,
  `outboxLeaseMs`, `outboxBeatMs`.
- `watchesWork: true` and `ctx.work`.
- `GET /health` and `ServerOptions.readiness`.
- `configureTestKernels({ resolve })` and `withDependencies` in `./testing`.
- `procedures/answers.md` and `procedures/work.md`.

### Fixed

- A request carrying the session cookie and a body answered 500.
- A plugin with no tables could not open a transaction, so with an outbox
  it could not emit.
- A 204 answer now carries no body, and its session headers still become a
  cookie.
