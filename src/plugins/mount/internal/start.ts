import { Env } from "../../boot/api";
import { database, noStore, postgres, postgresPubSub } from "../../database/api";
import { limiter, unlimited } from "../../guard/api";
import { createKernel, order } from "../../kernel/api";
import { httpClient } from "../../outbound/api";
import { currentRequestId, inProcessPubSub, relay, serve, sockets, withSessionKey } from "../../http/api";
import type { DatabaseOptions, Store } from "../../database/api";
import type { Logger, Plugin } from "../../kernel/api";
import type { StartedApp, StartOptions } from "../api";
import { refuseUnmigrated } from "./migrationChecks";

/** A line's detail with the id of the request it was written in, when it was written in one. */
function traced(about: Readonly<Record<string, unknown>> | undefined): Readonly<Record<string, unknown>> | undefined
{
    const requestId = currentRequestId();

    return requestId === undefined || about?.["requestId"] !== undefined ? about : { requestId, ...about };
}

/** The store to run on: the project's own, one opened here on SQLite or Postgres, or none at all. */
async function storeFor(given: StartOptions["database"], withTables: readonly Plugin[], log: Logger | undefined): Promise<Store>
{
    if (given === undefined)
    {
        return noStore();
    }

    if (typeof (given as { tx?: unknown }).tx === "function")
    {
        return given as Store;
    }

    const tables = Object.fromEntries(
        withTables.map((plugin) => [plugin.name, plugin.definition.tables as Readonly<Record<string, unknown>>]),
    );

    if ("dialect" in given && given.dialect === "postgres" && "pglite" in given)
    {
        return postgres({ pglite: given.pglite, ...(given.schema === undefined ? {} : { schema: given.schema }), tables });
    }

    if ("dialect" in given && given.dialect === "postgres" && "url" in given)
    {
        return postgres({ url: given.url, ...(given.poolSize === undefined ? {} : { poolSize: given.poolSize }), tables, ...(log === undefined ? {} : { log }) });
    }

    return database({ ...given as DatabaseOptions, tables });
}


