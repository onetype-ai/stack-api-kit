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

/**
 * How far a pushed message travels.
 *
 * `connection` is the one socket that asked, `viewer` every socket one
 * person has open, `scope` everyone the claim puts together, and `everyone`
 * is what it says: written out, like `public` on a route, because a channel
 * the world may hear is a decision rather than an oversight.
 */
export type ChannelReach = "connection" | "viewer" | "scope" | "everyone";

/** A channel a plugin pushes on, and how far what it pushes goes. */
export type Channel = DescribableWithSchema & {
    reach: ChannelReach;

    /** What a listener must hold, beyond being within reach. */
    requires?: readonly string[];
};

/**
 * What a listener does when an event arrives.
 *
 * `payload` is `unknown`, never `never`: a handler typed `(payload: never)`
 * accepts any annotation its author writes, because of contravariance, so the
 * compiler endorses a claim about a completely different schema.
 */
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

/**
 * One endpoint.
 *
 * `input` and `output` are both required, and neither is optional sugar.
 * `input` is the only thing a handler ever reads: what arrived unparsed does
 * not reach it. `output` is a whitelist of what may leave, so a column added
 * to a table tomorrow does not appear in a response by itself.
 */
export type Route<Context, Input extends z.ZodType = z.ZodType> = Describable & {
    method: HttpMethod;
    path: string;
    input: Input;
    output: z.ZodType;
    requires?: readonly string[];

    /**
     * Whether an unauthenticated caller may reach this.
     *
     * Absent means no. A route is closed until it says otherwise, so
     * forgetting to think about it fails shut.
     */
    public?: boolean;

    /**
     * Requests per window for one caller, when this route needs its own.
     *
     * `countSuccess: false` counts only the calls that did not succeed, which
     * is what a route guarding a secret wants: five wrong passwords is an
     * attack, five right ones is somebody with five devices. Leave it out on
     * a route guarding cost or load, where the successful call is the
     * expensive one.
     */
    limit?: { requests: number; seconds: number; countSuccess?: boolean };

    /**
     * What kind of body this takes. JSON unless it says otherwise.
     *
     * `"form"` reads `multipart/form-data`: text parts reach `input` as
     * fields, file parts as `UploadedFile`s under their own names. RegisteredChannel rather
     * than sniffed, so a route expecting JSON can never be handed a file.
     */
    accepts?: "json" | "form";

    /**
     * Request headers this route reads, lowercase.
     *
     * Named rather than handed the lot: a handler that can read any header
     * can read the cookie carrying the session, and a log of its input then
     * carries a credential. What is not named does not arrive.
     */
    reads?: readonly string[];

    /**
     * Whether this route also sees the bytes exactly as they arrived.
     *
     * `input` is still parsed and still passes the schema: this is the same
     * body, unchanged, alongside it as `ctx.sent`.
     *
     * For one job, and it cannot be done without them: a signature computed
     * over what a partner sent. Parsing reorders keys and drops whitespace,
     * so `JSON.stringify` of the parsed value is a different string, and no
     * canonical form recovers the original: a sender is free to send
     * `{\n  "id": "a"\n}` and sign that.
     *
     * RegisteredChannel rather than always present, because bytes nobody asked for are
     * bytes a log can carry: what is not named does not arrive, as with
     * `reads`.
     */
    keepsRaw?: boolean;

    /**
     * What answers the request.
     *
     * `input` is what the route's own schema parsed, so a handler reads its
     * fields without a cast: nothing that failed the schema reaches here.
     * Return a value for a 200, or a `Reply` to say the status and
     * headers as well.
     */
    handle: (input: z.infer<Input>, ctx: Context) => unknown | Promise<unknown>;
};

/**
 * A listener, participant or command, whatever payload it was written for.
 *
 * Each is written against the schema it answers and stored beside others
 * written against different ones, so a list holds "some listener" rather than
 * one shape. Sound because the kernel parses before it calls.
 */
export type EmittedEvent<Context> = Describable & {
    handle: (payload: never, ctx: Context) => void | Promise<void>;
};

export type Participation<Context> = Describable & {
    handle: (payload: never, ctx: Context) => string | undefined | Promise<string | undefined>;
};

export type AnyCommand<Context> = DescribableWithSchema & {
    requires?: readonly string[];
    run: (input: never, ctx: Context) => void | Promise<void>;
};

/**
 * One route, whatever its input schema.
 *
 * A route is written against its own schema and stored beside routes written
 * against others, so what a list holds is "some route", not one shape. This
 * says that without reaching for `any`.
 */
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

/**
 * What `identifies` answers: an identity without permissions.
 *
 * `permissions?: never` is not decoration. Without it a plugin may write them
 * in, TypeScript allows it through the union a return type is, and the kernel
 * drops them without a word: `grants` fills them, so nobody grants themselves.
 */
export type IdentifiedCaller = Omit<Identity, "permissions"> & { permissions?: never };

