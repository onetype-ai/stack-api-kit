# Changelog

## 9.0.0 (unreleased)

### Added

- `openApi({ plugins, stands, clock, seed })` in `/testing`, the API twin of
  the app kit's `openApp`: a test kernel with stand-ins by the name they
  replace, a test clock, a seed, and `call(identity, method, path, input)`.
- Registries and pipelines, the same contract as the app kit
  (`#docs/procedures/registries-and-pipelines.md`): `registries`,
  `pipelines` and `adds` on a plugin, `ctx.registry(name)`,
  `ctx.pipeline(name)` and `kernel.explain(name)`. A pipeline runs in the
  caller's context and opens no transaction. A runtime `set` is held by
  one process until pub/sub carries it.
- `declarationsOf` reads each plugin's `registries`, `adds` and
  `pipelines`, a pipeline's steps in the order start runs them.

### Changes you may notice

- `Context` and `Declaration` gain those members. A hand-built `Context`
  (a test fake) needs `registry` and `pipeline` to compile.

## 8.2.0

8.1.0 was never published; everything it held is here.

### Changes you may notice

- A test kernel asked for no outbox runs without one, as in 8.0, and says
  once per process (a `STACK_API_KIT_TEST_OUTBOX` warning) that 9.0 turns
  it on. Pass `outbox: true` to test as a deployment with an outbox runs.
- Every GET answering 200 carries a weak `etag`, and a matching
  `If-None-Match` answers 304. A test comparing a GET's whole answer sees
  the header.
- A reply still sends every header 8.0 sent, and each one the allow-list
  will drop in 9.0 is named once in the log. `strictReplyHeaders: true`
  (on `start`, `createKernel` or a test kernel) holds replies to it now:
  location, retry-after, content-disposition, vary, etag, cache-control and
  the session headers, plus what a route names in `sends`.
- A reply's own cache-control now reaches the wire; a `public`, `s-maxage`
  or `proxy-revalidate` one passes only on a public route.
- A redirect answered to `ctx.fetch` is still refused, now as NETWORK with
  the status; the built-in client asks fetch for redirects by hand.
- `Route.output` is optional in the type, and a route declaring none of
  `output`, `streams`, `document` or `file` is refused at startup.
- `Project.findAll()` does not yet ask a project's contract procedure to
  name `watchesWork`; from 9.0 it will, as for every other key.
- `HttpRequestError` is exported from the kernel as well as from `outbound`.
- `/ws` identifies the socket on upgrade, as a request is identified, and
  speaks a protocol a client relies on: `$ready`, an answer to every
  subscribe (`subscribed` or `CHANNEL_REFUSED`), `$ping`, and close codes
  4000 (lifetime), 4001 (signed out), 4003 (origin), 1009, 1012, 1013 after
  `$backoff`. A socket that was allowed at connect is identified again
  every 30 s.
- With `session` configured, a write carrying the session cookie in any
  type but JSON, from an origin not in `origins`, answers 403.
- `Server.from(false)` counts an unknown caller by its socket address rather
  than one shared "anonymous".
- Every request leaves one access line, and every line logged while serving
  it carries `requestId`; `accessLog: false` turns the line off.
- `Log.line` never writes a credential, by key or by shape.
- `flush()` waits for every listener an emit started.
- `commands.later` outside a transaction still stores the job, and warns
  once per command: 9.0 refuses it. Call it inside `ctx.tx`.

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
- `configureTestKernels({ resolve })` and `withDependencies` in `./testing`;
  `resolve` is given the names missing, wave by wave, each asked once, and
  `defaults` (outbox, strictReplyHeaders, schedule, sockets) apply to every
  test kernel in the process where a test does not say.
- `procedures/answers.md`, `procedures/work.md` and `procedures/operations.md`.
- `Server.from({ trustedProxies })`, `Server.closeOnce`, `Server.socketsOf`,
  and `sockets` limits and `trustedProxies` on `Server.open`; a socket's
  caller is resolved by the http side's `from` first, so both count alike.
- `ctx.scope`; a plugin without tables may declare a scope naming none.
- `new Refusal(…, { retryAfter })`; `limit.key`.
- `access-control-expose-headers` (retry-after, x-request-id, etag,
  content-disposition), `ServerOptions.exposes`.
- `kernel.settled()`.
- `currentRequestId()`, `redact()`, `Log.forLevel(level, { personal })`.
- `Stored.define`, and `StoredContracts` in `./testing`.
- `Egress.check(url)`, `Reply.csv(rows, { columns, filename })`.
- `Env.isProduction()`, `Env.allowsFake()`, `fake: true` refused in
  production; `testClock()` in `./testing`.
- `http.clientLogs`, `http.hsts`.
- `Locale.negotiate`.
- `Project.required` is read, and `Project.required` suggests a list.

### Fixed

- A request carrying the session cookie and a body answered 500.
- A plugin with no tables could not open a transaction, so with an outbox
  it could not emit.
- A 204 answer now carries no body, and its session headers still become a
  cookie.
- `createScopeFilter` compared against another plugin's column when two
  plugins named a table alike.
- `/ws` took frames up to 100 MiB.
- `findUnscopedReach` reported a row built with `ctx.stamped` and written as
  `.values(row)`.
