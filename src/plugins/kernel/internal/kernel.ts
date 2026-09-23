import { AsyncLocalStorage } from "node:async_hooks";

import { Refusal } from "./refusal";
import { context, type KernelWiring } from "./context";
import type { Identity, Context, HttpMethod, Pipeline, PipelineStep, Plugin, ChannelReach, Registry, Route } from "./contract";
import { events, type ListenerFailure, type PendingDelivery } from "./events";
import { KernelFault } from "./faults";
import { hooks } from "./hooks";
import { order } from "./order";
import { pipelines, type ExplainedStep } from "./pipelines";
import { registries } from "./registries";
import { RegistryChange, registryRoute } from "./registryRoute";
import { ADVANCE, PipelineFailure, StepJob, type DurableSteps } from "./durable";
import { createPermissions } from "./permissions";
import { type RateLimiter, type KernelRequest, type RouteOwner, notServing, type KernelResponse, respond, unknownRoute } from "./request";
import { systemLookup, type Lookup } from "./resolve";
import type { FailedEvent, FailedJob, HttpClient, ScopeFilter, Outbox, Schedule, Sockets, KernelStore, PipelineStore, RegistryStore } from "./store";
import { holdWhileDelivering, keepHeard, OUTBOX_LEASE_MS, retryDelayMs } from "./delivery";
import type { StreamRegistry } from "./streams";
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

    /** Where tenant registries keep their entries; a store gives one (`store.registries()`). */
    registries?: RegistryStore;

    /** Where durable pipeline runs keep their input and results; a store gives one (`store.runs()`). */
    runs?: PipelineStore;

    /** What holds the open sockets. Without one, ctx.push throws. */
    sockets?: Sockets;
    httpClient?: HttpClient;

    /** How a name becomes addresses for a plugin reaching "anywhere"; the platform's resolver when left out. */
    lookup?: Lookup;
    log?: LogFn;

    /** What counts requests against a route's declared limit. */
    rateLimiter?: RateLimiter;

    /** Where events wait between the transaction that emitted them and the listener that hears them. */
    outbox?: Outbox;

    /** What the current time is, in milliseconds. */
    now?: () => number;

    /** Where work waits until it is time, and how often to look. */
    schedule?: Schedule;

    /** How often to ask the schedule what is due, in milliseconds. */
    beatMs?: number;

    /** False keeps the schedule for `commands.later` without running what is due, for a process that only enqueues. */
    runsSchedule?: boolean;

    /** How often to hand failed events to the listeners that have not heard them, in milliseconds: 5000 when left out. */
    outboxBeatMs?: number;

    /** Told when an event became deliverable at once (a dead letter put back), so the other processes need not wait a beat. */
    woken?: () => void;

    /** How long a scheduled command is held while it runs, in milliseconds: ten leases when left out; past it the lease runs out and the job is taken again, counted. */
    jobRunMs?: number;

    /** How many times a scheduled command may throw before it is abandoned. */
    mostAttempts?: number;

    /** How a declared scope becomes a condition the store understands. */
    scopeFilter?: ScopeFilter;

    /** Which plugin may answer what the caller holds; any other declaring `grants` is refused at startup. */
    grantedBy?: string;

    /** How long a hook participant has to answer, in milliseconds. */
    hookTimeoutMs?: number;

    /** How many streams one caller may hold open at once (4 when left out); one more answers 429 TOO_MANY_STREAMS before its handler runs. */
    mostStreamsPerCaller?: number;

    /** How long `stop` waits for open streams to send their final RESTARTING event, in milliseconds (5000 when left out). */
    streamDrainMs?: number;

    /** Holds every reply to the header allow-list (the kit's short list plus a route's `sends`) now; 9.0 makes it the default. Left out, a header the list would drop still goes out, named once in the log. */
    strictReplyHeaders?: boolean;
};

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

