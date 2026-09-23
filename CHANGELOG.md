# Changelog

## 9.0.0 (unreleased)

### Breaking

- `ctx.commands.later` is refused outside `ctx.tx` (`UNKEPT_JOB`), on every
  database. The job is now written by the transaction that asks for it,
  before it commits: it exists exactly when the work it belongs to does.
- `Outbox.save` and `Schedule.save` return a Promise, awaited before the
  commit. A save that fails takes the transaction down with it.
- `Store.migrate` and `Store.close` return Promises.
- `createKernel` with a `schedule` and no `db` is refused at start
  (`UNSTORED_SCHEDULE`): a job is written by a transaction, and a
  transaction needs a store.
- `store.migrate` inside an open transaction is refused
  (`JOINED_TRANSACTION`) rather than silently joining it.
- SQLite older than 3.39 is refused when the database opens
  (`UNSUPPORTED_DATABASE`).

- A plugin's migrations live in `migrations/sqlite/` and `migrations/postgres/`,
  chosen by the deployment's dialect. One folder of files runs on SQLite
  alone; Postgres refuses it with the fix.

### How to convert

`#docs/procedures/dialects.md` is the rule the conversion follows.


- A `later` outside a transaction, in a route, a listener, a command or
  `setup`, moves inside one:

  ```ts
  await ctx.tx(async (inside) =>
  {
      inside.commands.later("items.archive", { id }, 3600);
  });
  ```

  Put it in the transaction that writes the work it belongs to, where there
  is one.
- A store of your own: `migrate` and `close` return Promises, and an outbox
  or schedule of your own returns one from `save`.
- A test calling `store.migrate(...)` or `store.close()` awaits it.
- A kernel of your own with a `schedule` passes `db` too; in a test, a store
  whose `tx` only runs the work will do.
- Tables: `sqliteTable(...)` becomes `table(...)` from `./tables`, each
  column made with `column.*`; a time in ms is `column.timeMs`, a boolean
  `column.boolean`, JSON `column.json<Shape>()`. Then move the migration
  files into `migrations/sqlite/` and generate `migrations/postgres/` with
  drizzle-kit. A query ending in `.get()` becomes `const [row] = await ...`,
  `.all()` and `.run()` become a plain `await`.

### Added

- Several processes on one Postgres server serve one application: `ctx.push`
  reaches every process's sockets, `ctx.presence` counts them all, and a
  dead letter put back is delivered by any process at once. They hear each
  other through LISTEN/NOTIFY (`postgresPubSub`), or `start({ pubsub })`
  with an exported `PubSub` of a project's own; `inProcessPubSub` for one
  process.
- `openApi({ plugins, stands, clock, seed })` in `/testing`, the API twin of
  the app kit's `openApp`: a test kernel with stand-ins by the name they
  replace, a test clock, a seed, and `call(identity, method, path, input)`.
- `@onetype/stack-api-kit/tables`: `table`, `column`, `index`,
  `uniqueIndex`, `dialect` and `PortableDb`. One definition for SQLite and
  Postgres, built for the dialect the process uses (`KIT_DIALECT`, else a
  Postgres `DATABASE_URL`, else SQLite).
- Migration file names drizzle-kit generates, `NNNN_name.sql`.
- `postgres({ url, poolSize } | { pglite, schema })`: the same store over a
  Postgres server (a pool; each transaction holds a client of its own, and
  claims take any other) or PGlite (one connection, like SQLite). `pg` and
  `@electric-sql/pglite` are optional peers.
- The kit's own suites run on SQLite and, where they reach a store, on PGlite
  (`tools/matrix.mjs` names each). What only a server shows, two workers
  claiming at once, runs with `pnpm test:pg` against `KIT_PG_URL`
  (`infra/remote-verify.sh --with-pg`), and fails without it.
- `Project` checks `[migrations]` (a step in one dialect's folder and not
  the other's) and `[dialect]` (`.get()`, `.all()` or `.run()` on a query,
  which only SQLite answers, with what to write instead).

- Durable pipelines (`#docs/procedures/durable-pipelines.md`):
  `flavour: "durable"` runs each step as scheduled work with its `result`
  stored, resumes after a crash, dedupes a run by `key`, hands each step an
  `idempotencyKey`, and fails past `retries` with `<pipeline>.failed`.
  `ctx.pipeline(name)` gains `status` and `retry`.
- Tenant and exposed registries (`#docs/procedures/tenant-registries.md`):
  `scope: "tenant"` keeps entries per scope in the database through
  `ctx.scopedRegistry(name)`, changed only inside `ctx.tx`, announced as
  `<registry>.changed`; `expose` serves `GET /registries/<name>` and pushes
  each change on `registry.<name>`.
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
