# @onetype/stack-api-kit

## Functions

> The last segment of a claimed filename, and nothing that walks anywhere.
### claimedName(name: string): string

> Reads one cookie out of a request's header, by name.
### cookieIn(header: string | undefined, name: string): string | undefined

> Builds a kernel from what the plugins declared.
### createKernel(options: KernelOptions): Kernel

> Turns a declared scope into a condition.
### createScopeFilter(tablesByPlugin: Readonly<Record<string, Readonly<Record<string, unknown>>>>): ScopeFilter

> The id of the request the running code serves, or undefined outside one.
### currentRequestId(): string | undefined

> Opens a database and holds one handle per plugin over it.
### database(settings: StoreOptions): Store<DrizzleDb>

> Reads what the given plugins declare; a name narrows it to that one.
### declarationsOf(plugins: readonly Plugin[], name?: string): Declaration[]

> Declares one command, with its input typed by its own schema.
### defineCommand<PluginContext = Context>(): <Input extends z.ZodType>(command: Command<PluginContext, Input>) => Command<PluginContext, Input>

> Declares one listener, with its payload typed by the event's own schema.
### defineListener<PluginContext = Context>(): <Payload extends z.ZodType>(_schema: Payload, listener: Listener<PluginContext, z.infer<Payload>>) => Listener<PluginContext, z.infer<Payload>>

> Declares one participant, with its payload typed by the hook's schema.
### defineParticipant<PluginContext = Context>(): <Payload extends z.ZodType>(_schema: Payload, participant: Participant<PluginContext, z.infer<Payload>>) => Participant<PluginContext, z.infer<Payload>>

> Declares a plugin.
### definePlugin<Schema extends z.ZodType, Services = unknown, Db = unknown>(name: string, definition: Definition<Schema, Services, Db>): Plugin

> Declares one route, with its input typed by its own schema.
### defineRoute<PluginContext = Context>(): <Input extends z.ZodType>(route: Route<PluginContext, Input>) => Route<PluginContext, Input>

> Takes a bundler's glob of modules and throws on the first one with no default export, where `discoverFrom` would collect it into `skipped` instead; the result is sorted by plugin name.
### discover(modules: PluginModules): Plugin[]

> The same discovery for a project with no bundler to glob for it.
### discoverFrom(folder: string): Promise<DiscoveryResult>

> The dial's own check, for the moment an address is saved: a row whose url passes here is one the
> kernel will reach, and one refused here would be refused at the dial, by the same rules. The name is
> resolved now; the dial checks it again, since what it resolves to may change.
### Egress: { check: (url: string, lookup?: Lookup) => Promise<EgressVerdict> }
    check: (url: string, lookup?: Lookup) => Promise<EgressVerdict>

> Configuration read from `process.env`, refused by name rather than repaired; `rules` holds the same checks over a value read elsewhere.
### Env: { rules: { text: (name: string, given: string | undefined, fallback?: string) => string | undefined; number: (name: string, given: string | undefined, fallback: number, min?: number, max?: number) => number; flag: (name: string, given: string | undefined, fallback: boolean) => boolean; list: (given: string | undefined) => readonly string[]; oneOf: <Allowed extends string>(name: string, given: string | undefined, allowed: readonly Allowed[], fallback: Allowed) => Allowed }; text: (name: string, fallback?: string) => string | undefined; required: (name: string) => string; number: (name: string, fallback: number, min?: number, max?: number) => number; flag: (name: string, fallback: boolean) => boolean; /** Whether this process runs as production: `NODE_ENV=production`. What must never happen there asks here itself, so no caller can vouch for it. */ isProduction: () => boolean; /** Whether a plugin marked `fake` may run in production anyway: `ALLOW_FAKE=true`, a decision written where the deployment is. */ allowsFake: () => boolean; list: (name: string) => readonly string[]; oneOf: <Allowed extends string>(name: string, allowed: readonly Allowed[], fallback: Allowed) => Allowed }
    rules: {
    text: (name: string, given: string | undefined, fallback?: string) => string | undefined
    number: (name: string, given: string | undefined, fallback: number, min?: number, max?: number) => number
    flag: (name: string, given: string | undefined, fallback: boolean) => boolean
    list: (given: string | undefined) => readonly string[]
    oneOf: <Allowed extends string>(name: string, given: string | undefined, allowed: readonly Allowed[], fallback: Allowed) => Allowed
    }
    text: (name: string, fallback?: string) => string | undefined
    required: (name: string) => string
    number: (name: string, fallback: number, min?: number, max?: number) => number
    flag: (name: string, fallback: boolean) => boolean
    // Whether this process runs as production: `NODE_ENV=production`. What must never happen there asks here itself, so no caller can vouch for it.
    isProduction: () => boolean
    // Whether a plugin marked `fake` may run in production anyway: `ALLOW_FAKE=true`, a decision written where the deployment is.
    allowsFake: () => boolean
    list: (name: string) => readonly string[]
    oneOf: <Allowed extends string>(name: string, allowed: readonly Allowed[], fallback: Allowed) => Allowed

> Answers false on a length mismatch before comparing, because `timingSafeEqual` throws on unequal lengths, and that throw is itself a timing signal.
### equalsInConstantTime(left: string, right: string): boolean

> Builds the outbound caller: it follows no redirects, reads at most `maxBytes`, gives up after `timeoutMs`, dials the address it is pinned to when given one, and throws `HttpRequestError` for every failure including a non-2xx status.
### httpClient(options?: HttpClientOptions): HttpClient

> What a schema names a file field as, so `z.custom` can check it.
### isUploadedFile(value: unknown): value is UploadedFile

> Every level, in order, for a caller reading one from configuration.
### LEVELS: readonly ["debug", "info", "warn", "error"]

> An in-process counter: `spend` allows and counts, `refund` gives one back, `sweep` drops expired keys, `size` reports how many are held; it is per-process, so a second server counts its own.
### limiter(now?: () => number): { spend: (key: string, window: RateLimitWindow) => RateLimitResult; refund: (key: string) => void; sweep: () => number; size: () => number }
    spend: (key: string, window: RateLimitWindow) => RateLimitResult
    refund: (key: string) => void
    sweep: () => number
    size: () => number

> Which locale to answer in: the stored choice when it is supported, else each wanted tag in turn, exact
> (case-insensitive) before language-only (`de-AT` finds `de`, `de` finds the first `de-*`), else the fallback.
> The same contract, and the same cases, as the app kit's.
### Locale: { negotiate: (accepted: string | readonly string[], supported: readonly string[], fallback: string, chosen?: string) => string }
    negotiate: (accepted: string | readonly string[], supported: readonly string[], fallback: string, chosen?: string) => string

> One JSON object a line, written to stdout; a line never throws while being written.
### Log: { levels: readonly ["debug", "info", "warn", "error"]; severity: Readonly<Record<Level, number>>; line: (level: Level, message: string, about?: Readonly<Record<string, unknown>>, options?: RedactionOptions) => string; forJson: (_key: string, value: unknown) => unknown; /** A logger writing at `level` and above; `personal: true` also masks emails and addresses, keys and values alike. */ forLevel: (level?: Level, options?: RedactionOptions) => Logger }
    levels: readonly ["debug", "info", "warn", "error"]
    severity: Readonly<Record<Level, number>>
    line: (level: Level, message: string, about?: Readonly<Record<string, unknown>>, options?: RedactionOptions) => string
    forJson: (_key: string, value: unknown) => unknown
    // A logger writing at `level` and above; `personal: true` also masks emails and addresses, keys and values alike.
    forLevel: (level?: Level, options?: RedactionOptions) => Logger

> Names a unit, and answers the function that marks a number as one.
### measure<Unit extends string>(_unit: Unit): (count: number) => Tagged<Unit>

> Where events wait, in the same database as the work they announce. The process writing a row holds it for
> `leaseMs` while it delivers; a row one listener refused waits out a backoff and is claimed again, by this process
> or another, for the listeners that have not heard it.
### outbox(connection: Database.Database, settings?: { leaseMs?: number }): Outbox
    leaseMs?: number

> A value made safe to write: hidden keys replaced, text masked, an error read apart, every level walked once.
### redact(value: unknown, options?: RedactionOptions, seen?: WeakSet<object>): unknown

> What the caller is told about a failure.
### refusalBodyFor(cause: unknown): RefusalBody

> Answers the caller's `x-request-id` only when it is 1-64 of `[A-Za-z0-9_-]`, and a fresh UUID otherwise, so a caller cannot write arbitrary text into every log line.
### requestId(header: string | undefined): string

> Where later work waits, in the same database as the work that asked for it.
> A claim is a lease: the process renews it while the command runs, and a lease nobody renewed
> means the process died, so the job is taken again and the lost run counted. Only the holder of
> a claim may finish or put back what it claimed.
### schedule(connection: Database.Database, settings?: { leaseMs?: number }): Schedule
    leaseMs?: number

> What every response carries, whatever it answers.
### securityHeaders: Readonly<Record<string, string>>

> Builds the Hono app the kernel's routes are mounted on.
### serve(options: ServerOptions): Hono

> A started kernel, put on a port and taken off one cleanly.
### Server: { from: typeof from; listen: typeof listen; watch: typeof watch; /** A stop that runs once, closing every socket 1012 first, for a caller stopping without a signal. */ closeOnce: typeof closeOnce; /** The sockets a listening server holds, for `closeOnce` to close. */ socketsOf: typeof socketsOf; open: (api: StartedApp, options: OpenOptions) => void }
    from: typeof from
    listen: typeof listen
    watch: typeof watch
    // A stop that runs once, closing every socket 1012 first, for a caller stopping without a signal.
    closeOnce: typeof closeOnce
    // The sockets a listening server holds, for `closeOnce` to close.
    socketsOf: typeof socketsOf
    open: (api: StartedApp, options: OpenOptions) => void

