import type { z } from "zod";

/** Anything declared carries a sentence saying what it is for. */
export type Describable = {
    describe: string;
};

/** A declaration whose payload is checked before it reaches anyone. */
export type DescribableWithSchema = Describable & {
    schema: z.ZodType;
};

/** What a plugin may do, named so a project can grant it. */
export type Permission = {
    describe: string;
};

/** An event a plugin publishes. Delivered after the work it announces. */
export type Event = {
    describe: string;
    schema: z.ZodType;
};

/** `connection` is the one socket that asked, `viewer` every socket one person has open, `scope` everyone the claim puts together, `everyone` all of them. */
/** `everyone` is written out, like `public` on a route, so a world-readable channel is a decision rather than an oversight. */
export type ChannelReach = "connection" | "viewer" | "scope" | "everyone";

/** A channel a plugin pushes on, and how far what it pushes goes. */
export type Channel = DescribableWithSchema & {
    reach: ChannelReach;

    /** What a listener must hold, beyond being within reach. */
    requires?: readonly string[];
};

/** `payload` is `unknown`, never `never`: contravariance lets `(payload: never)` accept any annotation, so the compiler endorses a claim about a different schema. */
export type Listener<Context, Payload = unknown> = Describable & {
    handle: (payload: Payload, ctx: Context) => void | Promise<void>;
};

/** A point where a plugin may refuse what is about to happen. */
export type Hook = {
    describe: string;
    schema: z.ZodType;
};

/** What a participant answers: nothing to allow, a reason to refuse. */
export type Participant<Context, Payload = unknown> = Describable & {
    handle: (payload: Payload, ctx: Context) => string | undefined | Promise<string | undefined>;
};

/** Something a plugin can be asked to do, behind the permissions it names. */
export type Command<Context, Input extends z.ZodType = z.ZodType> = Describable & {
    schema: Input;
    requires?: readonly string[];
    run: (input: z.infer<Input>, ctx: Context) => void | Promise<void>;
};

/** The verbs a route may answer. */
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/** What a download may be sent as: never a type a browser would render and run. */
export type FileType = "text/csv" | "text/plain" | "application/json" | "application/pdf" | "application/zip" | "application/octet-stream";

/** A page's content security policy as named source lists; each is written as one directive, `'none'` where left out for default-src, base-uri and frame-ancestors. A source holding `;`, `,` or whitespace is refused, as are 'unsafe-eval' anywhere and 'unsafe-inline' in scriptSrc. */
export type DocumentPolicy = {
    defaultSrc?: readonly string[];
    scriptSrc?: readonly string[];
    styleSrc?: readonly string[];
    fontSrc?: readonly string[];
    connectSrc?: readonly string[];
    imgSrc?: readonly string[];
    frameAncestors?: readonly string[];
    baseUri?: readonly string[];
    formAction?: readonly string[];
};

/** One endpoint: `output` is a whitelist of what may leave, so a column added to a table tomorrow does not appear in a response by itself. */
export type Route<Context, Input extends z.ZodType = z.ZodType> = Describable & {
    method: HttpMethod;
    path: string;
    input: Input;

    /** What one answer may carry. Declared with `streams` as well, the route answers JSON when `handle` answers a value and events when it answers an iterable or `Reply.events`. */
    output?: z.ZodType;

    /** What each event of a streamed answer may carry, parsed like `output`: `handle` answers an iterable, sync or async, of values or `ServerEvent`s, sent as Server-Sent Events. Requires, limit, input and scope are decided before the first event; a failure after it ends the stream with an `error` event. */
    streams?: z.ZodType;

    /** Declares an HTML page instead of `output`: `handle` answers `Reply.document(html, …)` or a string. Only such a route may send a policy of its own; frame-ancestors other than 'none' needs `framable: true`. */
    document?: { policy?: DocumentPolicy; framable?: boolean };

    /** Declares a download instead of `output`: `handle` answers `Reply.file(body, { type, filename })`, always sent as an attachment, as one of the types named here. */
    file?: { types: readonly FileType[] };

    /** How long one stream of this route may stay open, in seconds (300 when left out); it then ends with an `error` event of code EXPIRED, and the client reconnects, which checks the caller again. */
    streamSeconds?: number;

    /** What the caller must hold. Every route says something: name a permission, mark it `public`, or write `requires: []` for one any signed-in caller may reach. Leaving it out is refused at startup. */
    requires?: readonly string[];

    /** Whether an unauthenticated caller may reach this. Absent means no, so forgetting to think about it fails shut. */
    public?: boolean;

    /** Requests per window for one caller. */
    /** `countSuccess: false` counts only failed calls, for a route guarding a secret: five wrong passwords is an attack, five right ones is five devices. */
    limit?: { requests: number; seconds: number; countSuccess?: boolean };

    /** What kind of body this takes, JSON unless it says otherwise; `"form"` reads `multipart/form-data`, file parts as `UploadedFile`s. */
    /** Declared rather than sniffed, so a route expecting JSON can never be handed a file. */
    accepts?: "json" | "form";

    /** Request headers this route reads, lowercase; what is not named does not arrive. */
    /** Named rather than handed the lot: a handler reading any header reads the session cookie, and its log then carries a credential. */
    reads?: readonly string[];

    /** Response headers this route sets beyond the kit's short list (location, retry-after, content-disposition, vary, etag, cache-control and the session headers), lowercase. A header governing how a browser treats the response is never one a route may name. */
    sends?: readonly string[];

    /** Whether this route also sees the bytes exactly as they arrived, as `ctx.sent`; `input` is still parsed and still passes the schema. */
    /** For signature checks: parsing reorders keys and drops whitespace, so `JSON.stringify` of the parsed body is a different string and no canonical form recovers the original. */
    /** Declared rather than always present, because bytes nobody asked for are bytes a log can carry. */
    keepsRaw?: boolean;

    /** What answers the request: return a value for a 200, or a `Reply` to say the status and headers as well. */
    handle: (input: z.infer<Input>, ctx: Context) => unknown | Promise<unknown>;
};

