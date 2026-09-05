import type { z } from "zod";

/** Anything declared carries a sentence saying what it is for. */
export type Description = {
    describe: string;
};

/** A declaration whose payload is checked before it reaches anyone. */
export type Schematic = Description & {
    schema: z.ZodType;
};

/** What a plugin may do, named so a project can grant it. */
export type Permission = Description;

/** An event a plugin publishes. Delivered after the work it announces. */
export type Event = Schematic;

/**
 * What a listener does when an event arrives.
 *
 * `payload` is `unknown`, never `never`: a handler typed `(payload: never)`
 * accepts any annotation its author writes, because of contravariance, so the
 * compiler endorses a claim about a completely different schema.
 */
export type Listener<Context, Payload = unknown> = Description & {
    handle: (payload: Payload, ctx: Context) => void | Promise<void>;
};

/** A point where a plugin may refuse what is about to happen. */
export type Hook = Schematic;

/** What a participant answers: nothing to allow, a reason to refuse. */
export type Participant<Context, Payload = unknown> = Description & {
    handle: (payload: Payload, ctx: Context) => string | undefined | Promise<string | undefined>;
};

/** Something a plugin can be asked to do, behind the permissions it names. */
export type Command<Context, Input extends z.ZodType = z.ZodType> = Schematic & {
    schema: Input;
    requires?: readonly string[];
    run: (input: z.infer<Input>, ctx: Context) => void | Promise<void>;
};

/** The verbs a route may answer. */
export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * One endpoint.
 *
 * `input` and `output` are both required, and neither is optional sugar.
 * `input` is the only thing a handler ever reads: what arrived unparsed does
 * not reach it. `output` is a whitelist of what may leave, so a column added
 * to a table tomorrow does not appear in a response by itself.
 */
export type Route<Context, Input extends z.ZodType = z.ZodType> = Description & {
    method: Method;
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

    /** Requests per window for one caller, when this route needs its own. */
    limit?: { requests: number; seconds: number };

    /**
     * Request headers this route reads, lowercase.
     *
     * Named rather than handed the lot: a handler that can read any header
     * can read the cookie carrying the session, and a log of its input then
     * carries a credential. What is not named does not arrive.
     */
    reads?: readonly string[];

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
export type EmittedEvent<Context> = Description & {
    handle: (payload: never, ctx: Context) => void | Promise<void>;
};

export type Participation<Context> = Description & {
    handle: (payload: never, ctx: Context) => string | undefined | Promise<string | undefined>;
};

export type Run<Context> = Schematic & {
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
export type Endpoint<Context> = Omit<Route<Context, z.ZodType>, "input" | "handle"> & {
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

/** Who is calling, as whatever the project decided that means. */
export type Caller = {
    /** Stable identity, or undefined when nobody is signed in. */
    id: string | undefined;

    /** What this caller may do. The project fills it; the kernel enforces it. */
    permissions: readonly string[];

    /** What the project attached: a tenant, a role, a session. Opaque here. */
    claims: Readonly<Record<string, unknown>>;
};

/** One outbound call, to a host the plugin declared. */
export type Outbound = {
    method: Method;
    url: string;
    body?: unknown;
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

    /** Who is calling. Absent outside a request, as in setup. */
    caller: Caller | undefined;

    /**
     * The request headers this route declared in `reads`, lowercase.
     *
     * Empty outside a request, and empty for anything the route did not
     * name.
     */
    headers: Readonly<Record<string, string>>;

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

    /** Calls a host this plugin declared in `outbound`. */
    fetch: (call: Outbound) => Promise<unknown>;

    events: {
        /**
         * Announces what happened. Inside a transaction it waits and is sent
         * after the commit: an event about work that rolled back is a lie.
         */
        emit: (event: string, payload: unknown) => void;
    };

    hooks: {
        /** Runs a hook and answers the first refusal, or undefined. */
        run: (hook: string, payload: unknown) => Promise<string | undefined>;
    };

    permissions: {
        has: (permission: string) => boolean;
        all: (permissions: readonly string[]) => boolean;

        /** What the project attached to this caller, unread by the kernel. */
        claims: () => Readonly<Record<string, unknown>>;
    };

    commands: {
        run: (command: string, input: unknown) => Promise<void>;

        /**
         * Runs one later, in seconds from now.
         *
         * Only a command this plugin declares, and it runs with no caller:
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
    owns: <Owned>(owned: Owned) => Owned;

    /** What this plugin took ownership of, or undefined before `setup` did. */
    owned: <Owned>() => Owned | undefined;

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
    use: <Reached>(plugin: string) => Reached;
};

/**
 * Blocks inference at this position.
 *
 * Services is inferred from what `services` returns and from nowhere else. A
 * callback taking a context would otherwise be a second inference site, and
 * two candidates for one parameter resolve to unknown.
 */
type Exactly<Result> = NoInfer<Result>;

/** Everything a plugin declares about itself. */
export type Definition<
    Schema extends z.ZodType = z.ZodType,
    Services = unknown,
    Db = unknown,
> = Description & {
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

    /** Hosts this plugin may call. Anything else is refused before it dials. */
    outbound?: readonly string[];

    services?: (ctx: Context<z.infer<Schema>, never, Db>) => Services;

    /**
     * The endpoints this plugin answers.
     *
     * Each route carries its own input schema, so `handle` reads what that
     * schema parsed rather than `unknown`. A handler taking a narrower input
     * is sound here precisely because the kernel parses before it calls: what
     * failed the schema never arrives.
     */
    routes?: readonly Endpoint<Context<z.infer<Schema>, Exactly<Services>, Db>>[];

    emits?: Readonly<Record<string, Event>>;
    listens?: Readonly<Record<string, EmittedEvent<Context<z.infer<Schema>, Exactly<Services>, Db>>>>;

    hooks?: Readonly<Record<string, Hook>>;
    participates?: Readonly<Record<string, Participation<Context<z.infer<Schema>, Exactly<Services>, Db>>>>;

    commands?: Readonly<Record<string, Run<Context<z.infer<Schema>, Exactly<Services>, Db>>>>;

    setup?: (ctx: Context<z.infer<Schema>, Exactly<Services>, Db>) => void | Promise<void>;
    teardown?: (ctx: Context<z.infer<Schema>, Exactly<Services>, Db>) => void | Promise<void>;
};

/** A plugin: its name, and what it declared. */
export type Plugin = {
    name: string;
    definition: Definition;
};