> What a route says about the session, and what never reaches the caller.
### SessionHeaders: { readonly key: "x-session-key"; /** When the session ends, in epoch milliseconds: `Date.now() + lifetime`. */ readonly expires: "x-session-expires"; readonly end: "x-session-end" }
    readonly key: "x-session-key"
    // When the session ends, in epoch milliseconds: `Date.now() + lifetime`.
    readonly expires: "x-session-expires"
    readonly end: "x-session-end"

> Every open connection, and how far what a plugin pushes travels.
### sockets(kernel: { channels: () => readonly RegisteredChannel[] }, claim?: string): { push: (message: ChannelMessage) => void; connected: (scope: string, permission: string) => readonly string[]; subscribe: (identity: Identity | undefined, send: (text: string) => void) => Subscription }
    channels: () => readonly RegisteredChannel[]
    }, claim?: string): {
    push: (message: ChannelMessage) => void
    connected: (scope: string, permission: string) => readonly string[]
    subscribe: (identity: Identity | undefined, send: (text: string) => void) => Subscription

> Boots the whole application, refusing before it serves anything: declared tables or indexes no migration creates, migrations reading another plugin's table without depending on it, tables with no database, and a store missing `migrate` or `close`.
### start(options: StartOptions): Promise<StartedApp>

> Schemas that read what was written earlier: a JSON column, a published document. A row written under
> yesterday's schema is read with today's, so a project's stored-contract check holds each to its lock.
> Event payloads and command inputs need no marking: they are held to it as declared.
### Stored: { /** Marks a schema as one that reads stored data, under a name unique in the process: `"<plugin>.<thing>"`. */ define: <Schema extends z.ZodType>(name: string, schema: Schema) => Schema; /** Every schema marked so far. */ all: () => ReadonlyMap<string, z.ZodType> }
    // Marks a schema as one that reads stored data, under a name unique in the process: `"<plugin>.<thing>"`.
    define: <Schema extends z.ZodType>(name: string, schema: Schema) => Schema
    // Every schema marked so far.
    all: () => ReadonlyMap<string, z.ZodType>

> A budget that counts nothing and allows everything.
### unlimited(): { spend: () => RateLimitResult; refund: () => void; sweep: () => number; size: () => number }
    spend: () => RateLimitResult
    refund: () => void
    sweep: () => number
    size: () => number

## Classes

> An outbound call that failed. Owned here with the `HttpClient` contract it belongs to, so the kernel can read one while following redirects.
### HttpRequestError extends Error
    readonly code: HttpRequestErrorCode
    readonly status: number | undefined
    // How long the partner asked to be left alone, in seconds.
    readonly retryAfter: number | undefined
    // Where a redirect pointed, absolute, on REDIRECT.
    readonly location: string | undefined
    constructor(code: HttpRequestErrorCode, message: string, status?: number, cause?: unknown, retryAfter?: number, location?: string)

> A refusal, naming the plugin it came from.
### KernelFault extends Error
    readonly code: FaultCode
    readonly plugin: string | undefined
    readonly detail: Readonly<Record<string, unknown>>
    constructor(code: FaultCode, message: string, about?: FaultDetail)
    toString(): string

> What went wrong, in a sentence naming the file.
### MigrationFault extends Error
    readonly plugin: string
    readonly step: string | undefined
    constructor(message: string, plugin: string, step?: string)

> A refusal a plugin raises on purpose, meant to reach the caller.
### Refusal extends Error
    readonly status: number
    readonly code: string
    readonly fields: Readonly<Record<string, string>> | undefined
    // How many seconds the caller should wait before trying again, sent as `retry-after`.
    readonly retryAfter: number | undefined
    constructor(status: number, code: string, message: string, fields?: Readonly<Record<string, string>>, options?: {
    retryAfter?: number
    })

> What a handler returns when the body alone is not the answer.
### Reply
    readonly status: number
    readonly body: unknown
    readonly headers: Readonly<Record<string, string>>
    constructor(status: number, body: unknown, headers?: Readonly<Record<string, string>>)
    // What `Reply.events` gave, read by the kit.
    events?: EventsReply
    // What `Reply.document` gave, read by the kit.
    document?: {
    policy: DocumentPolicy | undefined
    etag: string | undefined
    }
    // What `Reply.file` gave, read by the kit.
    file?: {
    type: FileType
    filename: string
    etag: string | undefined
    }
    // Sends the caller somewhere else.
    static redirect(to: string, permanent?: boolean): Reply
    // An HTML page, for a route declaring `document`: its policy and etag, when given, replace the route's; `headers` takes only cache-control, vary and content-language.
    static document(html: string, options?: {
    policy?: DocumentPolicy
    status?: number
    etag?: string
    headers?: Readonly<Record<string, string>>
    }): Reply
    // A download, for a route declaring `file`: text, bytes, or an iterable of chunks sent as they come; `headers` takes only cache-control and vary.
    static file(body: string | Uint8Array | Iterable<string | Uint8Array> | AsyncIterable<string | Uint8Array>, options: {
    type: FileType
    filename: string
    status?: number
    etag?: string
    headers?: Readonly<Record<string, string>>
    }): Reply
    // A CSV download, for a route declaring `file` with "text/csv": RFC 4180 quoting, one header row from `columns`,
    // and every cell a spreadsheet would run as a formula (starting with =, +, -, @, a tab or a return) kept as text.
    static csv(rows: readonly Readonly<Record<string, unknown>>[], options: {
    columns: readonly string[]
    filename: string
    }): Reply
    // Events, for a route declaring `streams`: `headers` only names the route `sends`, printable, up to 256 characters each;
    // `end` (1 to 64 printable characters) is written raw as the last `data:` line when the events finish, never after a failure;
    // `error`, given the neutral message, becomes the data-only frame an unexpected failure ends the stream with, instead of `event: error`.
    static events(source: Iterable<unknown> | AsyncIterable<unknown>, options?: {
    headers?: Readonly<Record<string, string>>
    end?: string
    error?: (message: string) => unknown
    }): Reply

> One event of a streamed answer: `data` is what the route's `streams` schema parses, `event` and `id` the SSE fields an EventSource reads.
### ServerEvent<Data = unknown>
    readonly data: Data
    readonly event: string | undefined
    readonly id: string | undefined
    constructor(data: Data, options?: {
    event?: string
    id?: string
    })

## Types

> The type-erased `Command`, alongside `Participation` and `AnyRoute`: it keeps `schema` and `requires`, and takes `never` so a record may hold commands written for different inputs.
### AnyCommand<Context> = DescribableWithSchema &
    requires?: readonly string[]
    run: (input: never, ctx: Context) => void | Promise<void>

> One route, whatever its input schema: a list holds "some route" rather than one shape, without reaching for `any`.
### AnyRoute<Context> = Omit<Route<Context, z.ZodType>, "input" | "handle"> &
    input: z.ZodType
    handle: (input: never, ctx: Context) => unknown | Promise<unknown>

> A channel a plugin pushes on, and how far what it pushes goes.
### Channel = DescribableWithSchema &
    reach: ChannelReach
    // What a listener must hold, beyond being within reach.
    requires?: readonly string[]

> One message on its way out, and how far it goes.
### ChannelMessage
    channel: string
    message: unknown
    reach: ChannelReach
    requires: readonly string[]
    // The scope it stays inside, when its reach is one.
    scope: string | undefined
    // Whose request pushed it, for a reach of "viewer".
    from: Identity | undefined
    // Which socket pushed it, for a reach of "connection"; absent means none can hear it.
    fromConnection: string | undefined
    // The identity it is for, for a reach of "identity".
    to?: string | undefined

> `connection` is the one socket that asked, `viewer` every socket one person has open, `scope` everyone the claim puts together, `everyone` all of them.
> `everyone` is written out, like `public` on a route, so a world-readable channel is a decision rather than an oversight.
> `identity` is every socket of the one person a push names, inside the pusher's scope only.
### ChannelReach = "connection" | "viewer" | "scope" | "identity" | "everyone"

> Something a plugin can be asked to do, behind the permissions it names.
### Command<Context, Input extends z.ZodType = z.ZodType> = Describable &
    schema: Input
    requires?: readonly string[]
    run: (input: z.infer<Input>, ctx: Context) => void | Promise<void>

> What every plugin function receives.
### Context<Config = unknown, Services = unknown, Db = unknown> =
    name: string
    config: Config
    services: Services
    log: Logger
    // What time it is, in milliseconds. On the context rather than `Date.now()` because pinning the clock otherwise affects every other test in the process.
    now: () => number
    // Who this request is for. Absent outside a request, as in setup.
    identity: Identity | undefined
    // The request headers this route declared in `reads`, lowercase. Empty outside a request.
    headers: Readonly<Record<string, string>>
    // The bytes of the request body exactly as they arrived, present only where the route declared `keepsRaw`.
    sent: Uint8Array | undefined
    // How scheduled work and the outbox are doing: counts, names and times, never a job's input or an event's payload. Only for a plugin declaring `watchesWork: true`.
    work: WorkWatch
    // Aborts when the caller goes away, as a client closing a stream does. Absent outside a request.
    signal: AbortSignal | undefined
    // This plugin's own tables: a query naming another plugin's table does not compile.
    // The connection underneath is shared, so the table boundary is the compiler's rather than the database's.
    db: Db
    // Runs one query outside a transaction, in its turn: a query awaiting during another's transaction joins it and dies with its rollback after reporting success.
    write: <Result>(run: () => Promise<Result>) => Promise<Result>
    // Runs work in one transaction, rolled back if it throws.
    // The callback is handed a context of its own, not just a handle: using the outer `ctx` writes outside the transaction just opened.
    // A `tx` inside the callback joins this one rather than opening a second.
    tx: <Result>(run: (ctx: Context<Config, Services, Db>) => Promise<Result>) => Promise<Result>
    // Calls a host this plugin declared in `allowedHosts`.
    fetch: {
    (call: HttpRequest & {
    accepts: "stream"
    }): Promise<StreamedResponse>
    (call: HttpRequest): Promise<unknown>
    }
    events: {
    // Announces what happened; inside a transaction it waits for the commit, because an event about rolled-back work is a lie.
    emit: (event: string, payload: unknown) => void
    }
    // Sends a message on a channel this plugin declared, as far as its `reach` says and no further. Nothing waits for it.
    push: (channel: string, message: unknown, options?: {
    // The identity a channel reaching "identity" is pushed to; refused for any other reach.
    to?: string
    }) => void
    presence: {
    // The distinct identity ids holding `permission` with a socket open in this scope now; per process, like the rate limiter.
    connected: (permission: string) => readonly string[]
    }
    hooks: {
    // Runs a hook and answers the first refusal, or undefined.
    run: (hook: string, payload: unknown) => Promise<string | undefined>
    }
    permissions: {
    has: (permission: string) => boolean
    all: (permissions: readonly string[]) => boolean
    // What the project attached to this identity, unread by the kernel.
    claims: () => Readonly<Record<string, unknown>>
    }
    commands: {
    run: (command: string, input: unknown) => Promise<void>
    // Runs one later, in seconds from now: only a command this plugin declares, and it runs for nobody, so whose work it is travels in the input.
    // Asked for inside a transaction it is written by that transaction and rolls back with it; a command that throws is tried again.
    later: (command: string, input: unknown, inSeconds: number) => void
    }
    // Takes ownership of something that outlives a request: one per plugin, opened in `setup` and closed in `teardown`, and no plugin reaches another's.
    // Services are built per request instead, because one holding a caller would answer the next request as the previous one.
    owns: <Kept>(kept: Kept) => Kept
    // What this plugin took ownership of, or undefined before `setup` did.
    owned: <Kept>() => Kept | undefined
    // What narrows every read of a table this plugin declared a `scope` for: `.where(and(eq(items.id, id), ctx.scoped("items")))`.
    // The compiler does not require this: a query without it reads every scope's rows. Project.findAll names such a query at check time; `ctx.forScope(claim)` narrows one the request does not name, such as a scheduled run.
    scoped: <Condition = unknown>(table: string) => Condition
    // The row's scope column, filled from the caller: `.values({ ...row, ...ctx.stamped("items") })`.
    // An insert has no condition to narrow, so this is the only thing preventing a caller in one tenant writing a row stamped with another's.
    stamped: (table: string) => Readonly<Record<string, string>>
    // The same plugin, acting for the scope this names, where a listener runs on nobody's behalf: `ctx.forScope(gone.shopId)`.
    // Refused inside a request, where the scope is decided by who is asking: choosing another there is how a caller reaches another tenant's rows.
    forScope: (claim: string) => Context<Config, Services, Db>
    // Whose scope this acts in: the caller's claim, or what `forScope` named; undefined for a plugin declaring no scope, or where nobody is placed.
    scope: string | undefined
    // Another plugin's services, by name. Only what `dependsOn` names.
    use: <Api>(plugin: string) => Api

> One thing wrong, and everything needed to fix it.
### ContractProblem
    code: KernelFault["code"]
    plugin: string
    message: string

> What opening a database needs to know.
### DatabaseOptions
    // A path, or ":memory:" for one that lives as long as the process.
    file: string
    // How long a writer waits for another to finish, in milliseconds.
    busyMs?: number
    // Whether to keep the write-ahead log. Off for :memory:, which has none.
    wal?: boolean

> Everything one plugin declares, as data rather than source.
### Declaration
    readonly name: string
    readonly version: string
    readonly describe: string
    readonly dependsOn: readonly string[]
    readonly routes: readonly DeclaredRoute[]
    readonly emits: readonly DeclaredEntry[]
    readonly listens: readonly DeclaredEntry[]
    readonly channels: readonly DeclaredEntry[]
    readonly hooks: readonly DeclaredEntry[]
    readonly participates: readonly DeclaredEntry[]
    readonly commands: readonly DeclaredCommand[]
    readonly tables: readonly string[]
    readonly scope?: DeclaredScope
    readonly allowedHosts: readonly string[] | "anywhere"
    readonly migrations?: string
    readonly config: boolean
    readonly services: boolean
    readonly setup: boolean
    readonly teardown: boolean

> One command, which unlike an event names what the caller must hold.
### DeclaredCommand = DeclaredEntry &
    readonly requires: readonly string[]

> A name carrying a sentence, which is how events, channels, hooks and commands read.
### DeclaredEntry
    readonly name: string
    readonly describe: string

> One route as declared: what reaches it, and what it asks of the caller.
### DeclaredRoute
    readonly method: string
    readonly path: string
    readonly describe: string
    // Whether an unauthenticated caller may reach it; absent in a definition means no.
    readonly public: boolean
    readonly requires: readonly string[]
    readonly limit?: {
    readonly requests: number
    readonly seconds: number
    }

> Which claim decides whose rows a plugin reads, and the tables it narrows.
### DeclaredScope
    readonly describe: string
    readonly claim: string
    readonly tables: readonly string[]

> Everything a plugin declares about itself.
### Definition<Schema extends z.ZodType = z.ZodType, Services = unknown, Db = unknown> = Describable &
    version: string
    dependsOn?: readonly string[]
    config?: Schema
    permissions?: Readonly<Record<string, Permission>>
    // This plugin's tables, in its own namespace. Nobody else reads them.
    tables?: Readonly<Record<string, unknown>>
    // Which claim decides whose rows these are, and where each table carries it.
    // `ctx.scoped` narrows a named table and refuses a caller carrying no such claim, because a default tenant is everybody's tenant; `ctx.db` is the unnarrowed read a shared table needs, and stays unnarrowed.
    scope?: {
    describe: string
    claim: string
    tables: Readonly<Record<string, string>>
    }
    // Where its migrations live, run in dependency order before setup.
    migrations?: string
    // Hosts this plugin may call, anything else refused before it dials; `"anywhere"` is for a plugin whose hosts are a row rather than a constant.
    // `"anywhere"` relaxes nothing else: private address, non-https scheme, off-port and credential-in-url stay refused, and the resolved address is checked rather than the name.
    allowedHosts?: readonly string[] | "anywhere"
    // This plugin reads `ctx.work`: how scheduled work and the outbox are doing. Any other plugin reading it is refused; guard what it answers to platform operators.
    watchesWork?: boolean
    // This plugin stands in for a real provider (mail that is never sent, payments never charged): `start` refuses it in production unless `ALLOW_FAKE=true`.
    fake?: boolean
    services?: (ctx: Context<z.infer<Schema>, never, Db>) => Services
    // The endpoints this plugin answers, each carrying its own input schema; a narrower handler input is sound because the kernel parses before it calls.
    routes?: readonly AnyRoute<Context<z.infer<Schema>, NoExtraKeys<Services>, Db>>[]
    emits?: Readonly<Record<string, Event>>
    // Channels it pushes on. What it pushes is checked against the schema.
    channels?: Readonly<Record<string, Channel>>
    listens?: Readonly<Record<string, EmittedEvent<Context<z.infer<Schema>, NoExtraKeys<Services>, Db>>>>
    hooks?: Readonly<Record<string, Hook>>
    participates?: Readonly<Record<string, Participation<Context<z.infer<Schema>, NoExtraKeys<Services>, Db>>>>
    commands?: Readonly<Record<string, AnyCommand<Context<z.infer<Schema>, NoExtraKeys<Services>, Db>>>>
    // Who is calling, read from the request this plugin knows how to read; at most one plugin declares this, and answers nothing for a stranger.
    // Throwing in here is 401, never 500.
    identifies?: (ctx: Context<z.infer<Schema>, NoExtraKeys<Services>, Db>, request: Request) => Promise<IdentifiedCaller | undefined> | IdentifiedCaller | undefined
    // What being signed in means here; at most one plugin declares it, named as strings so the granting plugin never imports the declaring one.
    // The kernel refuses to start when a route requires a permission nothing grants.
    grants?: (ctx: Context<z.infer<Schema>, NoExtraKeys<Services>, Db>, identity: Omit<Identity, "permissions">) => Promise<readonly string[]> | readonly string[]
    // Every permission `grants` may ever answer, read at startup so the check runs before anything is served rather than on whoever asked first.
    // The closed set `grants` answers from, so a route requiring a permission outside it is refused at startup rather than answering 403 forever.
    // Left out, `grants` may answer anything any plugin declares, and no route can be checked as unreachable. Named after OIDC's `scopes_supported`, which it is.
    grantsSupported?: readonly string[]
    setup?: (ctx: Context<z.infer<Schema>, NoExtraKeys<Services>, Db>) => void | Promise<void>
    teardown?: (ctx: Context<z.infer<Schema>, NoExtraKeys<Services>, Db>) => void | Promise<void>

> Anything declared carries a sentence saying what it is for.
### Describable
    describe: string

> A declaration whose payload is checked before it reaches anyone.
### DescribableWithSchema = Describable &
    schema: z.ZodType

> What discoverFrom answers: what it found, and what it stepped over.
### DiscoveryResult
    plugins: Plugin[]
    skipped: SkippedFolder[]

> A page's content security policy as named source lists; each is written as one directive, `'none'` where left out for default-src, base-uri and frame-ancestors. A source holding `;`, `,` or whitespace is refused, as are 'unsafe-eval' anywhere and 'unsafe-inline' in scriptSrc.
### DocumentPolicy
    defaultSrc?: readonly string[]
    scriptSrc?: readonly string[]
    styleSrc?: readonly string[]
    fontSrc?: readonly string[]
    connectSrc?: readonly string[]
    imgSrc?: readonly string[]
    frameAncestors?: readonly string[]
    baseUri?: readonly string[]
    formAction?: readonly string[]

> A drizzle handle over the one shared better-sqlite3 connection, scoped to a single plugin's tables; asking for one for a plugin declaring no tables throws.
### DrizzleDb = ReturnType<typeof drizzle>

> What `ctx.fetch` to "anywhere" would do with an address: dial it, or refuse it and why.
### EgressVerdict = { allowed: true } | { allowed: false; reason: RefusalReason }

> A listener, participant or command, whatever payload it was written for. See `AnyRoute`.
### EmittedEvent<Context> = Describable &
    handle: (payload: never, ctx: Context) => void | Promise<void>

> An event a plugin publishes. Delivered after the work it announces.
### Event
    describe: string
    schema: z.ZodType

> An event a listener kept refusing, as an operator sees it.
### FailedEvent
    id: string
    plugin: string
    name: string
    // The listeners (plugin names) that did hear it.
    heard: readonly string[]
    attempts: number
    failedAt: number

> One scheduled command that ran out of attempts, and why.
### FailedJob
    plugin: string
    command: string
    input: unknown
    attempts: number
    error: unknown
    at: number

> What the kernel refuses.
### FaultCode
    | "DUPLICATE_PLUGIN"
    | "UNKNOWN_DEPENDENCY"
    | "DEPENDENCY_CYCLE"
    | "INVALID_NAME"
    | "INVALID_CONFIG"
    | "INVALID_ROUTE"
    | "INVALID_PAYLOAD"
    | "WRONG_PAYLOAD"
    | "INVALID_OUTPUT"
    | "UNDECLARED_CHANNEL"
    | "UNDECLARED_EVENT"
    | "UNKEPT_EVENT"
    | "SELF_HEARD_EVENT"
    | "UNDECLARED_HOOK"
    | "UNDECLARED_COMMAND"
    | "UNDECLARED_SCOPE"
    | "UNSCOPED_CALLER"
    | "UNCLAIMED_SCOPE"
    | "OUT_OF_SCOPE"
    | "UNDECLARED_PERMISSION"
    | "UNDECLARED_DEPENDENCY"
    | "UNDECLARED_HOST"
    | "INVALID_CALL"
    | "DUPLICATE_ROUTE"
    | "DUPLICATE_CHANNEL"
    | "DUPLICATE_EVENT"
    | "DUPLICATE_HOOK"
    | "DUPLICATE_COMMAND"
    | "DUPLICATE_PERMISSION"
    | "DUPLICATE_GRANTS"
    | "UNNOMINATED_GRANTS"
    | "UNGRANTABLE_PERMISSION"
    | "DUPLICATE_TABLE"
    | "UNAUTHENTICATED"
    | "PERMISSION_DENIED"
    | "RATE_LIMITED"
    | "NOT_STARTED"

### FaultDetail
    plugin?: string
    detail?: Readonly<Record<string, unknown>>
    cause?: unknown

> What a download may be sent as: never a type a browser would render and run.
### FileType = "text/csv" | "text/plain" | "application/json" | "application/pdf" | "application/zip" | "application/octet-stream"

> The Hono app `serve` returns, with the kernel's routes, CORS and security headers already mounted.
### HonoApp = ReturnType<typeof serve>

> A point where a plugin may refuse what is about to happen.
### Hook
    describe: string
    schema: z.ZodType

> What the kernel needs to call another server; `pin`, when given, is the address the kernel checked, and the call is dialled there rather than wherever the name resolves now.
### HttpClient = (call: HttpRequest, pin?: ResolvedAddress) => Promise<unknown>

> How the built-in caller is configured: `timeoutMs` defaults to 10000, `maxBytes` to 5000000, and `headers` is called per request so a rotating credential stays fresh.
### HttpClientOptions
    timeoutMs?: number
    // The most any one call may ask for with its own `timeoutMs`: 600000 when left out.
    mostTimeoutMs?: number
    maxBytes?: number
    // The most any one call may ask for with its own `maxBytes`: `maxBytes` when left out, so no call reads more unless this is raised.
    mostMaxBytes?: number
    headers?: (() => Readonly<Record<string, string>>) | undefined

> The verbs a route may answer.
### HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE"

> One outbound call, to a host the plugin declared.
### HttpRequest
    method: HttpMethod
    url: string
    body?: unknown
    // What the answer is read as, json when left out. Declared, never sniffed, so a host that changes content type changes nothing here.
    // `"stream"` answers a `StreamedResponse` once the headers arrive, the body read as it comes; a status outside 2xx still throws before any of it is handed over.
    accepts?: "json" | "text" | "stream"
    headers?: Readonly<Record<string, string>> | undefined
    signal?: AbortSignal | undefined
    // How long the whole call may take, reading included: the client's default when left out, never more than its `mostTimeoutMs`.
    timeoutMs?: number | undefined
    // The longest silence allowed between two chunks of a streamed answer.
    idleMs?: number | undefined
    // The most bytes this answer may carry, streamed or read whole: a whole number above 0. The client's `maxBytes` when left out; more than its `mostMaxBytes` is clamped to it.
    maxBytes?: number | undefined
    // What a 301, 302, 303, 307 or 308 does, only under allowedHosts "anywhere". "refuse" (the default) throws NETWORK.
    // "manual" hands it back: a streamed answer with its `status` and absolute `location`, or, read whole, `HttpRequestError` REDIRECT carrying them.
    // "follow" dials each hop checked like a first call, turning 303, and a 301 or 302 after a POST, into a GET without a body
    // as the fetch standard does, and dropping this call's headers on another origin. `timeoutMs` then bounds the whole chain, 30000 when left out.
    redirects?: "refuse" | "manual" | "follow" | undefined
    // How many hops "follow" takes before throwing TOO_MANY_REDIRECTS: 5 when left out, at most 10.
    mostRedirects?: number | undefined

> What `identifies` answers: an identity without permissions, which `grants` fills so nobody grants themselves.
> `permissions?: never` is load-bearing: without it a plugin may write permissions in and the kernel drops them silently.
### IdentifiedCaller = Omit<Identity, "permissions"> &
    permissions?: never

> Who this is, as whatever the project decided that means. Nobody signed in is no identity at all.
### Identity
    id: string
    // What they may do. The project fills it; the kernel enforces it.
    permissions: readonly string[]
    // What the project attached: a tenant, a role, a session. Opaque here.
    claims: Readonly<Record<string, unknown>>

> What a project holds after createKernel.
### Kernel
    start: () => Promise<void>
    stop: () => Promise<void>
    started: () => boolean
    routes: () => readonly RegisteredRoute[]
    // Every channel a plugin declared, and what it takes to hear one.
    channels: () => readonly RegisteredChannel[]
    // Every permission any plugin declared.
    permissions: () => readonly PermissionEntry[]
    // The plugins this kernel started, for a caller reading what they declare.
    plugins: () => readonly Plugin[]
    handle: (incoming: KernelRequest) => Promise<KernelResponse>
    context: (plugin: string, identity?: Identity) => Context
    // Who is calling, asked of the plugin that knows.
    identify: ((request: Request) => Promise<Identity | undefined>) | undefined
    events: {
    failures: () => readonly ListenerFailure[]
    }
    // What the schedule did that nobody is waiting on.
    work: {
    failed: () => readonly FailedJob[]
    // Events a listener kept refusing, kept in the outbox.
    failedEvents: () => Promise<readonly FailedEvent[]>
    // Delivers one dead letter again, to the listeners that have not heard it; false when there is none by that id.
    retryFailed: (id: string) => Promise<boolean>
    }
    // Hands what the outbox says is due to the listeners that have not heard it, once, and waits for it.
    redeliver: () => Promise<number>
    // Waits until every event delivery under way has settled, and those they started.
    settled: () => Promise<void>
    // Runs whatever the schedule says is due, once, and waits for it.
    due: () => Promise<number>
    run: (command: string, input: unknown, identity?: Identity) => Promise<void>

> What a project gives the kernel.
### KernelOptions
    plugins: readonly Plugin[]
    config?: Readonly<Record<string, unknown>>
    db?: KernelStore
    // What holds the open sockets. Without one, ctx.push throws.
    sockets?: Sockets
    httpClient?: HttpClient
    // How a name becomes addresses for a plugin reaching "anywhere"; the platform's resolver when left out.
    lookup?: Lookup
    log?: LogFn
    // What counts requests against a route's declared limit.
    rateLimiter?: RateLimiter
    // Where events wait between the transaction that emitted them and the listener that hears them.
    outbox?: Outbox
    // What the current time is, in milliseconds.
    now?: () => number
    // Where work waits until it is time, and how often to look.
    schedule?: Schedule
    // How often to ask the schedule what is due, in milliseconds.
    beatMs?: number
    // False keeps the schedule for `commands.later` without running what is due, for a process that only enqueues.
    runsSchedule?: boolean
    // How often to hand failed events to the listeners that have not heard them, in milliseconds: 5000 when left out.
    outboxBeatMs?: number
    // How long a scheduled command is held while it runs, in milliseconds: ten leases when left out; past it the lease runs out and the job is taken again, counted.
    jobRunMs?: number
    // How many times a scheduled command may throw before it is abandoned.
    mostAttempts?: number
    // How a declared scope becomes a condition the store understands.
    scopeFilter?: ScopeFilter
    // Which plugin may answer what the caller holds; any other declaring `grants` is refused at startup.
    grantedBy?: string
    // How long a hook participant has to answer, in milliseconds.
    hookTimeoutMs?: number
    // How many streams one caller may hold open at once (4 when left out); one more answers 429 TOO_MANY_STREAMS before its handler runs.
    mostStreamsPerCaller?: number
    // How long `stop` waits for open streams to send their final RESTARTING event, in milliseconds (5000 when left out).
    streamDrainMs?: number
    // Holds every reply to the header allow-list (the kit's short list plus a route's `sends`) now; 9.0 makes it the default. Left out, a header the list would drop still goes out, named once in the log.
    strictReplyHeaders?: boolean

> One request, as it reaches the kernel.
### KernelRequest
    method: HttpMethod
    path: string
    input: unknown
    identity?: Identity | undefined
    // The request's headers, lowercase. A route sees only what it declared.
    headers?: Readonly<Record<string, string>> | undefined
    // The body's bytes as they arrived, for a route that declared `keepsRaw`.
    sent?: Uint8Array | undefined
    // Where it came from when nobody is signed in. Only a rate limit reads it.
    from?: string | undefined
    // Aborts when the caller goes away; handed to the route as `ctx.signal`.
    signal?: AbortSignal | undefined
    // The request's If-None-Match, which the kit answers itself: a GET whose ETag matches gets a 304.
    ifNoneMatch?: string | undefined

> What the kernel answers: a status, and a body already safe to send.
### KernelResponse
    status: number
    body: unknown
    headers?: Readonly<Record<string, string>>
    // Whether a declared document answered, so the body is sent as HTML under its own policy.
    document?: boolean
    // Whether a declared file answered, so the body (text, bytes or chunks) is sent as a download.
    file?: boolean

> What the kernel needs to reach storage.
### KernelStore
    // One plugin's own handle. What it holds is the project's business.
    forPlugin: (plugin: string) => unknown
    // Runs work in one transaction, rolled back if it throws.
    tx: <Result>(plugin: string, run: (db: unknown) => Promise<Result>) => Promise<Result>
    // Runs work that is not in a transaction, but never during someone else's. Optional, so a project may pass a store needing no such ordering.
    write?: <Result>(run: () => Promise<Result>) => Promise<Result>
    // Whether a transaction is open right now. For diagnosis.
    inTransaction?: () => boolean

> How loud a line is, and how loud a logger listens.
### Level = "debug" | "info" | "warn" | "error"

> `payload` is `unknown`, never `never`: contravariance lets `(payload: never)` accept any annotation, so the compiler endorses a claim about a different schema.
### Listener<Context, Payload = unknown> = Describable &
    handle: (payload: Payload, ctx: Context) => void | Promise<void>

> One listener that threw, with `at` the PAST epoch-ms moment it failed, unlike `QueuedJob.at` which is a FUTURE run time; only the last 100 are kept, and `error` is whatever was thrown.
### ListenerFailure
    event: string
    plugin: string
    error: unknown
    at: number

> Where a line goes. The project decides; a plugin never writes directly.
### LogFn = (level: "debug" | "info" | "warn" | "error", plugin: string, line: string, about?: Readonly<Record<string, unknown>>) => void

> Where a plugin's lines go. The project decides.
### Logger
    debug: (line: string, about?: Readonly<Record<string, unknown>>) => void
    info: (line: string, about?: Readonly<Record<string, unknown>>) => void
    warn: (line: string, about?: Readonly<Record<string, unknown>>) => void
    error: (line: string, about?: Readonly<Record<string, unknown>>) => void

> How a name becomes addresses: every one of them, as `dns.lookup(name, { all: true })` answers.
### Lookup = (hostname: string) => Promise<readonly ResolvedAddress[]>

> Where one plugin keeps its migrations.
### MigrationSource
    plugin: string
    from: string

> One migration file, as it sits on disk.
### MigrationStep
    plugin: string
    name: string
    sql: string
    hash: string

> What putting a kernel on a port takes.
### OpenOptions
    port: number
    log: Logger
    // Whether something in front sets `x-forwarded-for`; without one, a caller writes their own address. Kept for 8.x: name `trustedProxies` instead.
    behindProxy?: boolean
    // The proxies in front, as addresses or ranges: a socket's caller is the rightmost hop none of them wrote, as `Server.from` reads it.
    trustedProxies?: readonly string[]
    // How often to report listeners that failed; zero never looks.
    watchSeconds?: number
    stopTimeoutMs?: number
    drainMs?: number
    // How the socket at `/ws` is held: its lifetime, how often it is identified again and pinged, how many one caller may hold.
    sockets?: Omit<SocketOptions, "log" | "from">

> Where events wait, so one is never lost between a commit and its delivery.
> Delivery is at least once per listener: a listener that throws is retried in the running process with backoff (2^n s, 300 s at most),
> and only the listeners that have not heard the event are called again. After `mostAttempts` the row stays as a dead letter,
> logged once, until `work.retryFailed`. A listener that charges, sends or bills must recognise what it already did (the event id).
> Order holds within one event's listeners only: a retried event can reach a listener after a later one.
### Outbox
    // Writes events inside the transaction that emitted them.
    save: (db: unknown, messages: readonly OutboxMessage[]) => void
    // Marks one delivered.
    markSent: (id: string) => Promise<void>
    // What was kept but never marked sent. Read once, at startup, by a kernel whose outbox cannot `claim`.
    pending: () => Promise<readonly OutboxMessage[]>
    // Leases what is due for another delivery: failed before and waiting out its backoff, or never cleared after a grace period.
    claim?: (now: number, limit: number) => Promise<readonly (OutboxMessage & {
    heard: readonly string[]
    attempts: number
    })[]>
    // How long a row stays with the process delivering it without a renewal.
    leaseMs?: number
    // Keeps the lease on a row this process is delivering; false when another has taken it.
    renew?: (id: string, now: number) => Promise<boolean>
    // One listener heard it: kept at once, so a process that dies mid-delivery repeats only the rest.
    markHeard?: (id: string, listener: string) => Promise<void>
    // Some listeners threw: keep which heard it, and try the rest again at `at`.
    markRetry?: (id: string, heard: readonly string[], attempts: number, at: number) => Promise<void>
    // A listener kept throwing: keep the row as a dead letter.
    markDead?: (id: string, heard: readonly string[], attempts: number, at: number) => Promise<void>
    // The dead letters, without their payloads.
    failed?: () => Promise<readonly FailedEvent[]>
    // Puts one dead letter back to be delivered now; false when no dead letter has that id.
    revive?: (id: string, now: number) => Promise<boolean>
    // How many rows wait for their first delivery, are being retried, or are dead letters.
    counts?: (now: number) => Promise<{
    waiting: number
    retrying: number
    dead: number
    }>

> One event, as it waits to be delivered.
### OutboxMessage
    id: string
    plugin: string
    name: string
    payload: unknown

> What a participant answers: nothing to allow, a reason to refuse.
### Participant<Context, Payload = unknown> = Describable &
    handle: (payload: Payload, ctx: Context) => string | undefined | Promise<string | undefined>

> The type-erased `Participant`, alongside `AnyCommand` and `AnyRoute`: its handler still answers `undefined` to allow or a string to refuse, but takes `never` so a list may hold participants written for different payloads.
### Participation<Context> = Describable &
    handle: (payload: never, ctx: Context) => string | undefined | Promise<string | undefined>

> What a plugin may do, named so a project can grant it.
### Permission
    describe: string

> One permission a plugin declared, and what holding it means.
### PermissionEntry
    plugin: string
    permission: string
    describe: string

> A plugin: its name, and what it declared.
### Plugin
    name: string
    definition: Definition

### PluginModules = Readonly<Record<string,
    default?: Plugin

> One command waiting for its moment.
### QueuedJob
    id: string
    plugin: string
    command: string
    input: unknown
    at: number
    attempts: number
    // Which claim holds it, when the schedule leases per claim.
    lease?: string

> What decides whether one identity has any allowance left on one route.
### RateLimiter
    spend: (key: string, window: {
    requests: number
    seconds: number
    }) => {
    allowed: boolean
    resetsInSeconds: number
    }
    // Gives one spend back, for a route counting only what it guards against.
    refund?: (key: string) => void

> What one `spend` answers; `remaining` floors at 0 and `resetsInSeconds` is the whole window on the call that opened it.
### RateLimitResult
    allowed: boolean
    remaining: number
    resetsInSeconds: number

> A budget: `requests` allowed per `seconds`, counted in fixed windows rather than a sliding one.
### RateLimitWindow
    requests: number
    seconds: number

> What a log line keeps back: credentials always, a person's details where asked.
### RedactionOptions
    personal?: boolean

> What a client is told: a status, a stable code, and one sentence.
### RefusalBody
    status: number
    code: string
    message: string
    // Field-level detail, only ever from an input schema.
    fields?: Readonly<Record<string, string>>

> Whether an address is one the outside world may be reached at.
> Why a refused address was refused, for a plugin to tell its caller.
### RefusalReason = "unresolvable" | "blocked_address" | "refused_url"

> One channel a plugin declared, as a reader of the api sees it.
### RegisteredChannel
    plugin: string
    channel: string
    reach: ChannelReach
    requires: readonly string[]

> A route, and the plugin it came from.
### RegisteredRoute = { plugin: string; method: HttpMethod; path: string; describe: string; requires: readonly string[]; public: boolean; anyOrigin: boolean; limit: { requests: number; seconds: number } | undefined; accepts: "json" | "form" | "urlencoded"; reads: readonly string[]; keepsRaw: boolean }

> One address a name resolves to.
### ResolvedAddress
    address: string
    family: number

> One endpoint: `output` is a whitelist of what may leave, so a column added to a table tomorrow does not appear in a response by itself.
### Route<Context, Input extends z.ZodType = z.ZodType> = Describable &
    method: HttpMethod
    path: string
    input: Input
    // What one answer may carry. Declared with `streams` as well, the route answers JSON when `handle` answers a value and events when it answers an iterable or `Reply.events`.
    output?: z.ZodType
    // What each event of a streamed answer may carry, parsed like `output`: `handle` answers an iterable, sync or async, of values or `ServerEvent`s, sent as Server-Sent Events. Requires, limit, input and scope are decided before the first event; a failure after it ends the stream with an `error` event.
    streams?: z.ZodType
    // Declares an HTML page instead of `output`: `handle` answers `Reply.document(html, …)` or a string. Only such a route may send a policy of its own; frame-ancestors other than 'none' needs `framable: true`.
    document?: {
    policy?: DocumentPolicy
    framable?: boolean
    }
    // Declares a download instead of `output`: `handle` answers `Reply.file(body, { type, filename })`, always sent as an attachment, as one of the types named here.
    file?: {
    types: readonly FileType[]
    }
    // How long one stream of this route may stay open, in seconds (300 when left out); it then ends with an `error` event of code EXPIRED, and the client reconnects, which checks the caller again.
    streamSeconds?: number
    // What the caller must hold. Every route says something: name a permission, mark it `public`, or write `requires: []` for one any signed-in caller may reach. Leaving it out is refused at startup.
    requires?: readonly string[]
    // Whether an unauthenticated caller may reach this. Absent means no, so forgetting to think about it fails shut.
    public?: boolean
    // Whether any website may read the answer from a browser: CORS `*`, never with credentials, and the server reads no session for it. Only a public GET that reads no credential header; anything else is refused at startup. For what an embed on another site fetches, the same for everyone.
    anyOrigin?: boolean
    // Requests per window for one caller.
    // `countSuccess: false` counts only failed calls, for a route guarding a secret: five wrong passwords is an attack, five right ones is five devices.
    // `key` is who a window counts: the caller's identity (or address, when signed out) by default, `"address"` for the address alone, or a function of the parsed input, as a sign-in counts per email; the input is then parsed before the limit is spent.
    limit?: {
    requests: number
    seconds: number
    countSuccess?: boolean
    key?: "identity" | "address" | ((input: never) => string)
    }
    // What kind of body this takes, JSON unless it says otherwise; `"form"` reads `multipart/form-data`, file parts as `UploadedFile`s; `"urlencoded"` reads `application/x-www-form-urlencoded` as string fields (a name sent twice as a list), its bytes in `ctx.sent` with `keepsRaw`, as a provider signs them.
    // Declared rather than sniffed, so a route expecting JSON can never be handed a file.
    accepts?: "json" | "form" | "urlencoded"
    // Request headers this route reads, lowercase; what is not named does not arrive.
    // Named rather than handed the lot: a handler reading any header reads the session cookie, and its log then carries a credential.
    reads?: readonly string[]
    // Response headers this route sets beyond the kit's short list (location, retry-after, content-disposition, vary, etag, cache-control and the session headers), lowercase. A header governing how a browser treats the response is never one a route may name.
    sends?: readonly string[]
    // Whether this route also sees the bytes exactly as they arrived, as `ctx.sent`; `input` is still parsed and still passes the schema.
    // For signature checks: parsing reorders keys and drops whitespace, so `JSON.stringify` of the parsed body is a different string and no canonical form recovers the original.
    // Declared rather than always present, because bytes nobody asked for are bytes a log can carry.
    keepsRaw?: boolean
    // What answers the request: return a value for a 200, or a `Reply` to say the status and headers as well.
    handle: (input: z.infer<Input>, ctx: Context) => unknown | Promise<unknown>

> Where work waits until it is time.
### Schedule
    // Writes one, inside the transaction that asked for it when there is one.
    save: (db: unknown, job: QueuedJob) => void
    // Claims what is due, at most `limit`, marking each taken; a job whose lease ran out is claimed again with its lost run counted.
    claim: (now: number, limit: number) => Promise<readonly QueuedJob[]>
    // How long a claim holds without `renew`; the kernel renews every third of it while the command runs.
    leaseMs?: number
    // How many jobs are due, waiting for later, running within their lease, and held by a lease that ran out.
    counts?: (now: number) => Promise<{
    due: number
    later: number
    running: number
    abandoned: number
    }>
    // Keeps a claim; false when the lease was taken since, and this run should stop counting on it.
    renew?: (id: string, now: number, lease?: string) => Promise<boolean>
    // It ran. Forget it; with `lease`, only if that claim still holds it.
    markDone: (id: string, lease?: string) => Promise<void>
    // It threw. Put it back for `at`, having counted the attempt; with `lease`, only if that claim still holds it.
    markFailed: (id: string, at: number, lease?: string) => Promise<void>
    // It threw too many times. Stop trying; with `lease`, only if that claim still holds it.
    giveUp: (id: string, lease?: string) => Promise<void>

> How a scope becomes a condition the database understands; `plugin` names whose table it is, since two plugins may each name a table alike.
### ScopeFilter = (table: string, column: string, value: string, plugin?: string) => unknown

> What `serve` needs to know.
### ServerOptions = { kernel: Kernel; identify?: ((c: Context$1) => Identity | undefined | Promise<Identity | undefined>) | undefined; from?: ((c: Context$1) => string) | undefined; origins?: readonly string[]; methods?: readonly string[]; headers?: readonly string[]; maxAge?: number; exposes?: readonly string[]; bodyBytes?: number; session?: SessionOptions | undefined; log?: ((level: "info" | "warn" | "error", line: string, about?: Readonly<Record<string, unknown>>) => void) | undefined; clientLogs?: { path?: string; maxBytes?: number; requests?: number; seconds?: number } | undefined; hsts?: { maxAge: number; includeSubDomains?: boolean } | undefined; accessLog?: boolean | undefined; readiness?: (() => Promise<{ ready: boolean } & Readonly<Record<string, unknown>>>) | undefined }

> How a route's answer becomes a session cookie.
### SessionOptions
    // The cookie's name. Prefix it `__Host-` in production: without that a sibling host can set a second cookie of this name on a narrower path, and a request carrying two is refused rather than guessed at.
    name: string
    // Whether to mark it `Secure`.
    secure: boolean
    sameSite?: "Strict" | "Lax" | "None"
    // Where the cookie applies. Defaults to the whole origin.
    path?: string
    domain?: string

> What discoverFrom leaves behind: a folder it could not take.
### SkippedFolder
    folder: string
    why: string

> What holds the open sockets, when anything does.
### Sockets
    push: (sending: ChannelMessage) => void
    // Who holding a permission has a socket open in a scope, for `ctx.presence`.
    connected?: (scope: string, permission: string) => readonly string[]

> What `start` answers: the running kernel and store, the Hono app and its `fetch`, `sockets` only when sockets were asked for, and `stop`, which stops the kernel and closes the database.
### StartedApp = { kernel: Kernel; store: Store; app: ReturnType<typeof serve>; fetch: (request: Request) => Response | Promise<Response>; sockets: { subscribe: (identity: Identity | undefined, send: (text: string) => void) => Subscription } | undefined; served: { origins: readonly string[]; session: SessionOptions | undefined; bodyBytes: number; from: ServerOptions["from"] }; stop: () => Promise<void> }

> Everything `start` takes; `outbox` and `schedule` are opt-in, while `sockets` and `limits` are on unless set to false.
### StartOptions = { plugins: readonly Plugin[]; database?: DatabaseOptions | Store | undefined; config?: Readonly<Record<string, unknown>> | undefined; sockets?: boolean | { claim: string } | undefined; identify?: ((kernel: Kernel) => ServerOptions["identify"]) | undefined; http?: Omit<ServerOptions, "kernel" | "identify" | "log"> | undefined; httpClient?: HttpClientOptions | HttpClient | undefined; lookup?: Lookup | undefined; rateLimiter?: RateLimiter | undefined; mostStreamsPerCaller?: number | undefined; streamDrainMs?: number | undefined; strictReplyHeaders?: boolean | undefined; limits?: boolean | undefined; outbox?: boolean | undefined; schedule?: boolean | "enqueue" | undefined; jobLeaseMs?: number | undefined; jobRunMs?: number | undefined; outboxLeaseMs?: number | undefined; log?: Logger | undefined }

> What a project holds after opening a database.
### Store<Db = unknown> =
    forPlugin: (plugin: string) => Db
    // An outbox in this same database, when the store can hold one; the process writing a row holds it for `leaseMs` (60000 when left out) while it delivers.
    outbox?: (settings?: {
    leaseMs?: number
    }) => Outbox
    // A schedule in this same database, for work asked for later; each claim holds for `leaseMs` (60000 when left out) unless renewed.
    schedule?: (settings?: {
    leaseMs?: number
    }) => Schedule
    // How a declared scope becomes a condition over the tables it was given.
    createScopeFilter?: () => ScopeFilter
    tx: <Result>(plugin: string, run: (db: unknown) => Promise<Result>) => Promise<Result>
    write: <Result>(run: () => Promise<Result>) => Promise<Result>
    inTransaction: () => boolean
    migrate: (sources: readonly MigrationSource[]) => MigrationStep[]
    close: () => void

> What building a store needs: where the file is, and who owns what.
### StoreOptions = DatabaseOptions &
    tables: Readonly<Record<string, TablesByName>>

> A streamed answer: the body arrives chunk by chunk, still bounded by the call's bytes, time limits and signal; leaving the loop early cancels it.
### StreamedResponse
    status: number
    headers: Readonly<Record<string, string>>
    // The address that answered: the last hop's, after redirects "follow".
    url: string
    // Where a redirect handed back by redirects "manual" points, absolute; its body is empty.
    location?: string
    body: AsyncIterable<Uint8Array>

> One open connection, as whoever holds the wire sees it.
### Subscription
    // This connection, told apart from every other one the same person has open.
    id: string
    // Whether this connection may hear a channel at all.
    mayHear: (channel: string) => boolean
    // What the client said it listens to. Refused when it may not.
    listen: (channel: string) => boolean
    // What the client said it stopped listening to.
    unlisten: (channel: string) => void
    // The connection closed: it hears nothing more.
    close: () => void
    // The same socket's caller, identified again: what it may hear and whether it counts as present follow at once.
    reidentify: (identity: Identity | undefined) => void

> One plugin's drizzle tables keyed by the name its contract declares them under; the values are opaque here so the kit never depends on a drizzle table's shape.
### TablesByName = Readonly<Record<string, unknown>>

> A number that carries what it counts.
### Tagged<Unit extends string> = number &
    readonly measure: Unit

> One file a caller sent, as a route sees it.
### UploadedFile
    // The filename the caller claimed, with any path stripped.
    name: string
    // The content type the caller claimed.
    type: string
    bytes: Uint8Array

> How scheduled work and the outbox are doing, as an operator sees it: counts, names and times, never a job's input or an event's payload.
### WorkWatch
    health: () => Promise<{
    jobs: {
    due?: number
    later?: number
    running?: number
    abandoned?: number
    failed: number
    }
    outbox: {
    waiting?: number
    retrying?: number
    dead?: number
    }
    }>
    // Scheduled commands given up in this process, newest last, without their input.
    failedJobs: () => readonly {
    plugin: string
    command: string
    attempts: number
    at: number
    error: string
    }[]
    failedEvents: () => Promise<readonly FailedEvent[]>
    retryFailed: (id: string) => Promise<boolean>

# @onetype/stack-api-kit/testing

## Functions

> Registers, once per test process (a setup file), where missing dependencies come from. `resolve` is given the names
> nothing passed provides, in waves as their own dependencies turn up, and each name is asked for once: a resolver
> may load only those plugins, or answer every plugin it holds. A test that passes every plugin it needs never calls it.
### configureTestKernels(configuring: { resolve?: (missing: readonly string[]) => Promise<TestKernelFixture>; defaults?: TestKernelDefaults }): void
    resolve?: (missing: readonly string[]) => Promise<TestKernelFixture>
    defaults?: TestKernelDefaults

> An identity a test controls.
### createIdentity(permissions?: readonly string[], id?: string, claims?: Readonly<Record<string, unknown>>): Identity

> Finds inline `z.enum` members that exactly match an enum another plugin names, ignoring tests; an identical set within the same plugin is not reported.
### findCopiedVocabulary(root: string): CopiedVocabulary[]

> Reads every plugin folder under `root` by regex, never by compiling, and answers what crosses a boundary; tests are excused the deep import of a dependency's `plugin.ts`.
### findImportViolations(root: string): ImportViolation[]

> Answers which of the `required` paths, read relative to `root`, are absent or hold nothing but whitespace; a file that exists but is empty counts as missing.
### findMissingDocs(root: string, required: readonly string[]): string[]

> Walks every `.md` under `root` and answers those longer than `limit` characters (1800 by default), skipping `node_modules`, `dist`, `.git`, `coverage` and anything under a `progress` folder.
### findOversizedDocs(root: string, limit?: number): OversizedDoc[]

> A util two plugins wrote for themselves, matched by name and signature.
### findSharedNames(root: string): DuplicateSignature[]

> One word naming two closed sets that are nearly, but not quite, the same.
### findSplitVocabulary(root: string): SplitVocabulary[]

> Takes the two files' TEXT, not their paths, and answers the keys of `Definition` that the procedure never names in backticks.
### findUndocumentedKeys(contract: string, procedure: string): string[]

> Plugins that describe themselves nowhere.
### findUnexplainedPlugins(folder: string): string[]

> Reads each plugin's declared scope, then answers where its tables are reached without narrowing: such a query returns every tenant's rows, and nothing at compile time, boot or request says so.
### findUnscopedReach(root: string): UnscopedReach[]

> Fields a contract declares that nothing in production reads.
### findUnusedFields(root: string, separately?: boolean): UnusedField[]

> Every project-wide check in one object, each answering `ProjectProblem[]`; `findAll` runs the lot against sensible defaults and answers an empty array when a project is clean.
### Project: { /** What a project is suggested to require of itself, the same list the app kit names. */ required: readonly ["#docs/usage.md", "#docs/architecture.md"]; findAll: (checking?: ProjectCheckOptions) => ProjectProblem[]; findImportViolations: (root: string, leaving?: readonly string[]) => ProjectProblem[]; /** Where a scoped table is reached without narrowing, which returns another tenant's rows with nothing reporting it. */ findUnscopedReach: (root: string) => ProjectProblem[]; findUnusedFields: (root: string, apart?: boolean) => ProjectProblem[]; findUnexplainedPlugins: (root: string) => ProjectProblem[]; findCopiedVocabulary: (root: string, excused?: readonly string[]) => ProjectProblem[]; findSplitVocabulary: (root: string, excused?: readonly string[]) => ProjectProblem[]; findSharedNames: (root: string, excused?: readonly string[]) => ProjectProblem[]; findOversizedDocs: (root: string, limit: number) => ProjectProblem[]; findUndocumentedKeys: (procedure: string) => ProjectProblem[] }
    // What a project is suggested to require of itself, the same list the app kit names.
    required: readonly ["#docs/usage.md", "#docs/architecture.md"]
    findAll: (checking?: ProjectCheckOptions) => ProjectProblem[]
    findImportViolations: (root: string, leaving?: readonly string[]) => ProjectProblem[]
    // Where a scoped table is reached without narrowing, which returns another tenant's rows with nothing reporting it.
    findUnscopedReach: (root: string) => ProjectProblem[]
    findUnusedFields: (root: string, apart?: boolean) => ProjectProblem[]
    findUnexplainedPlugins: (root: string) => ProjectProblem[]
    findCopiedVocabulary: (root: string, excused?: readonly string[]) => ProjectProblem[]
    findSplitVocabulary: (root: string, excused?: readonly string[]) => ProjectProblem[]
    findSharedNames: (root: string, excused?: readonly string[]) => ProjectProblem[]
    findOversizedDocs: (root: string, limit: number) => ProjectProblem[]
    findUndocumentedKeys: (procedure: string) => ProjectProblem[]

> Checks that need a kernel already started, each answering `StartedProblem[]`.
> `Project` reads files and says what a plugin declared; this reads what those
> declarations became once every plugin was brought up together.
> Most of what a project would check here, `start` already refuses: a
> permission no plugin declares, one belonging to a plugin nobody depends on,
> a route reading a header that carries a credential. What is left is the one
> thing the kit cannot decide for a project, because the right budget for a
> route is the project's to know.
### Started: { findAll: (kernel: Kernel, checking?: StartedCheckOptions) => StartedProblem[]; /** Where a closed route carries no budget, so one caller may spend the whole process on it. */ findUnboundedRoutes: (kernel: Kernel, excused?: readonly string[]) => StartedProblem[] }
    findAll: (kernel: Kernel, checking?: StartedCheckOptions) => StartedProblem[]
    // Where a closed route carries no budget, so one caller may spend the whole process on it.
    findUnboundedRoutes: (kernel: Kernel, excused?: readonly string[]) => StartedProblem[]

> Boots a kernel on an in-memory database with migrations already applied; a dependency the test did not pass is added from the fixture `configureTestKernels` registered, with the fixture's config under the test's own, field by field. It records every event, log line and outbound call, throws on an option it does not take, and outbound calls answer `{}` unless `respondWith` says otherwise.
### startTestKernel(asked: TestKernelOptions): Promise<TestKernel>

> What an older stored row would fail against today, found from the lock a project commits.
### StoredContracts: { snapshot: (schema: z.ZodType) => Shape; collect: (plugins: readonly Plugin[]) => Record<string, Shape>; breaches: (name: string, before: Shape, after: Shape, path?: string) => Breach[]; check: (lock: Lock, today: Readonly<Record<string, Shape>>) => Breach[]; /** Every breach between the lock file and these plugins; no lock is one breach naming how to write it. */ checkFile: (lockFile: string, plugins: readonly Plugin[]) => Breach[]; /** * Rewrites the lock from today's schemas. A change an older row would fail against is refused unless each such * schema is named in `breaking` with why, and the migration that carries old rows over; the reason is kept in the lock. */ accept: (lockFile: string, plugins: readonly Plugin[], breaking?: Readonly<Record<string, string>>) => Breach[] }
    snapshot: (schema: z.ZodType) => Shape
    collect: (plugins: readonly Plugin[]) => Record<string, Shape>
    breaches: (name: string, before: Shape, after: Shape, path?: string) => Breach[]
    check: (lock: Lock, today: Readonly<Record<string, Shape>>) => Breach[]
    // Every breach between the lock file and these plugins; no lock is one breach naming how to write it.
    checkFile: (lockFile: string, plugins: readonly Plugin[]) => Breach[]
    // Rewrites the lock from today's schemas. A change an older row would fail against is refused unless each such
    // schema is named in `breaking` with why, and the migration that carries old rows over; the reason is kept in the lock.
    accept: (lockFile: string, plugins: readonly Plugin[], breaking?: Readonly<Record<string, string>>) => Breach[]

> A clock starting at `at` (the current moment when left out) that moves only when told.
### testClock(at?: number): TestClock

> Pulls the table declarations and migration sources out of a list of plugins, for a test building its own store rather than letting `startTestKernel` build one.
### testTables: { tables: (plugins: readonly Plugin[]) => Readonly<Record<string, Readonly<Record<string, unknown>>>>; migrations: (plugins: readonly Plugin[]) => { plugin: string; from: string }[] }
    tables: (plugins: readonly Plugin[]) => Readonly<Record<string, Readonly<Record<string, unknown>>>>
    migrations: (plugins: readonly Plugin[]) => {
    plugin: string
    from: string
    }[]

> The plugins with every transitive dependsOn added from the fixture: a plugin passed wins by name (a stand-in stays one, its own
> dependsOn closed over too), dependencies come first, and otherwise the order given holds. Unchanged when nothing is missing or
> no fixture is registered; throws naming the plugin and the dependency when neither the test nor the fixture has it.
### withDependencies(plugins: readonly Plugin[]): Promise<Plugin[]>

## Types

### Breach
    name: string
    path: string
    change: string

> An inline `z.enum` whose members exactly match a named enum another plugin exports, so `values` is a copy with no name and nothing compares the two.
### CopiedVocabulary
    name: string
    owner: string
    copier: string
    file: string
    values: readonly string[]

> One method name and signature that more than one plugin wrote for itself under its own `utils/`, with every file holding a copy.
### DuplicateSignature
    signature: string
    plugins: readonly string[]
    files: readonly string[]

> One outbound call, to a host the plugin declared.
### HttpRequest
    method: HttpMethod
    url: string
    body?: unknown
    // What the answer is read as, json when left out. Declared, never sniffed, so a host that changes content type changes nothing here.
    // `"stream"` answers a `StreamedResponse` once the headers arrive, the body read as it comes; a status outside 2xx still throws before any of it is handed over.
    accepts?: "json" | "text" | "stream"
    headers?: Readonly<Record<string, string>> | undefined
    signal?: AbortSignal | undefined
    // How long the whole call may take, reading included: the client's default when left out, never more than its `mostTimeoutMs`.
    timeoutMs?: number | undefined
    // The longest silence allowed between two chunks of a streamed answer.
    idleMs?: number | undefined
    // The most bytes this answer may carry, streamed or read whole: a whole number above 0. The client's `maxBytes` when left out; more than its `mostMaxBytes` is clamped to it.
    maxBytes?: number | undefined
    // What a 301, 302, 303, 307 or 308 does, only under allowedHosts "anywhere". "refuse" (the default) throws NETWORK.
    // "manual" hands it back: a streamed answer with its `status` and absolute `location`, or, read whole, `HttpRequestError` REDIRECT carrying them.
    // "follow" dials each hop checked like a first call, turning 303, and a 301 or 302 after a POST, into a GET without a body
    // as the fetch standard does, and dropping this call's headers on another origin. `timeoutMs` then bounds the whole chain, 30000 when left out.
    redirects?: "refuse" | "manual" | "follow" | undefined
    // How many hops "follow" takes before throwing TOO_MANY_REDIRECTS: 5 when left out, at most 10.
    mostRedirects?: number | undefined

> Who this is, as whatever the project decided that means. Nobody signed in is no identity at all.
### Identity
    id: string
    // What they may do. The project fills it; the kernel enforces it.
    permissions: readonly string[]
    // What the project attached: a tenant, a role, a session. Opaque here.
    claims: Readonly<Record<string, unknown>>

> One file importing another plugin: `from` is relative to the importing plugin's folder, `to` is the plugin name reached, `specifier` the text as written.
### ImportEdge
    from: string
    to: string
    specifier: string

> One crossing the boundaries refuse, `rule` saying which: an undeclared dependency, a reach past `@plugins/<name>`, an import loop, a folder with no plugin.ts, a process escape, or a util written twice.
### ImportViolation
    rule: "undeclared" | "deep" | "cycle" | "contract" | "escape" | "twice"
    message: string

### Lock
    version: 1
    contracts: Snapshots
    accepted: readonly Accepted[]

> One line a plugin logged, flattened: `level`, `plugin` and `line` are always there, and whatever the call passed as `about` is spread alongside them.
### LogLine = { level: string; plugin: string; line: string } & Readonly<Record<string, unknown>>

> One markdown file over the limit, `size` measured in characters of its whole text rather than lines or bytes.
### OversizedDoc
    path: string
    size: number

### ProjectCheckOptions
    root?: string
    plugins?: string
    // Where pure code shared between plugins lives.
    utils?: string
    docs?: string
    // Documents this project asks itself to hold, read from `root`; none unless named. `Project.required` is the kit's suggestion.
    required?: readonly string[]
    procedure?: string
    limit?: number
    // Signatures two plugins may each keep, because they answer different questions.
    sharing?: readonly string[]
    // Enum names two plugins may each declare, where the two are not one idea.
    apart?: readonly string[]
    // Plugins that may leave the process, each named on purpose.
    leaving?: readonly string[]

> One finding from any `Project` check, already written out as a sentence a person can act on; `check` says which check spoke.
### ProjectProblem
    check: "boundaries" | "wiring" | "oversized" | "missing" | "unexplained" | "undocumented" | "twice" | "split" | "unscoped"
    message: string

> One event, as a test sees it.
### SeenEvent
    plugin: string
    event: string
    payload: unknown

> One outbound call, as a test sees it.
### SentRequest
    method: string
    url: string
    body: unknown
    // What was sent, with a credential's value replaced by `"[redacted]"`.
    headers: Readonly<Record<string, string>> | undefined
    // The address the call was dialled at, for a plugin reaching "anywhere".
    address?: string

> One enum name two plugins each declare with overlapping but unequal members: `shared` is in both, `apart` in only one.
### SplitVocabulary
    name: string
    plugins: readonly string[]
    files: readonly string[]
    shared: readonly string[]
    apart: readonly string[]

### StartedCheckOptions
    // Routes deliberately left without a budget, each named `METHOD /path` on purpose.
    unbounded?: readonly string[]

> One finding from any `Started` check, written out as a sentence a person can act on; `check` says which check spoke.
### StartedProblem
    check: "unbounded"
    message: string

> A clock a test moves by hand, handed to a test kernel as `now`: tomorrow is one call away, and nothing waits.
### TestClock
    now: () => number
    advance: (ms: number) => number
    set: (at: number) => number

### TestKernel
    kernel: Kernel
    store: Store<DrizzleDb>
    logLines: LogLine[]
    sentRequests: () => SentRequest[]
    // Every event emitted since boot, in order.
    emittedEvents: () => SeenEvent[]
    // Everything pushed since boot, in order, with how far each was to go.
    pushed: () => ChannelMessage[]
    // An identity whose permissions `grants` decided, from claims a test names.
    granted: (claims: Readonly<Record<string, unknown>>, id?: string) => Promise<Identity>
    // Waits until every listener an emit started has finished, however long its work takes, outbox or not.
    flush: () => Promise<void>
    // Runs whatever the schedule says is due, once.
    due: () => Promise<number>
    // Runs what is due, and what that starts, until nothing is left.
    drain: (maxRounds?: number) => Promise<void>
    stop: () => Promise<void>

> What every test kernel in this process starts from when a test does not say, from `configureTestKernels`.
### TestKernelDefaults = Pick<TestKernelOptions, "outbox" | "strictReplyHeaders" | "schedule" | "sockets">

> Where a test kernel finds the plugins a test did not pass: every plugin the project holds, and the config each boots with there (a non-secret fixture).
### TestKernelFixture
    plugins: readonly Plugin[]
    config: Readonly<Record<string, Readonly<Record<string, unknown>>>>

### TestKernelOptions
    plugins: readonly Plugin[]
    config?: Readonly<Record<string, unknown>>
    respondWith?: (request: HttpRequest) => unknown
    // Whether events are kept until a listener has recorded them, as `start({ outbox: true })` does. Left out it is off, and 9.0 turns it on: pass `true` to test as a deployment with an outbox runs.
    outbox?: boolean
    // Holds every reply to the header allow-list, as `start({ strictReplyHeaders: true })` does.
    strictReplyHeaders?: boolean
    // Whether a plugin may ask for work later, as `start({ schedule: true })`.
    schedule?: boolean
    // Whether a plugin may push, as `start({ sockets: true })` does.
    sockets?: boolean
    // What the clock answers, so a test can reach tomorrow.
    now?: () => number
    // What a name resolves to for a plugin reaching "anywhere"; every name answers 93.184.215.14 when left out, so no test asks real DNS.
    lookup?: Lookup

> One contract key a procedure never documents; exported for naming only, since `findUndocumentedKeys` answers plain strings.
### UndocumentedKey
    key: string

> One field an exported type or interface declares that nothing reads: `file` is relative to the scanned root, `shape` the type's name.
### UnusedField
    file: string
    shape: string
    field: string