/** A listener, participant or command, whatever payload it was written for. See `AnyRoute`. */
export type EmittedEvent<Context> = Describable & {
    handle: (payload: never, ctx: Context) => void | Promise<void>;
};

/** The type-erased `Participant`, alongside `AnyCommand` and `AnyRoute`: its handler still answers `undefined` to allow or a string to refuse, but takes `never` so a list may hold participants written for different payloads. */
export type Participation<Context> = Describable & {
    handle: (payload: never, ctx: Context) => string | undefined | Promise<string | undefined>;
};

/** The type-erased `Command`, alongside `Participation` and `AnyRoute`: it keeps `schema` and `requires`, and takes `never` so a record may hold commands written for different inputs. */
export type AnyCommand<Context> = DescribableWithSchema & {
    requires?: readonly string[];
    run: (input: never, ctx: Context) => void | Promise<void>;
};

/** One route, whatever its input schema: a list holds "some route" rather than one shape, without reaching for `any`. */
export type AnyRoute<Context> = Omit<Route<Context, z.ZodType>, "input" | "handle"> & {
    input: z.ZodType;
    handle: (input: never, ctx: Context) => unknown | Promise<unknown>;
};

/** Where a plugin's lines go. The project decides. */
export type Logger = {
    debug: (line: string, about?: Readonly<Record<string, unknown>>) => void;
    info: (line: string, about?: Readonly<Record<string, unknown>>) => void;
    warn: (line: string, about?: Readonly<Record<string, unknown>>) => void;
    error: (line: string, about?: Readonly<Record<string, unknown>>) => void;
};

/** Who this is, as whatever the project decided that means. Nobody signed in is no identity at all. */
export type Identity = {
    id: string;

    /** What they may do. The project fills it; the kernel enforces it. */
    permissions: readonly string[];

    /** What the project attached: a tenant, a role, a session. Opaque here. */
    claims: Readonly<Record<string, unknown>>;
};

/** What `identifies` answers: an identity without permissions, which `grants` fills so nobody grants themselves. */
/** `permissions?: never` is load-bearing: without it a plugin may write permissions in and the kernel drops them silently. */
export type IdentifiedCaller = Omit<Identity, "permissions"> & { permissions?: never };

/** One outbound call, to a host the plugin declared. */
export type HttpRequest = {
    method: HttpMethod;
    url: string;
    body?: unknown;

    /** What the answer is read as, json when left out. Declared, never sniffed, so a host that changes content type changes nothing here. */
    /** `"stream"` answers a `StreamedResponse` once the headers arrive, the body read as it comes; a status outside 2xx still throws before any of it is handed over. */
    accepts?: "json" | "text" | "stream";

    headers?: Readonly<Record<string, string>> | undefined;
    signal?: AbortSignal | undefined;

    /** How long the whole call may take, reading included: the client's default when left out, never more than its `mostTimeoutMs`. */
    timeoutMs?: number | undefined;

    /** The longest silence allowed between two chunks of a streamed answer. */
    idleMs?: number | undefined;

    /** The most bytes this answer may carry, streamed or read whole: a whole number above 0. The client's `maxBytes` when left out; more than its `mostMaxBytes` is clamped to it. */
    maxBytes?: number | undefined;

    /**
     * What a 301, 302, 303, 307 or 308 does, only under allowedHosts "anywhere". "refuse" (the default) throws NETWORK.
     * "manual" hands it back: a streamed answer with its `status` and absolute `location`, or, read whole, `HttpRequestError` REDIRECT carrying them.
     * "follow" dials each hop checked like a first call, turning 303, and a 301 or 302 after a POST, into a GET without a body
     * as the fetch standard does, and dropping this call's headers on another origin. `timeoutMs` then bounds the whole chain, 30000 when left out.
     */
    redirects?: "refuse" | "manual" | "follow" | undefined;

    /** How many hops "follow" takes before throwing TOO_MANY_REDIRECTS: 5 when left out, at most 10. */
    mostRedirects?: number | undefined;
};

