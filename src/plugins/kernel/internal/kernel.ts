import { AsyncLocalStorage } from "node:async_hooks";

import { Refusal } from "./refusal";
import { context, type KernelWiring } from "./context";
import type { Identity, Context, HttpMethod, Plugin, ChannelReach, Route } from "./contract";
import { events, type ListenerFailure, type PendingDelivery } from "./events";
import { KernelFault } from "./faults";
import { hooks } from "./hooks";
import { order } from "./order";
import { createPermissions } from "./permissions";
import { type RateLimiter, type KernelRequest, type RouteOwner, notServing, type KernelResponse, respond, unknownRoute } from "./request";
import type { FailedJob, HttpClient, ScopeFilter, Outbox, Schedule, Sockets, KernelStore } from "./store";
import { validate } from "./validate";

/** Where a line goes. The project decides; a plugin never writes directly. */
export type LogFn = (
    level: "debug" | "info" | "warn" | "error",
    plugin: string,
    line: string,
    about?: Readonly<Record<string, unknown>>,
) => void;

/** What a project gives the kernel. */
export type KernelOptions = {
    plugins: readonly Plugin[];
    config?: Readonly<Record<string, unknown>>;
    db?: KernelStore;

    /** What holds the open sockets. Without one, ctx.push throws. */
    sockets?: Sockets;
    httpClient?: HttpClient;
    log?: LogFn;

    /** What counts requests against a route's declared budget. */
    rateLimiter?: RateLimiter;

    /** Where events wait between the transaction that emitted them and the listener that hears them. */
    outbox?: Outbox;

    /** What the current time is, in milliseconds. */
    now?: () => number;

    /** Where work waits until it is time, and how often to look. */
    schedule?: Schedule;

    /** How often to ask the schedule what is due, in milliseconds. */
    beatMs?: number;

    /** How many times a scheduled command may throw before it is abandoned. */
    mostAttempts?: number;

    /** How a declared scope becomes a condition the store understands. */
    scopeFilter?: ScopeFilter;

    /** How long a hook participant has to answer, in milliseconds. */
    hookTimeoutMs?: number;
};

/** A route, and the plugin it came from. */
/** One channel a plugin declared, as a reader of the api sees it. */
export type RegisteredChannel = {
    plugin: string;
    channel: string;
    reach: ChannelReach;
    requires: readonly string[];
};

/** One permission a plugin declared, and what holding it means. */
export type PermissionEntry = {
    plugin: string;
    permission: string;
    describe: string;
};

export type RegisteredRoute = {
    plugin: string;
    method: HttpMethod;
    path: string;
    describe: string;
    requires: readonly string[];
    public: boolean;
    limit: { requests: number; seconds: number } | undefined;

    /** What kind of body it takes: JSON unless it declared a form. */
    accepts: "json" | "form";

    /** The request headers this route declared it reads, lowercase. */
    reads: readonly string[];

    /** Whether it also sees the body's bytes as they arrived. */
    keepsRaw: boolean;
};

/** What a project holds after createKernel. */
export type Kernel = {
    start: () => Promise<void>;
    stop: () => Promise<void>;
    started: () => boolean;

    routes: () => readonly RegisteredRoute[];

    /** Every channel a plugin declared, and what it takes to hear one. */
    channels: () => readonly RegisteredChannel[];

    /** Every permission any plugin declared. */
    permissions: () => readonly PermissionEntry[];
    handle: (incoming: KernelRequest) => Promise<KernelResponse>;

    context: (plugin: string, identity?: Identity) => Context;

    /** Who is calling, asked of the plugin that knows. */
    identify: ((request: Request) => Promise<Identity | undefined>) | undefined;

    events: { failures: () => readonly ListenerFailure[] };

    /** What the schedule did that nobody is waiting on. */
    work: { failed: () => readonly FailedJob[] };

    /** Runs whatever the schedule says is due, once, and waits for it. */
    due: () => Promise<number>;
    run: (command: string, input: unknown, identity?: Identity) => Promise<void>;
};

const quiet: LogFn = () => {};

/** The route a request lands on, and what its path segments named. */
/** One path segment, decoded, or undefined when it cannot be. */
function decodeSegment(given: string): string | undefined
{
    try
    {
        return decodeURIComponent(given);
    }
    catch
    {
        return undefined;
    }
}