/** One outbound call, to a host the plugin declared. */
export type HttpRequest = {
    method: HttpMethod;
    url: string;
    body?: unknown;

    /**
     * What the answer is read as. RegisteredChannel, never sniffed: a page that
     * answers html one day and json the next changes nothing here, and a
     * caller always knows which of the two it holds. Left out, json.
     */
    accepts?: "json" | "text";

    headers?: Readonly<Record<string, string>> | undefined;
    signal?: AbortSignal | undefined;
};

/** What every plugin function receives. */
export type Context<Config = unknown, Services = unknown, Db = unknown> = {
    name: string;
    config: Config;
    services: Services;

    log: Logger;

    /**
     * What time it is, in milliseconds.
     *
     * Reached through the context rather than `Date.now()` so a test can pin
     * it: what happens tomorrow is otherwise only testable by moving the
     * machine's clock, which every other test in the process then shares.
     */
    now: () => number;

    /** Who this request is for. Absent outside a request, as in setup. */
    identity: Identity | undefined;

    /**
     * The request headers this route declared in `reads`, lowercase.
     *
     * Empty outside a request, and empty for anything the route did not
     * name.
     */
    headers: Readonly<Record<string, string>>;

    /**
     * The bytes of the request body, exactly as they arrived.
     *
     * Present only where the route declared `keepsRaw`, and only inside a
     * request. `input` holds the same body parsed and checked; this holds
     * what a signature was computed over.
     */
    sent: Uint8Array | undefined;

    /**
     * This plugin's own tables.
     *
     * The handle carries only what this plugin declared, so a query naming
     * another plugin's table does not compile. The connection underneath is
     * shared, so the boundary is the compiler's rather than the database's.
     */
    db: Db;

    /**
     * Runs one query outside a transaction, in its turn.
     *
     * A query issued while another request's transaction is parked on an
     * await joins that transaction and dies with its rollback, having told
     * its caller it succeeded. Reads are safe without this; a write is not.
     */
    write: <Result>(run: () => Promise<Result>) => Promise<Result>;

    /**
     * Runs work in one transaction, rolled back if it throws.
     *
     * The callback is handed a context of its own, not just a handle: what it
     * emits waits for the commit, and a `tx` inside it joins this one
     * rather than opening a second. A caller that used the outer `ctx` would
     * be writing outside the transaction it just opened.
     */
    tx: <Result>(run: (ctx: Context<Config, Services, Db>) => Promise<Result>) => Promise<Result>;

    /** Calls a host this plugin declared in `allowedHosts`. */
    fetch: (call: HttpRequest) => Promise<unknown>;

    events: {
        /**
         * Announces what happened. Inside a transaction it waits and is sent
         * after the commit: an event about work that rolled back is a lie.
         */
        emit: (event: string, payload: unknown) => void;
    };

    /**
     * Sends a message to whoever is listening on a channel this plugin
     * declared, as far as its `reach` says and no further.
     *
     * An event tells the rest of the api; a push tells whoever is watching.
     * Nothing waits for either.
     */
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

        /**
         * Runs one later, in seconds from now.
         *
         * Only a command this plugin declares, and it runs for nobody:
         * whatever it needs to know about whose work it is travels in the
         * input, exactly as an event's payload does.
         *
         * Asked for inside a transaction, it is written by that transaction
         * and rolls back with it. A command that throws is tried again.
         */
        later: (command: string, input: unknown, inSeconds: number) => void;
    };

    /**
     * Takes ownership of something that outlives a request.
     *
     * Services are built per request, because one holding a caller would
     * answer the next request as the previous one. A connection is the
     * opposite: opened once in `setup`, used by every request, closed in
     * `teardown`. This is where it lives, one per plugin, and no plugin
     * reaches another's.
     */
    owns: <Kept>(kept: Kept) => Kept;

    /** What this plugin took ownership of, or undefined before `setup` did. */
    owned: <Kept>() => Kept | undefined;

    /**
     * What narrows every read of a table this plugin declared a `scope` for.
     *
     * Answers the caller's value for the declared claim, refusing when there
     * is none. Nothing makes a query call this: one that forgets reads every
     * scope's rows and compiles, which is why every scoped read is tested
     * with a stranger's id.
     *
     * ```ts
     * .where(and(eq(items.id, id), ctx.scoped("items")))
     * ```
     */
    scoped: <Condition = unknown>(table: string) => Condition;

    /**
     * The row's scope column, filled from the caller.
     *
     * A condition narrows a read, and an insert has no condition: without
     * this, a caller in one tenant can write a row stamped with another's.
     * Spread it over what you are writing so the column is not yours to
     * remember, or to get wrong.
     *
     * ```ts
     * .values({ ...row, ...ctx.stamped("items") })
     * ```
     */
    stamped: (table: string) => Readonly<Record<string, string>>;

    /**
     * The same plugin, acting for the scope this names.
     *
     * A listener runs on nobody's behalf, so `scoped` and `stamped` refuse
     * there, and every method they reach refuses with them. This says whose
     * work the payload announced, so the ordinary path works instead of a
     * second unscoped one written beside it.
     *
     * ```ts
     * handle: (gone, ctx) => Orders.dropFor(ctx.forScope(gone.shopId), gone.id)
     * ```
     *
     * Refused where a caller already exists: inside a request the scope is
     * decided by who is asking, and choosing another there is how a caller
     * reaches rows that are not theirs.
     */
    forScope: (claim: string) => Context<Config, Services, Db>;

    /** Another plugin's services, by name. Only what `dependsOn` names. */
    use: <Api>(plugin: string) => Api;
};