/** A streamed answer: the body arrives chunk by chunk, still bounded by the call's bytes, time limits and signal; leaving the loop early cancels it. */
export type StreamedResponse = {
    status: number;
    headers: Readonly<Record<string, string>>;

    /** The address that answered: the last hop's, after redirects "follow". */
    url: string;

    /** Where a redirect handed back by redirects "manual" points, absolute; its body is empty. */
    location?: string;

    body: AsyncIterable<Uint8Array>;
};

/** What every plugin function receives. */
export type Context<Config = unknown, Services = unknown, Db = unknown> = {
    name: string;
    config: Config;
    services: Services;

    log: Logger;

    /** What time it is, in milliseconds. On the context rather than `Date.now()` because pinning the clock otherwise affects every other test in the process. */
    now: () => number;

    /** Who this request is for. Absent outside a request, as in setup. */
    identity: Identity | undefined;

    /** The request headers this route declared in `reads`, lowercase. Empty outside a request. */
    headers: Readonly<Record<string, string>>;

    /** The bytes of the request body exactly as they arrived, present only where the route declared `keepsRaw`. */
    sent: Uint8Array | undefined;

    /** Aborts when the caller goes away, as a client closing a stream does. Absent outside a request. */
    signal: AbortSignal | undefined;

    /** This plugin's own tables: a query naming another plugin's table does not compile. */
    /** The connection underneath is shared, so the table boundary is the compiler's rather than the database's. */
    db: Db;

    /** Runs one query outside a transaction, in its turn: a query awaiting during another's transaction joins it and dies with its rollback after reporting success. */
    write: <Result>(run: () => Promise<Result>) => Promise<Result>;

    /** Runs work in one transaction, rolled back if it throws. */
    /** The callback is handed a context of its own, not just a handle: using the outer `ctx` writes outside the transaction just opened. */
    /** A `tx` inside the callback joins this one rather than opening a second. */
    tx: <Result>(run: (ctx: Context<Config, Services, Db>) => Promise<Result>) => Promise<Result>;

    /** Calls a host this plugin declared in `allowedHosts`. */
    fetch: {
        (call: HttpRequest & { accepts: "stream" }): Promise<StreamedResponse>;
        (call: HttpRequest): Promise<unknown>;
    };

    events: {
        /** Announces what happened; inside a transaction it waits for the commit, because an event about rolled-back work is a lie. */
        emit: (event: string, payload: unknown) => void;
    };

    /** Sends a message on a channel this plugin declared, as far as its `reach` says and no further. Nothing waits for it. */
    push: (channel: string, message: unknown) => void;

    hooks: {
        /** Runs a hook and answers the first refusal, or undefined. */
        run: (hook: string, payload: unknown) => Promise<string | undefined>;
    };

    permissions: {
        has: (permission: string) => boolean;
        all: (permissions: readonly string[]) => boolean;

        /** What the project attached to this identity, unread by the kernel. */
        claims: () => Readonly<Record<string, unknown>>;
    };

    commands: {
        run: (command: string, input: unknown) => Promise<void>;

        /** Runs one later, in seconds from now: only a command this plugin declares, and it runs for nobody, so whose work it is travels in the input. */
        /** Asked for inside a transaction it is written by that transaction and rolls back with it; a command that throws is tried again. */
        later: (command: string, input: unknown, inSeconds: number) => void;
    };

    /** Takes ownership of something that outlives a request: one per plugin, opened in `setup` and closed in `teardown`, and no plugin reaches another's. */
    /** Services are built per request instead, because one holding a caller would answer the next request as the previous one. */
    owns: <Kept>(kept: Kept) => Kept;

    /** What this plugin took ownership of, or undefined before `setup` did. */
    owned: <Kept>() => Kept | undefined;

    /** What narrows every read of a table this plugin declared a `scope` for: `.where(and(eq(items.id, id), ctx.scoped("items")))`. */
    /** The compiler does not require this: a query without it reads every scope's rows. Project.findAll names such a query at check time; `ctx.forScope(claim)` narrows one the request does not name, such as a scheduled run. */
    scoped: <Condition = unknown>(table: string) => Condition;

    /** The row's scope column, filled from the caller: `.values({ ...row, ...ctx.stamped("items") })`. */
    /** An insert has no condition to narrow, so this is the only thing preventing a caller in one tenant writing a row stamped with another's. */
    stamped: (table: string) => Readonly<Record<string, string>>;

    /** The same plugin, acting for the scope this names, where a listener runs on nobody's behalf: `ctx.forScope(gone.shopId)`. */
    /** Refused inside a request, where the scope is decided by who is asking: choosing another there is how a caller reaches another tenant's rows. */
    forScope: (claim: string) => Context<Config, Services, Db>;

    /** Another plugin's services, by name. Only what `dependsOn` names. */
    use: <Api>(plugin: string) => Api;
};