function routeFor(
    routes: ReadonlyMap<string, RouteOwner>,
    method: HttpMethod,
    path: string,
): { mounted: RouteOwner; params: Readonly<Record<string, string>> } | undefined
{
    const exact = routes.get(`${method} ${path}`);

    if (exact !== undefined)
    {
        return { mounted: exact, params: {} };
    }

    const segments = path.split("/");

    const plain = routes.get(`${method} ${segments.map((segment) => decodeSegment(segment) ?? segment).join("/")}`);

    if (plain !== undefined)
    {
        return { mounted: plain, params: {} };
    }

    for (const [key, mounted] of routes)
    {
        const [verb, pattern] = key.split(" ");

        if (verb !== method || pattern === undefined)
        {
            continue;
        }

        const parts = pattern.split("/");

        if (parts.length !== segments.length)
        {
            continue;
        }

        const params: Record<string, string> = {};
        const fits = parts.every((part, at) =>
        {
            const segment = segments[at] ?? "";

            if (!part.startsWith(":"))
            {
                return part === decodeSegment(segment);
            }

            const value = decodeSegment(segment);

            if (value === undefined)
            {
                return false;
            }

            params[part.slice(1)] = value;

            return segment !== "";
        });

        if (fits)
        {
            return { mounted, params };
        }
    }

    return undefined;
}

/** The input a route sees: what the caller passed, with the path on top. */
function withPathParams(input: unknown, params: Readonly<Record<string, string>>): unknown
{
    if (Object.keys(params).length === 0)
    {
        return input;
    }

    const body = input !== null && typeof input === "object" && !Array.isArray(input)
        ? { ...(input as Record<string, unknown>) }
        : {};

    return { ...body, ...params };
}