/** A route, and the plugin it came from. */
export type RegisteredRoute = {
    plugin: string;
    method: HttpMethod;
    path: string;
    describe: string;
    requires: readonly string[];
    public: boolean;

    /** Whether any website may read it from a browser, never with credentials. */
    anyOrigin: boolean;
    limit: { requests: number; seconds: number } | undefined;

    /** What kind of body it takes: JSON unless it declared a form or a URL-encoded one. */
    accepts: "json" | "form" | "urlencoded";

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

    /** The plugins this kernel started, for a caller reading what they declare. */
    plugins: () => readonly Plugin[];
    handle: (incoming: KernelRequest) => Promise<KernelResponse>;

    context: (plugin: string, identity?: Identity) => Context;

    /** Who is calling, asked of the plugin that knows. */
    identify: ((request: Request) => Promise<Identity | undefined>) | undefined;

    events: { failures: () => readonly ListenerFailure[] };

    /** What the schedule did that nobody is waiting on. */
    work: {
        failed: () => readonly FailedJob[];

        /** Events a listener kept refusing, kept in the outbox. */
        failedEvents: () => Promise<readonly FailedEvent[]>;

        /** Delivers one dead letter again, to the listeners that have not heard it; false when there is none by that id. */
        retryFailed: (id: string) => Promise<boolean>;
    };

    /** Hands what the outbox says is due to the listeners that have not heard it, once, and waits for it. */
    redeliver: () => Promise<number>;

    /** Waits until every event delivery under way has settled, and those they started. */
    settled: () => Promise<void>;

    /** Runs whatever the schedule says is due, once, and waits for it. */
    due: () => Promise<number>;

    /** A pipeline's steps in the order they run, and who put each there. */
    explain: (pipeline: string) => readonly ExplainedStep[];
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
    const granter = options.plugins.find((plugin) => plugin.definition.grants !== undefined);
    const bus = events<Context>(Date.now, (plugin, line, about) =>
    {
        log("error", plugin, line, about);
    });
    const points = hooks<Context>(options.hookTimeoutMs);
    const openStreams: StreamRegistry = { perCaller: new Map(), active: new Set(), most: options.mostStreamsPerCaller ?? 4 };
    const headerPolicy = { strict: options.strictReplyHeaders === true, warned: new Set<string>() };
    const settings = new Map<string, unknown>();
    const pending = new Map<object, PendingDelivery[]>();
    const lists = registries((plugin, line, about) =>
    {
        log("warn", plugin, line, about);
    });
    const flows = pipelines();

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

    /**
     * Renews a job's lease every third of it while its command runs, and answers what stops that. A command that
     * never settles stops being renewed after `jobRunMs`, so its lease runs out and the job is taken again, counted,
     * and given up at `mostAttempts` rather than held for ever.
     */
    function holdWhileRunning(schedule: Schedule, job: { id: string; plugin: string; command: string; attempts: number; lease?: string | undefined }, clock: () => number): () => void
    {
        const lease = schedule.leaseMs;

        if (lease === undefined || schedule.renew === undefined)
        {
            return () => undefined;
        }

        const until = clock() + (options.jobRunMs ?? lease * 10);

        let renewing: ReturnType<typeof setInterval> | undefined;

        const stop = (): void =>
        {
            clearInterval(renewing);
            renewing = undefined;
        };

        renewing = setInterval(() =>
        {
            if (!running)
            {
                stop();

                return;
            }

            if (clock() >= until)
            {
                stop();
                log("error", job.plugin, "a scheduled command ran past its time and is no longer held; it will be taken again", { command: job.command, attempts: job.attempts + 1 });

                return;
            }

            void Promise.resolve().then(() => schedule.renew?.(job.id, clock(), job.lease)).then((kept) =>
            {
                if (kept === false && renewing !== undefined)
                {
                    stop();
                    log("warn", job.plugin, "a scheduled command lost its lease to another run; this run's outcome will not be recorded", { command: job.command });
                }
            }, (cause: unknown) =>
            {
                stop();
                log("error", job.plugin, "a scheduled command's lease could not be renewed; it will be taken again", { command: job.command, cause: cause instanceof Error ? cause.message : String(cause) });
            });
        }, Math.max(1, Math.floor(lease / 3)));

        renewing.unref?.();

        return stop;
    }

    /** Puts one dead letter back, deliverable now; whoever listens is told, so another process need not wait a beat. */
    async function retryFailed(id: string): Promise<boolean>
    {
        const revived = await (options.outbox?.revive?.(id, clock()) ?? Promise.resolve(false));

        if (revived)
        {
            options.woken?.();
        }

        return revived;
    }

    /** Runs what is due, one turn. */
    async function due(): Promise<number>
    {
        const schedule = options.schedule;

        if (schedule === undefined || options.runsSchedule === false || !running)
        {
            return 0;
        }

        const clock = options.now ?? Date.now;
        const taken = await schedule.claim(clock(), 20);
        const most = options.mostAttempts ?? 8;

        for (const job of taken)
        {
            // taken again after its process stopped holding it too often: the command itself never ran to an end
            if (job.attempts >= most)
            {
                log("error", job.plugin, "a scheduled command gave up after its process stopped holding it too often", { command: job.command, attempts: job.attempts });

                failedJobs.push({ plugin: job.plugin, command: job.command, input: job.input, attempts: job.attempts, error: new Error("Its lease ran out too many times."), at: clock() });

                await schedule.giveUp(job.id, job.lease);

                continue;
            }

            const stopRenewing = holdWhileRunning(schedule, job, clock);

            try
            {
                await run(job.command, job.input);
                stopRenewing();
                await schedule.markDone(job.id, job.lease);
            }
            catch (cause)
            {
                stopRenewing();

                log("error", job.plugin, "a scheduled command failed", {
                    command: job.command,
                    attempts: job.attempts + 1,
                    error: cause instanceof Error ? cause.message : String(cause),
                });

                const final = isFinalRefusal(cause);

                if (final || job.attempts + 1 >= most)
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

                    await schedule.giveUp(job.id, job.lease);
                }
                else
                {
                    await schedule.markFailed(job.id, clock() + Math.min(2 ** job.attempts, 60) * 1000, job.lease);
                }
            }
        }

        return taken.length;
    }

    let redelivering: ReturnType<typeof setInterval> | undefined;

    const clock = (): number => (options.now ?? Date.now)();

    /**
     * The tenant a dead letter belonged to, read from the payload by the names the emitting plugin's own scope
     * gives it: the column each of its tables carries the scope in, then the claim. Never a fixed field name.
     */
    function scopeOfPayload(plugin: string, payload: unknown): Readonly<Record<string, string>>
    {
        const scope = known.get(plugin)?.definition.scope;

        if (scope === undefined || payload === null || typeof payload !== "object")
        {
            return {};
        }

        const fields = [...new Set([...Object.values(scope.tables), scope.claim])];
        const found = fields.find((field) => typeof (payload as Record<string, unknown>)[field] === "string");

        return found === undefined ? {} : { [found]: (payload as Record<string, string>)[found] as string };
    }

    /**
     * Hands events kept in the outbox to the listeners that have not heard them yet; a row one listener keeps
     * refusing becomes a dead letter, kept and logged once, never with its payload, for an operator to retry.
     */
    async function redeliver(now: number): Promise<number>
    {
        const kept = options.outbox;

        if (kept?.claim === undefined || !running)
        {
            return 0;
        }

        const taken = await kept.claim(now, 20);
        const most = options.mostAttempts ?? 8;

        for (const row of taken)
        {
            const before = new Set(row.heard);
            const holding = holdWhileDelivering(kept, row.id, clock);

            const { heard, failed } = await bus.deliverTo(row.plugin, row.name, row.payload, (to) => contextFor(to), before, (listener) =>
            {
                keepHeard(kept, row.id, listener, (cause) =>
                {
                    if (running)
                    {
                        log("warn", row.plugin, "could not keep that a listener heard an event; it may hear it again", { id: row.id, event: row.name, listener, cause: cause instanceof Error ? cause.message : String(cause) });
                    }
                });
            }).finally(() =>
            {
                clearInterval(holding);
            });

            const all = [...before, ...heard];

            try
            {
                if (failed.length === 0)
                {
                    await kept.markSent(row.id);

                    continue;
                }

                const attempts = row.attempts + 1;

                if (attempts >= most)
                {
                    log("error", row.plugin, "an event was given up: a listener kept failing, and it waits as a dead letter for work.retryFailed", {
                        id: row.id,
                        event: row.name,
                        listeners: failed,
                        attempts,
                        ...scopeOfPayload(row.plugin, row.payload),
                    });

                    await kept.markDead?.(row.id, all, attempts, clock());

                    continue;
                }

                await kept.markRetry?.(row.id, all, attempts, clock() + retryDelayMs(attempts));
            }
            catch (cause)
            {
                log("error", row.plugin, `could not record the delivery of "${row.name}" in the outbox; it will be delivered again`, { cause: cause instanceof Error ? cause.message : String(cause) });
            }
        }

        return taken.length;
    }

    const inFlight = new Set<Promise<unknown>>();
    const deliveries = new Set<Promise<unknown>>();
    let inOrder: Plugin[] = [];

    const wiring: KernelWiring = {
        known,
        settings,
        open: new AsyncLocalStorage<object>(),
        config,
        bus,
        points,
        pending,
        lists,
        flows,
        registryStore: options.registries,
        runs: options.runs,
        jobs: new Map(),
        outbox: options.outbox,
        isRunning: () => running,
        warned: new Set<string>(),
        track: (delivery) =>
        {
            const settling = delivery.catch(() => undefined).finally(() =>
            {
                deliveries.delete(settling);
            });

            deliveries.add(settling);
        },
        now: options.now ?? Date.now,
        schedule: options.schedule,
        scopeFilter: options.scopeFilter,
        owned: new Map<string, unknown>(),
        db: options.db,
        sockets: options.sockets,
        httpClient: options.httpClient,
        lookup: options.lookup ?? systemLookup,
        log,
        run: (command, input, identity) => run(command, input, identity),

        work: {
            health: async () => ({
                jobs: { ...(await options.schedule?.counts?.(clock()) ?? {}), failed: failedJobs.length },
                outbox: await options.outbox?.counts?.(clock()) ?? {},
            }),
            failedJobs: () => failedJobs.map((job) => ({ plugin: job.plugin, command: job.command, attempts: job.attempts, at: job.at, error: job.error instanceof Error ? job.error.name : "Error" })),
            failedEvents: () => options.outbox?.failed?.() ?? Promise.resolve([]),
            retryFailed: (id: string) => retryFailed(id),
        },
    };

    /** Declares every registry and pipeline, then adds what plugins add, refusing every bad entry at once. */
    function placeAdditions(plugins: readonly Plugin[]): void
    {
        lists.reset();
        flows.reset();

        for (const plugin of plugins)
        {
            for (const [key, declared] of Object.entries(plugin.definition.registries ?? {}))
            {
                lists.declare(plugin.name, key, declared);
            }

            for (const [key, declared] of Object.entries(plugin.definition.pipelines ?? {}))
            {
                flows.declare(plugin.name, key, declared as Pipeline<Context>);
            }
        }

        const refused: string[] = [];

        for (const plugin of plugins)
        {
            for (const [key, entries] of Object.entries(plugin.definition.adds ?? {}))
            {
                if (flows.known(key))
                {
                    for (const step of entries)
                    {
                        const shape = step as Partial<PipelineStep<Context>> | null;

                        if (typeof shape?.id !== "string" || typeof shape.run !== "function")
                        {
                            refused.push(`  - Pipeline "${key}" refused a step from "${plugin.name}": it needs id: "<step>" and run: (state, ctx) => ....`);

                            continue;
                        }

                        flows.add(plugin.name, key, step as PipelineStep<Context>);
                    }

                    continue;
                }

                for (const entry of entries)
                {
                    try
                    {
                        lists.add(plugin.name, key, entry);
                    }
                    catch (cause)
                    {
                        refused.push(`  - ${cause instanceof Error ? cause.message : String(cause)}`);
                    }
                }
            }
        }

        refused.push(...flows.settle().map((problem) => `  - ${problem}`));

        if (refused.length > 0)
        {
            lists.reset();
            flows.reset();

            throw new KernelFault("INVALID_ENTRY", `${refused.length} ${refused.length === 1 ? "entry" : "entries"} stopped the kernel from starting:\n${refused.join("\n")}`);
        }

        for (const plugin of plugins)
        {
            for (const key of Object.keys(plugin.definition.pipelines ?? {}))
            {
                log("debug", plugin.name, `pipeline "${key}" runs ${flows.explain(key).map((step) => step.id).join(" → ")}`, { steps: flows.explain(key) });
            }
        }
    }

    /**
     * One frame per socket in the change's scope, first match wins: the entry to who may see it, its removal to who
     * could before, a skip to the rest, so a key never reaches a socket that may not see it. An entry changed again
     * before this ran is skipped here: the later change sends it, under its own permissions.
     */
    async function pushChange(name: string, registry: Registry, payload: unknown): Promise<void>
    {
        const change = RegistryChange.parse(payload);
        const sockets = options.sockets;

        if (sockets === undefined || registry.expose === undefined)
        {
            return;
        }

        const skip = { version: change.version, op: "skip" };
        const removed = { version: change.version, op: "remove", key: change.key };
        const sending = { channel: `registry.${name}`, reach: "scope" as const, requires: registry.expose.requires, scope: change.scope, from: undefined, fromConnection: undefined, message: skip };

        if (change.op === "remove")
        {
            sockets.push({ ...sending, variants: [{ requires: change.before ?? [], message: removed }] });

            return;
        }

        const row = await options.registries?.get(name, change.scope, change.key);
        const parsed = registry.entry.safeParse(row?.entry);

        if (row === undefined || row.version !== change.version || !parsed.success)
        {
            sockets.push(sending);

            return;
        }

        sockets.push({
            ...sending,
            variants: [
                { requires: change.requires, message: { version: change.version, op: "set", key: change.key, entry: parsed.data } },
                ...(change.before === undefined ? [] : [{ requires: change.before, message: removed }]),
            ],
        });
    }

    /** Gives each durable pipeline the command its steps run as, and the event its failure is told by. */
    function scheduleDurableSteps(plugins: readonly Plugin[]): void
    {
        for (const plugin of plugins)
        {
            for (const name of Object.keys(plugin.definition.pipelines ?? {}))
            {
                const declared = flows.declared(name);

                if (declared?.pipeline.flavour !== "durable")
                {
                    continue;
                }

                if (options.schedule === undefined || options.runs === undefined)
                {
                    throw new KernelFault("INVALID_CONFIG", `Pipeline "${name}" of "${plugin.name}" is durable, and createKernel was given no ${options.schedule === undefined ? "schedule" : "runs store"} to run its steps. Start with a database and schedule: true.`, { plugin: plugin.name });
                }

                const unkept = declared.steps.filter((step) => typeof (step.result as { safeParse?: unknown } | undefined)?.safeParse !== "function");

                if (unkept.length > 0)
                {
                    throw new KernelFault("INVALID_PIPELINE", `Pipeline "${name}" is durable, and ${unkept.map((step) => `step "${step.id}" from "${step.owner}"`).join(", ")} declares no result, so what it answers could not be stored and read back. Give each a result: z.object({ ... }).`, { plugin: unkept[0]?.owner ?? plugin.name });
                }

                bus.declare(plugin.name, `${name}.failed`, { describe: `A run of pipeline "${name}" failed at a step, past its retries.`, schema: PipelineFailure });

                commands.set(`${name}.step`, {
                    plugin: plugin.name,
                    requires: [],
                    schema: StepJob,
                    run: ((input: { runId: string }, ctx: Context) => (ctx.pipeline(name) as unknown as DurableSteps)[ADVANCE](input.runId)) as never,
                });
            }
        }
    }

    /** Declares what the kit announces and serves for each registry: its change event, and for an exposed one its route. */
    function serveRegistries(plugins: readonly Plugin[]): void
    {
        for (const plugin of plugins)
        {
            for (const [name, registry] of Object.entries(plugin.definition.registries ?? {}))
            {
                if (registry.scope === "tenant")
                {
                    if (options.registries === undefined)
                    {
                        throw new KernelFault("INVALID_CONFIG", `Registry "${name}" of "${plugin.name}" is scope: "tenant", and createKernel was given no registries store to keep its entries. Pass registries: store.registries(), which start does for a database.`, { plugin: plugin.name });
                    }

                    bus.declare(plugin.name, `${name}.changed`, { describe: `An entry of registry "${name}" was set or removed in one scope.`, schema: RegistryChange });

                    if (registry.expose !== undefined)
                    {
                        bus.listen("kernel", `${name}.changed`, { describe: `Pushes each change of registry "${name}" to the sockets in its scope.`, handle: (payload: never) => pushChange(name, registry, payload) });
                    }
                }

                if (registry.expose !== undefined)
                {
                    const route = registryRoute(name, registry, options.rateLimiter !== undefined);

                    routes.set(`${route.method} ${route.path}`, { plugin: plugin.name, route: route as Route<Context> });
                }
            }
        }
    }

    const contextFor = (plugin: string, identity?: Identity, headers?: Readonly<Record<string, string>>, sent?: Uint8Array, signal?: AbortSignal): Context =>
    {
        return context(wiring, plugin, identity, undefined, headers, undefined, sent, signal);
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

            // a job is written by the transaction that asks for it, so a schedule without a store could keep none
            if (options.schedule !== undefined && options.db === undefined)
            {
                throw new KernelFault(
                    "UNSTORED_SCHEDULE",
                    "createKernel was given a schedule but no db. commands.later writes each job with the transaction that asks for it, and a transaction needs a store. Pass db, or a store whose tx runs the work in a test, or leave schedule out.",
                    { plugin: "" },
                );
            }

            const problems = validate(options.plugins, config, options.grantedBy);

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

            placeAdditions(inOrder);
            serveRegistries(inOrder);
            scheduleDurableSteps(inOrder);

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
                        `${bounded.length} ${bounded.length === 1 ? "route declares a limit" : "routes declare limits"} and no rateLimiter was given to createKernel, so nothing would enforce them:\n${described.map((route) => `  - ${route}`).join("\n")}\nPass \`rateLimiter\`, or remove the limits.`,
                        { plugin: bounded[0]?.plugin ?? "" },
                    );
                }
            }

            for (const plugin of inOrder)
            {
                await plugin.definition.setup?.(contextFor(plugin.name));
            }

            running = true;

            if (options.schedule !== undefined && options.runsSchedule !== false)
            {
                beating = setInterval(() => void due(), options.beatMs ?? 1000);

                beating.unref?.();
            }

            // an outbox that can lease is swept by one loop, at startup and after: a row whose commit delivery never finished is due once its lease ran out
            if (options.outbox?.claim !== undefined)
            {
                await redeliver(clock() + (options.outbox.leaseMs ?? OUTBOX_LEASE_MS));

                redelivering = setInterval(() => void redeliver(clock()), options.outboxBeatMs ?? 5000);
                redelivering.unref?.();
            }

            const interrupted = options.outbox?.claim === undefined ? await options.outbox?.pending() ?? [] : [];

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
                    // a delete that failed keeps the row, so the next start
                    // replays it; that is safer than stopping the replay here
                    try
                    {
                        await options.outbox?.markSent(announcement.id);
                    }
                    catch (cause)
                    {
                        log("error", announcement.plugin, `could not clear "${announcement.name}" from the outbox; it will be delivered again`, { cause: cause instanceof Error ? cause.message : String(cause) });
                    }
                }
            }
        },

        async stop(): Promise<void>
        {
            running = false;

            if (redelivering !== undefined)
            {
                clearInterval(redelivering);
                redelivering = undefined;
            }

            if (beating !== undefined)
            {
                clearInterval(beating);
                beating = undefined;
            }

            // every open stream is told it ends and why, so a caller reconnects rather than seeing a silent cut
            if (openStreams.active.size > 0)
            {
                log("info", "kernel", "ending open streams", { count: openStreams.active.size });

                for (const stream of openStreams.active)
                {
                    stream.end("RESTARTING");
                }

                const until = Date.now() + (options.streamDrainMs ?? 5000);

                while (openStreams.active.size > 0 && Date.now() < until)
                {
                    await new Promise((resolve) => setTimeout(resolve, 20));
                }
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
                anyOrigin: route.anyOrigin === true,
                limit: route.limit,
                accepts: route.accepts ?? "json",
                reads: route.reads ?? [],
                keepsRaw: route.keepsRaw === true,
            })),

        channels: (): readonly RegisteredChannel[] =>
            [...known.values()].flatMap((plugin) => [
                ...Object.entries(plugin.definition.channels ?? {}).map(([channel, declared]) => ({
                    plugin: plugin.name,
                    channel,
                    reach: declared.reach,
                    requires: declared.requires ?? [],
                })),

                // an exposed registry's pushes, heard by whoever may read its snapshot
                ...Object.entries(plugin.definition.registries ?? {}).flatMap(([name, registry]) => registry.expose === undefined ? [] : [{
                    plugin: plugin.name,
                    channel: `registry.${name}`,
                    reach: (registry.scope === "tenant" ? "scope" : "everyone") as ChannelReach,
                    requires: registry.expose.requires,
                }]),
            ]),

        // the definitions themselves, so declarationsOf can read them without
        // the kernel having to know what a declaration looks like
        plugins: (): readonly Plugin[] =>
        {
            return [...known.values()];
        },

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
                openStreams,
                headerPolicy,
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

            const copy = new Request(request.url, { method: request.method, headers: request.headers });
            const who = await identifying.definition.identifies?.(ctx as never, copy);

            if (who === undefined)
            {
                return undefined;
            }

            const permissions = granter === undefined
                ? []
                : await granter.definition.grants?.(contextFor(granter.name) as never, who) ?? [];

            return { ...who, permissions };
        },

        events: { failures: bus.failures },

        work: {
            failed: () => [...failedJobs],
            failedEvents: () => options.outbox?.failed?.() ?? Promise.resolve([]),
            retryFailed: (id: string) => retryFailed(id),
        },

        redeliver: () => redeliver(clock()),

        settled: async (): Promise<void> =>
        {
            // a listener may emit in turn: wait until a round starts nothing new
            while (deliveries.size > 0)
            {
                await Promise.allSettled([...deliveries]);
            }
        },

        due,

        explain: (name) =>
        {
            return flows.explain(name);
        },

        run,
    };
}