// Blocks a second inference site: a callback taking a context would be one, and two candidates for one parameter resolve to unknown.
type NoExtraKeys<Given> = NoInfer<Given>;

/** Everything a plugin declares about itself. */
export type Definition<
    Schema extends z.ZodType = z.ZodType,
    Services = unknown,
    Db = unknown,
> = Describable & {
    version: string;
    dependsOn?: readonly string[];
    config?: Schema;

    permissions?: Readonly<Record<string, Permission>>;

    /** This plugin's tables, in its own namespace. Nobody else reads them. */
    tables?: Readonly<Record<string, unknown>>;

    /** Which claim decides whose rows these are, and where each table carries it. */
    /** `ctx.scoped` narrows a named table and refuses a caller carrying no such claim, because a default tenant is everybody's tenant; `ctx.db` is the unnarrowed read a shared table needs, and stays unnarrowed. */
    scope?: {
        describe: string;
        claim: string;
        tables: Readonly<Record<string, string>>;
    };

    /** Where its migrations live, run in dependency order before setup. */
    migrations?: string;

    /** Hosts this plugin may call, anything else refused before it dials; `"anywhere"` is for a plugin whose hosts are a row rather than a constant. */
    /** `"anywhere"` relaxes nothing else: private address, non-https scheme, off-port and credential-in-url stay refused, and the resolved address is checked rather than the name. */
    allowedHosts?: readonly string[] | "anywhere";

    services?: (ctx: Context<z.infer<Schema>, never, Db>) => Services;

    /** The endpoints this plugin answers, each carrying its own input schema; a narrower handler input is sound because the kernel parses before it calls. */
    routes?: readonly AnyRoute<Context<z.infer<Schema>, NoExtraKeys<Services>, Db>>[];

    emits?: Readonly<Record<string, Event>>;

    /** Channels it pushes on. What it pushes is checked against the schema. */
    channels?: Readonly<Record<string, Channel>>;
    listens?: Readonly<Record<string, EmittedEvent<Context<z.infer<Schema>, NoExtraKeys<Services>, Db>>>>;

    hooks?: Readonly<Record<string, Hook>>;
    participates?: Readonly<Record<string, Participation<Context<z.infer<Schema>, NoExtraKeys<Services>, Db>>>>;

    commands?: Readonly<Record<string, AnyCommand<Context<z.infer<Schema>, NoExtraKeys<Services>, Db>>>>;

    /** Who is calling, read from the request this plugin knows how to read; at most one plugin declares this, and answers nothing for a stranger. */
    /** Throwing in here is 401, never 500. */
    identifies?: (
        ctx: Context<z.infer<Schema>, NoExtraKeys<Services>, Db>,
        request: Request,
    ) => Promise<IdentifiedCaller | undefined> | IdentifiedCaller | undefined;

    /** What being signed in means here; at most one plugin declares it, named as strings so the granting plugin never imports the declaring one. */
    /** The kernel refuses to start when a route requires a permission nothing grants. */
    grants?: (
        ctx: Context<z.infer<Schema>, NoExtraKeys<Services>, Db>,
        identity: Omit<Identity, "permissions">,
    ) => Promise<readonly string[]> | readonly string[];

    /** Every permission `grants` may ever answer, read at startup so the check runs before anything is served rather than on whoever asked first. */
    /** The closed set `grants` answers from, so a route requiring a permission outside it is refused at startup rather than answering 403 forever. */
    /** Left out, `grants` may answer anything any plugin declares, and no route can be checked as unreachable. Named after OIDC's `scopes_supported`, which it is. */
    grantsSupported?: readonly string[];

    setup?: (ctx: Context<z.infer<Schema>, NoExtraKeys<Services>, Db>) => void | Promise<void>;
    teardown?: (ctx: Context<z.infer<Schema>, NoExtraKeys<Services>, Db>) => void | Promise<void>;
};

/** A plugin: its name, and what it declared. */
export type Plugin = {
    name: string;
    definition: Definition;
};
