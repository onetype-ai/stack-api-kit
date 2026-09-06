import { AsyncLocalStorage } from "node:async_hooks";

import { context, type Wiring } from "./context";
import type { Caller, Context, Method, Plugin, Route } from "./contract";
import { events, type Failure, type Pending } from "./events";
import { KernelFault } from "./faults";
import { hooks } from "./hooks";
import { order } from "./order";
import { permissions } from "./permissions";
import { type Budget, type Incoming, type RouteOwner, notServing, type Outgoing, respond, unknownRoute } from "./request";
import type { Dialer, ScopeFilter, Outbox, Schedule, Storage } from "./store";
import { validate } from "./validate";

/** Where a line goes. The project decides; a plugin never writes directly. */
export type Log = (
    level: "debug" | "info" | "warn" | "error",
    plugin: string,
    line: string,
    about?: Readonly<Record<string, unknown>>,
) => void;

/** What a project gives the kernel. */
export type Options = {
    plugins: readonly Plugin[];
    config?: Readonly<Record<string, unknown>>;
    db?: Storage;
    dial?: Dialer;
    log?: Log;

    /**
     * What counts requests against a route's declared budget.
     *
     * Omit it and a `limit` is inert, which is why `start` says so rather
     * than letting a declared budget quietly enforce nothing.
     */
    budget?: Budget;

    /**
     * Where events wait between the transaction that emitted them and the
     * listener that hears them.
     *
     * Without one, an event that is emitted lives only in memory: the work
     * commits, the process stops, and nothing ever calls the listener. With
     * one, delivery is at least once, so a listener that writes must survive
     * being called twice.
     */
    outbox?: Outbox;

    /**
     * What the current time is, in milliseconds.
     *
     * A test pins it to make tomorrow reachable without moving the machine's
     * clock, which every other test in the process would then share.
     */
    now?: () => number;

    /**
     * Where work waits until it is time, and how often to look.
     *
     * Without one, `ctx.commands.later` refuses: a plugin that can ask for
     * later work in a deployment that cannot run it would be told nothing.
     */
    schedule?: Schedule;

    /** How often to ask the schedule what is due, in milliseconds. */
    beat?: number;

    /**
     * How many times a scheduled command may throw before it is abandoned.
     *
     * Eight by default, which is roughly four minutes of backing off. A job
     * that has failed that often is failing on something a retry will not
     * fix, and the line saying it gave up is worth more than the ninth try.
     */
    attempts?: number;

    /**
     * How a declared scope becomes a condition the store understands.
     *
     * The kernel imports no driver, so a project that declares a scope also
     * says how to narrow by it.
     */
    narrow?: ScopeFilter;

    /**
     * How long a hook participant has to answer, in milliseconds.
     *
     * A participant that never answers holds the request open, and a throw is
     * already a refusal, so silence is treated as one too.
     */
    patience?: number;
};

/** A route, and the plugin it came from. */
export type Registration = {
    plugin: string;
    method: Method;
    path: string;
    describe: string;
    requires: readonly string[];
    public: boolean;
    limit: { requests: number; seconds: number } | undefined;

    /** The request headers this route declared it reads, lowercase. */
    reads: readonly string[];
};

/** What a project holds after createKernel. */
export type Kernel = {
    start: () => Promise<void>;
    stop: () => Promise<void>;
    started: () => boolean;

    routes: () => readonly Registration[];
    handle: (incoming: Incoming) => Promise<Outgoing>;

    context: (plugin: string, caller?: Caller) => Context;
    events: { failures: () => readonly Failure[] };

    /**
     * Runs whatever the schedule says is due, once, and waits for it.
     *
     * What the beat does on a timer, asked for. A test moves its clock and
     * calls this instead of waiting a real second for an interval it does not
     * control.
     */
    due: () => Promise<void>;
    run: (command: string, input: unknown, caller?: Caller) => Promise<void>;
};

const quiet: Log = () => {};