/**
 * Blocks inference at this position.
 *
 * Services is inferred from what `services` returns and from nowhere else. A
 * callback taking a context would otherwise be a second inference site, and
 * two candidates for one parameter resolve to unknown.
 */
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

    /**
     * Which claim decides whose rows these are, and where each table carries
     * it.
     *
     * The kit knows nothing about tenants: it does not know what one is, what
     * the claim means, or whether a project has any. What it knows, once this
     * is declared, is that a read of a named table without that column is a
     * read of somebody else's rows, so `ctx.db` stops handing one out and
     * `ctx.scoped` hands out the query already narrowed.
     *
     * Declaring it also decides the failure: a caller carrying no such claim
     * is refused rather than defaulted, because a default tenant is
     * everybody's tenant.
     */
    scope?: {
        describe: string;
        claim: string;
        tables: Readonly<Record<string, string>>;
    };

    /** Where its migrations live, run in dependency order before setup. */
    migrations?: string;

    /**
     * Hosts this plugin may call. Anything else is refused before it dials.
     *
     * `"anywhere"` is for the plugin whose hosts are a row rather than a
     * constant: a site a customer typed in five minutes ago cannot be
     * written here. It widens what may be reached and narrows nothing else:
     * a private address, a scheme that is not https, a port the web is not
     * served on and a credential in the url stay refused, and the address a
     * name resolves to is checked rather than the name.
     */
    allowedHosts?: readonly string[] | "anywhere";

    services?: (ctx: Context<z.infer<Schema>, never, Db>) => Services;

    /**
     * The endpoints this plugin answers.
     *
     * Each route carries its own input schema, so `handle` reads what that
     * schema parsed rather than `unknown`. A handler taking a narrower input
     * is sound here precisely because the kernel parses before it calls: what
     * failed the schema never arrives.
     */
    routes?: readonly AnyRoute<Context<z.infer<Schema>, NoExtraKeys<Services>, Db>>[];

    emits?: Readonly<Record<string, Event>>;

    /** Channels it pushes on. What it pushes is checked against the schema. */
    channels?: Readonly<Record<string, Channel>>;
    listens?: Readonly<Record<string, EmittedEvent<Context<z.infer<Schema>, NoExtraKeys<Services>, Db>>>>;

    hooks?: Readonly<Record<string, Hook>>;
    participates?: Readonly<Record<string, Participation<Context<z.infer<Schema>, NoExtraKeys<Services>, Db>>>>;

    commands?: Readonly<Record<string, AnyCommand<Context<z.infer<Schema>, NoExtraKeys<Services>, Db>>>>;

    /**
     * Who is calling, read from the request this plugin knows how to read.
     *
     * At most one plugin declares this, and it is the one holding sessions: a
     * composition root that had to wire it would have to know which plugin
     * that is, and would go stale the day it was replaced.
     *
     * Answers the identity, or nothing for a stranger. Throwing is 401, never
     * 500. `permissions` is filled from `grants`, so this never names one.
     */
    identifies?: (
        ctx: Context<z.infer<Schema>, NoExtraKeys<Services>, Db>,
        request: Request,
    ) => Promise<IdentifiedCaller | undefined> | IdentifiedCaller | undefined;

    /**
     * What being signed in means here.
     *
     * At most one plugin declares this. Named as strings, so the plugin that
     * grants a permission never imports the one that declared it, exactly as
     * a route naming `requires` does not.
     *
     * The kernel refuses to start when a route requires a permission nothing
     * grants: a route nobody can reach is the error this exists to catch.
     */
    grants?: (
        ctx: Context<z.infer<Schema>, NoExtraKeys<Services>, Db>,
        identity: Omit<Identity, "permissions">,
    ) => Promise<readonly string[]> | readonly string[];

    /**
     * Every permission `grants` may ever answer.
     *
     * Read at startup, where no request exists, so the check runs before
     * anything is served rather than on whoever asked first.
     */
    mayGrant?: readonly string[];

    setup?: (ctx: Context<z.infer<Schema>, NoExtraKeys<Services>, Db>) => void | Promise<void>;
    teardown?: (ctx: Context<z.infer<Schema>, NoExtraKeys<Services>, Db>) => void | Promise<void>;
};

/** A plugin: its name, and what it declared. */
export type Plugin = {
    name: string;
    definition: Definition;
};