/** Boots the whole application, refusing before it serves anything: declared tables or indexes no migration creates, migrations reading another plugin's table without depending on it, tables with no database, and a store missing `migrate` or `close`. */
export async function start(options: StartOptions): Promise<StartedApp>
{
    const log = options.log;

    const withTables = options.plugins.filter((plugin) => plugin.definition.tables !== undefined);

    if (options.database === undefined && withTables.length > 0)
    {
        throw new TypeError(
            `${withTables.map((plugin) => `"${plugin.name}"`).join(", ")} declare tables, and start() was given no database. Pass one: database: { file: "./data/app.db" }, or a store of your own.`,
        );
    }

    const fakes = options.plugins.filter((plugin) => plugin.definition.fake === true).map((plugin) => plugin.name);

    // a stand-in in production answers as the real thing would and does nothing: free checkouts, mail never sent
    if (fakes.length > 0 && Env.isProduction() && !Env.allowsFake())
    {
        throw new TypeError(`${fakes.map((name) => `"${name}"`).join(", ")} ${fakes.length === 1 ? "is a stand-in" : "are stand-ins"} for a real provider, and this process runs as production. Configure the real provider, or set ALLOW_FAKE=true where the deployment is decided.`);
    }

    const store = await storeFor(options.database, withTables, log);

    const migrations = order(new Map(options.plugins.map((plugin) => [plugin.name, plugin])))
        .filter((plugin) => plugin.definition.migrations !== undefined)
        .map((plugin) => ({ plugin: plugin.name, from: plugin.definition.migrations as string }));

    if (typeof store.migrate !== "function" || typeof store.close !== "function")
    {
        throw new TypeError(
            "The store given to start() answers tx and forPlugin, but not migrate and close. start() owns the whole lifetime of a database, so it needs both: migrate before any plugin runs, close after every one has stopped. Add them, or build the kernel yourself with createKernel, which asks only for tx and forPlugin.",
        );
    }

    refuseUnmigrated(options.plugins, migrations);

    const steps = await store.migrate(migrations);

    if (steps.length > 0)
    {
        log?.info("migrations applied", { count: steps.length, steps: steps.map((step) => `${step.plugin}/${step.name}`) });
    }

    if (options.limits === false)
    {
        log?.warn("RATE LIMITS ARE NOT BEING COUNTED", {
            meaning: "every route's declared budget is ignored: nothing answers 429, however often it is called",
            turnOn: "remove limits: false, or leave it out entirely",
        });
    }

    const unbounded = options.plugins
        .flatMap((plugin) => (plugin.definition.routes ?? []).map((route) => ({ plugin: plugin.name, route })))
        .filter(({ route }) => route.public === true && route.limit === undefined)
        .map(({ plugin, route }) => `${plugin}: ${route.method} ${route.path}`);

    if (unbounded.length > 0)
    {
        log?.warn("PUBLIC ROUTES WITH NO LIMIT", {
            meaning: "anyone on the internet may call these as often as they like, and nothing answers 429",
            routes: unbounded,
            turnOn: "declare limit: { requests, seconds } on each, or count them in front of this process",
        });
    }

    const ourLimiter = options.rateLimiter === undefined && options.limits !== false ? limiter() : undefined;
    const rateLimiter = options.rateLimiter ?? ourLimiter ?? unlimited();

    const sweep = ourLimiter === undefined ? undefined : setInterval(() => void ourLimiter.sweep(), 60_000);

    sweep?.unref?.();

    const outbox = options.outbox === true ? store.outbox?.(options.outboxLeaseMs === undefined ? {} : { leaseMs: options.outboxLeaseMs }) : undefined;
    if (options.schedule !== undefined && options.schedule !== true && options.schedule !== false && options.schedule !== "enqueue")
    {
        throw new TypeError(`start: schedule ${JSON.stringify(options.schedule)} is not true, "enqueue" or false. Pass true where this process runs scheduled commands, "enqueue" where it only schedules them.`);
    }

    const later = options.schedule === true || options.schedule === "enqueue"
        ? store.schedule?.(options.jobLeaseMs === undefined ? {} : { leaseMs: options.jobLeaseMs })
        : undefined;

    const scoping = options.plugins.some((plugin) => plugin.definition.scope !== undefined);

    // how the processes serving this application hear each other: the project's own, LISTEN/NOTIFY on the Postgres
    // server they share, or one within this process when there is one process
    const server = options.database !== undefined && "url" in options.database ? options.database.url : undefined;
    const pubsub = options.pubsub ?? (server === undefined || options.sockets === false ? inProcessPubSub() : await postgresPubSub(server, log));
    let relayed: ReturnType<typeof relay> | undefined;

    const wires = options.sockets === false
        ? undefined
        : sockets({ channels: () => kernel.channels() }, typeof options.sockets === "object" ? options.sockets.claim : undefined, () => relayed?.changed());

    relayed = wires === undefined ? undefined : relay(wires, pubsub, log);

    const origin = crypto.randomUUID();

    // the kit's registry tables exist only where a plugin keeps entries per scope
    const keepsRegistries = options.plugins.some((plugin) => Object.values(plugin.definition.registries ?? {}).some((registry) => registry.scope === "tenant"));

    const keepsRuns = options.plugins.some((plugin) => Object.values(plugin.definition.pipelines ?? {}).some((pipeline) => pipeline.flavour === "durable"));

    const kernel = createKernel({
        plugins: options.plugins,
        db: store,
        ...(relayed !== undefined && { sockets: relayed }),
        // a dead letter put back is deliverable at once: the other processes hear it rather than wait for their beat
        ...(outbox !== undefined && { woken: () => pubsub.publish("kit.outbox", origin) }),
        ...(outbox !== undefined && { outbox }),
        ...(later !== undefined && { schedule: later }),
        ...(options.schedule === "enqueue" && { runsSchedule: false }),
        ...(options.jobRunMs !== undefined && { jobRunMs: options.jobRunMs }),
        ...(scoping && store.createScopeFilter !== undefined && { scopeFilter: store.createScopeFilter() }),
        ...(keepsRegistries && store.registries !== undefined && { registries: store.registries() }),
        ...(keepsRuns && store.runs !== undefined && { runs: store.runs() }),
        rateLimiter,
        httpClient: typeof options.httpClient === "function" ? options.httpClient : httpClient(options.httpClient ?? {}),
        ...(options.lookup !== undefined && { lookup: options.lookup }),
        ...(options.mostStreamsPerCaller !== undefined && { mostStreamsPerCaller: options.mostStreamsPerCaller }),
        ...(options.streamDrainMs !== undefined && { streamDrainMs: options.streamDrainMs }),
        ...(options.strictReplyHeaders !== undefined && { strictReplyHeaders: options.strictReplyHeaders }),
        ...(options.config !== undefined && { config: options.config }),
        ...(log !== undefined && {
            log: (level, plugin, line, about) =>
            {
                log[level](`${plugin}: ${line}`, traced(about));
            },
        }),
    });

    // another process put a dead letter back: one claim now, rather than at this process's next beat
    const stopWaking = outbox === undefined
        ? undefined
        : pubsub.subscribe("kit.outbox", (from) =>
        {
            if (from !== origin && kernel.started())
            {
                kernel.redeliver().catch(() => undefined);
            }
        });

    await kernel.start();

    log?.info("kernel started", { plugins: options.plugins.length, routes: kernel.routes().length });

    const identify = options.identify?.(kernel);

    const app = serve({
        kernel,
        ...(identify !== undefined && { identify }),
        ...(options.http ?? {}),
        ...(log !== undefined && {
            log: (level, line, about) =>
            {
                log[level](line, traced(about));
            },
        }),
    });

    return {
        kernel,
        store,
        app,
        fetch: app.fetch,
        sockets: wires === undefined ? undefined : { subscribe: wires.subscribe },

        served: {
            origins: options.http?.origins ?? [],
            session: options.http?.session,
            bodyBytes: options.http?.bodyBytes ?? 1_000_000,
            from: options.http?.from,

            // one answer for HTTP and the socket: a socket identified another way hears nothing a request could
            identify: async (c) => identify === undefined ? kernel.identify?.(withSessionKey(c.req.raw, options.http?.session)) : identify(c),
        },

        stop: async (): Promise<void> =>
        {
            if (sweep !== undefined)
            {
                clearInterval(sweep);
            }

            stopWaking?.();
            await kernel.stop();
            relayed?.stop();

            if (options.pubsub === undefined)
            {
                await pubsub.close();
            }

            await store.close();
        },
    };
}