/** The route a request lands on, and what its path segments named. */
/**
 * One path segment, decoded, or undefined when it cannot be.
 *
 * A malformed escape makes decodeURIComponent throw, and this runs before
 * respond()'s try/catch: over HTTP the server normalises first, but a project
 * calling handle() directly would get an unhandled rejection where it asked
 * for an answer. A segment that cannot be read matches nothing.
 */
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
    method: Method,
    path: string,
): { mounted: RouteOwner; params: Readonly<Record<string, string>> } | undefined
{
    const exact = routes.get(`${method} ${path}`);

    if (exact !== undefined)
    {
        return { mounted: exact, params: {} };
    }

    const asked = path.split("/");

    // A static route the caller wrote encoded: found here rather than left to
    // the parameter routes below, which would answer for it.
    const plain = routes.get(`${method} ${asked.map((one) => decodeSegment(one) ?? one).join("/")}`);

    if (plain !== undefined)
    {
        return { mounted: plain, params: {} };
    }

    for (const [key, mounted] of routes)
    {
        const [verb, declared] = key.split(" ");

        if (verb !== method || declared === undefined)
        {
            continue;
        }

        const parts = declared.split("/");

        if (parts.length !== asked.length)
        {
            continue;
        }

        const params: Record<string, string> = {};
        const fits = parts.every((part, at) =>
        {
            const given = asked[at] ?? "";

            if (!part.startsWith(":"))
            {
                // Decoded before comparing, or "/users/%6de" misses the route
                // "/users/me" declares and lands on "/users/:id" instead.
                return part === decodeSegment(given);
            }

            const value = decodeSegment(given);

            if (value === undefined)
            {
                return false;
            }

            params[part.slice(1)] = value;

            return given !== "";
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

    const given = input !== null && typeof input === "object" && !Array.isArray(input)
        ? { ...(input as Record<string, unknown>) }
        : {};

    // The path wins, as it does over HTTP: a router already matched it, so a
    // body claiming otherwise is confused or deliberate.
    return { ...given, ...params };
}

/**
 * Builds a kernel from what the plugins declared.
 *
 * Nothing runs here: `start` validates first, and either brings up every
 * plugin or throws. A half-started kernel behaves according to where it
 * stopped, which is not a state anyone can reason about.
 */
export function createKernel(options: Options): Kernel
{
    const config = options.config ?? {};
    const log = options.log ?? quiet;

    const known = new Map(options.plugins.map((one) => [one.name, one]));
    const bus = events<Context>(Date.now, (plugin, line, about) =>
    {
        log("error", plugin, line, about);
    });
    const points = hooks<Context>(options.patience);
    const parsed = new Map<string, unknown>();
    const pending = new Map<object, Pending[]>();

    const routes = new Map<string, RouteOwner>();
    const commands = new Map<string, {
        plugin: string;
        requires: readonly string[];
        schema: { safeParse: (value: unknown) => { success: boolean; data?: unknown; error?: { issues: { message: string }[] } } };
        run: (input: never, ctx: Context) => void | Promise<void>;
    }>();

    let running = false;
    let beating: ReturnType<typeof setInterval> | undefined;

    /**
     * Runs what is due, one turn.
     *
     * Failures are the point rather than an afterthought: a command that
     * throws goes back with its attempt counted, so a partner that was down
     * for a minute costs a minute rather than the work.
     */
    async function due(): Promise<void>
    {
        if (options.schedule === undefined || !running)
        {
            return;
        }

        const clock = options.now ?? Date.now;
        const taken = await options.schedule.take(clock(), 20);

        for (const job of taken)
        {
            try
            {
                await run(job.command, job.input);
                await options.schedule.done(job.id);
            }
            catch (cause)
            {
                log("error", job.plugin, "a scheduled command failed", {
                    command: job.command,
                    attempts: job.attempts + 1,
                    error: cause instanceof Error ? cause.message : String(cause),
                });

                // Backing off, so a command failing on something that is
                // still broken does not spend the whole beat on itself. And
                // giving up eventually: a job retried forever is a process
                // spending itself on work nobody is waiting for any more.
                if (job.attempts + 1 >= (options.attempts ?? 8))
                {
                    log("error", job.plugin, "a scheduled command gave up", {
                        command: job.command,
                        attempts: job.attempts + 1,
                    });

                    await options.schedule.abandon(job.id);
                }
                else
                {
                    await options.schedule.failed(job.id, clock() + Math.min(2 ** job.attempts, 60) * 1000);
                }
            }
        }
    }

    // What is still being answered. A shutdown waits for these: a request
    // that has already been accepted was promised an answer, and tearing the
    // plugins down underneath it turns that promise into a 500.
    const inFlight = new Set<Promise<unknown>>();
    let started: Plugin[] = [];

    const wiring: Wiring = {
        known,
        parsed,
        open: new AsyncLocalStorage<object>(),
        config,
        bus,
        points,
        pending,
        outbox: options.outbox,
        now: options.now ?? Date.now,
        schedule: options.schedule,
        narrow: options.narrow,
        owned: new Map<string, unknown>(),
        db: options.db,
        dial: options.dial,
        log,
        run: (command, input, caller) => run(command, input, caller),
    };

    const seenBy = (plugin: string, caller?: Caller, headers?: Readonly<Record<string, string>>): Context =>
    {
        return context(wiring, plugin, caller, undefined, headers);
    };

    /** Runs a command, after its permission and its schema. */
    async function run(command: string, input: unknown, caller?: Caller): Promise<void>
    {
        if (!running)
        {
            throw new KernelFault(
                "NOT_STARTED",
                `Command "${command}" was run before the kernel started. Every plugin's setup runs first, so a command called from one is too early: reach the service directly instead.`,
            );
        }

        const declared = commands.get(command);

        if (declared === undefined)
        {
            throw new KernelFault("UNDECLARED_COMMAND", `Command "${command}" is not declared by any plugin.`);
        }

        const may = permissions(() => caller);
        const lacking = declared.requires.filter((permission) => !may.has(permission));

        if (lacking.length > 0)
        {
            // A scheduled run has no caller at all, which is not the same
            // problem as one who is short a permission: no permission can be
            // granted to nobody, so a command the schedule asks for declares
            // none. Saying only "the caller does not have" sends its author
            // looking for a permission to hand out.
            const scheduled = caller === undefined
                ? " A scheduled run has no caller, so a command asked for by commands.later declares no requires."
                : "";

            throw new KernelFault(
                "PERMISSION_DENIED",
                `Command "${command}" needs ${lacking.map((permission) => `"${permission}"`).join(", ")}, which the caller does not have.${scheduled}`,
                { plugin: declared.plugin, detail: { lacking } },
            );
        }

        const parsed = declared.schema.safeParse(input);

        if (!parsed.success)
        {
            throw new KernelFault(
                "INVALID_PAYLOAD",
                `The input for "${command}" does not match its schema: ${parsed.error?.issues[0]?.message ?? "it was rejected"}.`,
                { plugin: declared.plugin },
            );
        }

        await declared.run(parsed.data as never, seenBy(declared.plugin, caller));
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

            const wrong = validate(options.plugins, config);

            if (wrong.length > 0)
            {
                const lines = wrong.map((problem) => `  - [${problem.code}] ${problem.plugin}: ${problem.message}`);

                throw new KernelFault(
                    wrong[0]?.code ?? "INVALID_CONFIG",
                    `${wrong.length} ${wrong.length === 1 ? "problem" : "problems"} stopped the kernel from starting:\n${lines.join("\n")}`,
                    { plugin: wrong[0]?.plugin ?? "", detail: { wrong } },
                );
            }

            started = order(known);

            for (const plugin of started)
            {
                const schema = plugin.definition.config;

                if (schema !== undefined)
                {
                    parsed.set(plugin.name, schema.parse(config[plugin.name] ?? {}));
                }
            }

            // Declared before anything is wired: a listener may name an event
            // owned by a plugin that comes later in the order.
            for (const plugin of started)
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

            for (const plugin of started)
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

            // A declared budget nothing enforces is worse than none: the
            // contract says the route is protected and it is not.
            if (options.budget === undefined)
            {
                const declared = [...routes.values()].filter(({ route }) => route.limit !== undefined);

                if (declared.length > 0)
                {
                    const named = declared.map(({ plugin, route }) => `${plugin}: ${route.method} ${route.path}`);

                    throw new KernelFault(
                        "INVALID_ROUTE",
                        `${declared.length} ${declared.length === 1 ? "route declares a limit" : "routes declare limits"} and no budget was given to createKernel, so nothing would enforce them:\n${named.map((one) => `  - ${one}`).join("\n")}\nPass \`budget\`, or remove the limits.`,
                        { plugin: declared[0]?.plugin ?? "" },
                    );
                }
            }

            for (const plugin of started)
            {
                await plugin.definition.setup?.(seenBy(plugin.name));
            }

            running = true;

            if (options.schedule !== undefined)
            {
                beating = setInterval(() => void due(), options.beat ?? 1000);

                // So a beat never holds a process open that is otherwise done.
                beating.unref?.();
            }

            // Anything still waiting was interrupted between its commit and
            // its delivery: the work happened, the listener never heard. It
            // is delivered now, before this kernel answers anything new.
            const interrupted = await options.outbox?.unsent() ?? [];

            for (const announcement of interrupted)
            {
                log("info", announcement.plugin, "delivering an event that outlived its process", {
                    event: announcement.name,
                });

                const heard = await bus.deliver(
                    announcement.plugin,
                    announcement.name,
                    announcement.payload,
                    (to) => seenBy(to),
                );

                if (heard)
                {
                    await options.outbox?.sent(announcement.id);
                }
            }
        },

        async stop(): Promise<void>
        {
            // Stop accepting first, then wait: a request accepted after this
            // point would be one more thing to wait for, and draining would
            // never end under load.
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

            for (const plugin of [...started].reverse())
            {
                try
                {
                    await plugin.definition.teardown?.(seenBy(plugin.name));
                }
                catch (cause)
                {
                    log("error", plugin.name, "teardown threw", { cause });
                }
            }
        },

        routes: (): readonly Registration[] =>
            [...routes.values()].map(({ plugin, route }) => ({
                plugin,
                method: route.method,
                path: route.path,
                describe: route.describe,
                requires: route.requires ?? [],
                public: route.public === true,
                limit: route.limit,
                reads: route.reads ?? [],
            })),

        handle: (incoming: Incoming): Promise<Outgoing> =>
        {
            // A kernel that has stopped has torn its plugins down, so an
            // answer from here would be one they never agreed to give.
            if (!running)
            {
                return Promise.resolve(notServing);
            }

            const found = routeFor(routes, incoming.method, incoming.path);

            if (found === undefined)
            {
                return Promise.resolve(unknownRoute);
            }

            // A caller may pass the declared path with its parameters in
            // `input`, as the server does, or the real one with the values in
            // it. Taking both means a test reads like the request it stands
            // for rather than like the routing table.
            const answering = respond(
                found.mounted,
                { ...incoming, input: withPathParams(incoming.input, found.params) },
                seenBy,
                log,
                options.budget,
            );

            inFlight.add(answering);

            return answering.finally(() =>
            {
                inFlight.delete(answering);
            });
        },

        context: seenBy,

        events: { failures: bus.failures },

        due,

        run,
    };
}