/** Builds a kernel from what the plugins declared. */
export function createKernel(options: KernelOptions): Kernel
{
    const config = options.config ?? {};
    const log = options.log ?? quiet;

    const known = new Map(options.plugins.map((plugin) => [plugin.name, plugin]));

    const identifying = options.plugins.find((plugin) => plugin.definition.identifies !== undefined);
    const granting = options.plugins.find((plugin) => plugin.definition.grants !== undefined);
    const bus = events<Context>(Date.now, (plugin, line, about) =>
    {
        log("error", plugin, line, about);
    });
    const points = hooks<Context>(options.hookTimeoutMs);
    const settings = new Map<string, unknown>();
    const pending = new Map<object, PendingDelivery[]>();

    const routes = new Map<string, RouteOwner>();
    const commands = new Map<string, {
        plugin: string;
        requires: readonly string[];
        schema: { safeParse: (value: unknown) => { success: boolean; data?: unknown; error?: { issues: { message: string }[] } } };
        run: (input: never, ctx: Context) => void | Promise<void>;
    }>();

    let running = false;
    let beating: ReturnType<typeof setInterval> | undefined;

    /** Queued work that ran out of attempts. */
    const failedJobs: FailedJob[] = [];
    const MOST_REMEMBERED = 100;

    /** Whether a failure is the command's final answer. */
    function isFinalRefusal(cause: unknown): boolean
    {
        if (!(cause instanceof Refusal))
        {
            return false;
        }

        return cause.status >= 400 && cause.status < 500 && cause.status !== 408 && cause.status !== 429;
    }

    /** Runs what is due, one turn. */
    async function due(): Promise<number>
    {
        if (options.schedule === undefined || !running)
        {
            return 0;
        }

        const clock = options.now ?? Date.now;
        const taken = await options.schedule.claim(clock(), 20);

        for (const job of taken)
        {
            try
            {
                await run(job.command, job.input);
                await options.schedule.markDone(job.id);
            }
            catch (cause)
            {
                log("error", job.plugin, "a scheduled command failed", {
                    command: job.command,
                    attempts: job.attempts + 1,
                    error: cause instanceof Error ? cause.message : String(cause),
                });

                const final = isFinalRefusal(cause);

                if (final || job.attempts + 1 >= (options.mostAttempts ?? 8))
                {
                    log("error", job.plugin, final ? "a scheduled command was refused for good" : "a scheduled command gave up", {
                        command: job.command,
                        attempts: job.attempts + 1,
                        ...(final && { meaning: "the command answered 4xx, which says the work itself is wrong, so it is not tried again. Throw instead of refusing if waiting would help." }),
                    });

                    failedJobs.push({
                        plugin: job.plugin,
                        command: job.command,
                        input: job.input,
                        attempts: job.attempts + 1,
                        error: cause,
                        at: clock(),
                    });

                    if (failedJobs.length > MOST_REMEMBERED)
                    {
                        failedJobs.splice(0, failedJobs.length - MOST_REMEMBERED);
                    }

                    await options.schedule.giveUp(job.id);
                }
                else
                {
                    await options.schedule.markFailed(job.id, clock() + Math.min(2 ** job.attempts, 60) * 1000);
                }
            }
        }

        return taken.length;
    }

    const inFlight = new Set<Promise<unknown>>();
    let inOrder: Plugin[] = [];

    const wiring: KernelWiring = {
        known,
        settings,
        open: new AsyncLocalStorage<object>(),
        config,
        bus,
        points,
        pending,
        outbox: options.outbox,
        now: options.now ?? Date.now,
        schedule: options.schedule,
        scopeFilter: options.scopeFilter,
        owned: new Map<string, unknown>(),
        db: options.db,
        sockets: options.sockets,
        httpClient: options.httpClient,
        log,
        run: (command, input, identity) => run(command, input, identity),
    };

    const contextFor = (plugin: string, identity?: Identity, headers?: Readonly<Record<string, string>>, sent?: Uint8Array): Context =>
    {
        return context(wiring, plugin, identity, undefined, headers, undefined, sent);
    };

    /** Runs a command, after its permission and its schema. */
    async function run(command: string, input: unknown, identity?: Identity): Promise<void>
    {
        if (!running)
        {
            throw new KernelFault(
                "NOT_STARTED",
                `Command "${command}" was run before the kernel started. Every plugin's setup runs first, so a command called from one is too early: reach the service directly instead.`,
            );
        }

        const entry = commands.get(command);

        if (entry === undefined)
        {
            throw new KernelFault("UNDECLARED_COMMAND", `Command "${command}" is not declared by any plugin.`);
        }

        const permissions = createPermissions(() => identity);
        const lacking = entry.requires.filter((permission) => !permissions.has(permission));

        if (lacking.length > 0)
        {
            const scheduled = identity === undefined
                ? " A scheduled run has no identity, so a command asked for by commands.later declares no requires."
                : "";

            throw new KernelFault(
                "PERMISSION_DENIED",
                `Command "${command}" needs ${lacking.map((permission) => `"${permission}"`).join(", ")}, which the caller does not have.${scheduled}`,
                { plugin: entry.plugin, detail: { lacking } },
            );
        }

        const parsed = entry.schema.safeParse(input);

        if (!parsed.success)
        {
            throw new KernelFault(
                "INVALID_PAYLOAD",
                `The input for "${command}" does not match its schema: ${parsed.error?.issues[0]?.message ?? "it was rejected"}.`,
                { plugin: entry.plugin },
            );
        }

        await entry.run(parsed.data as never, contextFor(entry.plugin, identity));
    }

    return {
        started: () =>
        {
            return running;
        },

        async start(): Promise<void>
        {
            if (running)
            {
                return;
            }

            const problems = validate(options.plugins, config);

            if (problems.length > 0)
            {
                const lines = problems.map((problem) => `  - [${problem.code}] ${problem.plugin}: ${problem.message}`);

                throw new KernelFault(
                    problems[0]?.code ?? "INVALID_CONFIG",
                    `${problems.length} ${problems.length === 1 ? "problem" : "problems"} stopped the kernel from starting:\n${lines.join("\n")}`,
                    { plugin: problems[0]?.plugin ?? "", detail: { problems } },
                );
            }

            inOrder = order(known);

            for (const plugin of inOrder)
            {
                const schema = plugin.definition.config;

                if (schema !== undefined)
                {
                    settings.set(plugin.name, schema.parse(config[plugin.name] ?? {}));
                }
            }

            for (const plugin of inOrder)
            {
                for (const [name, event] of Object.entries(plugin.definition.emits ?? {}))
                {
                    bus.declare(plugin.name, name, event);
                }

                for (const [name, hook] of Object.entries(plugin.definition.hooks ?? {}))
                {
                    points.declare(plugin.name, name, hook);
                }
            }

            for (const plugin of inOrder)
            {
                for (const [name, listener] of Object.entries(plugin.definition.listens ?? {}))
                {
                    bus.listen(plugin.name, name, listener);
                }

                for (const [name, participant] of Object.entries(plugin.definition.participates ?? {}))
                {
                    points.participate(plugin.name, name, participant);
                }

                for (const [name, command] of Object.entries(plugin.definition.commands ?? {}))
                {
                    commands.set(name, {
                        plugin: plugin.name,
                        requires: command.requires ?? [],
                        schema: command.schema,
                        run: command.run,
                    });
                }

                for (const route of plugin.definition.routes ?? [])
                {
                    routes.set(`${route.method} ${route.path}`, { plugin: plugin.name, route: route as Route<Context> });
                }
            }

            if (options.rateLimiter === undefined)
            {
                const bounded = [...routes.values()].filter(({ route }) => route.limit !== undefined);

                if (bounded.length > 0)
                {
                    const described = bounded.map(({ plugin, route }) => `${plugin}: ${route.method} ${route.path}`);

                    throw new KernelFault(
                        "INVALID_ROUTE",
                        `${bounded.length} ${bounded.length === 1 ? "route declares a limit" : "routes declare limits"} and no budget was given to createKernel, so nothing would enforce them:\n${described.map((route) => `  - ${route}`).join("\n")}\nPass \`budget\`, or remove the limits.`,
                        { plugin: bounded[0]?.plugin ?? "" },
                    );
                }
            }

            for (const plugin of inOrder)
            {
                await plugin.definition.setup?.(contextFor(plugin.name));
            }

            running = true;

            if (options.schedule !== undefined)
            {
                beating = setInterval(() => void due(), options.beatMs ?? 1000);

                beating.unref?.();
            }

            const interrupted = await options.outbox?.pending() ?? [];

            for (const announcement of interrupted)
            {
                log("info", announcement.plugin, "delivering an event that outlived its process", {
                    event: announcement.name,
                });

                const delivered = await bus.deliver(
                    announcement.plugin,
                    announcement.name,
                    announcement.payload,
                    (to) => contextFor(to),
                );

                if (delivered)
                {
                    await options.outbox?.markSent(announcement.id);
                }
            }
        },

        async stop(): Promise<void>
        {
            running = false;

            if (beating !== undefined)
            {
                clearInterval(beating);
                beating = undefined;
            }

            if (inFlight.size > 0)
            {
                log("info", "kernel", "waiting for requests in flight", { count: inFlight.size });

                await Promise.allSettled([...inFlight]);
            }

            for (const plugin of [...inOrder].reverse())
            {
                try
                {
                    await plugin.definition.teardown?.(contextFor(plugin.name));
                }
                catch (cause)
                {
                    log("error", plugin.name, "teardown threw", { cause });
                }
            }
        },

        routes: (): readonly RegisteredRoute[] =>
            [...routes.values()].map(({ plugin, route }) => ({
                plugin,
                method: route.method,
                path: route.path,
                describe: route.describe,
                requires: route.requires ?? [],
                public: route.public === true,
                limit: route.limit,
                accepts: route.accepts ?? "json",
                reads: route.reads ?? [],
                keepsRaw: route.keepsRaw === true,
            })),

        channels: (): readonly RegisteredChannel[] =>
            [...known.values()].flatMap((plugin) =>
                Object.entries(plugin.definition.channels ?? {}).map(([channel, declared]) => ({
                    plugin: plugin.name,
                    channel,
                    reach: declared.reach,
                    requires: declared.requires ?? [],
                }))),

        permissions: (): readonly PermissionEntry[] =>
            [...known.values()].flatMap((plugin) =>
                Object.entries(plugin.definition.permissions ?? {}).map(([permission, declared]) => ({
                    plugin: plugin.name,
                    permission,
                    describe: declared.describe,
                }))),

        handle: (incoming: KernelRequest): Promise<KernelResponse> =>
        {
            if (!running)
            {
                return Promise.resolve(notServing);
            }

            const match = routeFor(routes, incoming.method, incoming.path);

            if (match === undefined)
            {
                return Promise.resolve(unknownRoute);
            }

            const answer = respond(
                match.mounted,
                { ...incoming, input: withPathParams(incoming.input, match.params) },
                contextFor,
                log,
                options.rateLimiter,
            );

            inFlight.add(answer);

            return answer.finally(() =>
            {
                inFlight.delete(answer);
            });
        },

        context: contextFor,

        identify: identifying === undefined ? undefined : async (request: Request) =>
        {
            const ctx = contextFor(identifying.name);

            const asked = new Request(request.url, { method: request.method, headers: request.headers });
            const who = await identifying.definition.identifies?.(ctx as never, asked);

            if (who === undefined)
            {
                return undefined;
            }

            const permissions = granting === undefined
                ? []
                : await granting.definition.grants?.(contextFor(granting.name) as never, who) ?? [];

            return { ...who, permissions };
        },

        events: { failures: bus.failures },

        work: { failed: () => [...failedJobs] },

        due,

        run,
    };
}
