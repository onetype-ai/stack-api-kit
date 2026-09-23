import { AsyncLocalStorage } from "node:async_hooks";

import type { Identity, Context, HttpRequest, Plugin } from "./contract";
import type { events, PendingDelivery } from "./events";
import { Refusal } from "./refusal";
import { KernelFault } from "./faults";
import { blockedUrlReason, refusalReasonOf } from "./privateAddress";
import { HttpRequestError } from "./httpError";
import { DEFAULT_REDIRECTS, FOLLOW_BUDGET_MS, hopOf, nextHop, redirectsOf, type Hop } from "./redirects";
import { publicAddressOf, type Lookup } from "./resolve";
import type { hooks } from "./hooks";
import { createPermissions } from "./permissions";
import type { HttpClient, ScopeFilter, Outbox, Schedule, Sockets, KernelStore } from "./store";

/** Everything a context is built from. One object, so the shape is one line. */
export type KernelWiring = {
    known: ReadonlyMap<string, Plugin>;
    settings: ReadonlyMap<string, unknown>;
    /** Which transaction the running code is inside, if any. */
    open: AsyncLocalStorage<object>;
    config: Readonly<Record<string, unknown>>;
    bus: ReturnType<typeof events<Context>>;
    points: ReturnType<typeof hooks<Context>>;
    pending: Map<object, PendingDelivery[]>;

    /** What each plugin owns: one thing, living as long as the kernel does. */
    owned: Map<string, unknown>;
    db: KernelStore | undefined;

    /** What holds the open sockets, when the project started a server. */
    sockets: Sockets | undefined;

    /** Where events wait for delivery, when the project gave one. */
    outbox: Outbox | undefined;

    httpClient: HttpClient | undefined;

    /** How a name becomes the addresses a call to "anywhere" is checked against. */
    lookup: Lookup;

    /** What the project calls the current time. */
    now: () => number;

    /** Where later work waits, when the project gave somewhere. */
    schedule: Schedule | undefined;

    /** How a declared scope becomes a condition. */
    scopeFilter: ScopeFilter | undefined;
    log: (level: "debug" | "info" | "warn" | "error", plugin: string, line: string, about?: Readonly<Record<string, unknown>>) => void;
    run: (command: string, input: unknown, identity?: Identity) => Promise<void>;
};

/** Where in a transaction a context sits, if it is in one at all. */
type OpenTransaction = {
    mark: object;
    db: unknown;
};

/** What an absent dependency answers: a refusal naming who and what to pass. */
// The three entry points name the same wiring differently, so the message names each by the key that surface accepts.
function absentWiring(plugin: string, what: string, used: string, pass: string, onStart = pass): never
{
    throw new KernelFault(
        "NOT_STARTED",
        `"${plugin}" used ctx.${used}, but no ${what} was given. Pass \`${pass}\` to createKernel, or \`${onStart}\` to start.`,
        { plugin },
    );
}

/** The origin of a url, whatever its scheme, or undefined when it is not one. */
function originOf(url: string): string | undefined
{
    try
    {
        const parsed = new URL(url);

        if (parsed.host === "")
        {
            return undefined;
        }

        return parsed.origin === "null" || parsed.origin === ""
            ? `${parsed.protocol}//${parsed.host}`
            : parsed.origin;
    }
    catch
    {
        return undefined;
    }
}

/** A streamed answer names the address that answered, whichever client carried it. */
function streamedFrom(call: HttpRequest, answer: unknown): unknown
{
    return call.accepts === "stream" && typeof answer === "object" && answer !== null ? { ...answer, url: call.url } : answer;
}

/** Whether ctx.fetch can carry a call to this url at all. */
function isHttps(url: string): boolean
{
    return url.toLowerCase().startsWith("https://");
}

/** Builds what one plugin sees, for one identity. */
export function context(wiring: KernelWiring, plugin: string, identity?: Identity, openTransaction?: OpenTransaction, headers: Readonly<Record<string, string>> = {}, acting?: string, sent?: Uint8Array): Context
{
    const permissions = createPermissions(() => identity);
    const contextFor = (plugin: string, inside = openTransaction): Context =>
    {
        return context(wiring, plugin, identity, inside, headers, acting, sent);
    };

    /** What a listener is handed: this plugin, and nobody calling. */
    const listenerContext = (plugin: string): Context =>
    {
        return context(wiring, plugin, undefined, undefined, {});
    };

    const built = new Map<string, unknown>();

    const servicesFor = (name: string): unknown =>
    {
        if (built.has(name))
        {
            return built.get(name);
        }

        built.set(name, undefined);

        const services = wiring.known.get(name)?.definition.services?.(
            (name === plugin ? ctx : contextFor(name)) as never,
        );

        built.set(name, services);

        return services;
    };

    /** What a declared scope resolves to for this identity. */
    const scopeFor = (table: string): { column: string; tenant: string } =>
    {
        const scope = wiring.known.get(plugin)?.definition.scope;

        if (scope === undefined)
        {
            throw new KernelFault(
                "UNDECLARED_SCOPE",
                `"${plugin}" asked to scope "${table}", but declares no scope. Add one, naming the claim and which column each table carries it in.`,
                { plugin },
            );
        }

        const column = Object.hasOwn(scope.tables, table) ? scope.tables[table] : undefined;

        if (column === undefined)
        {
            throw new KernelFault(
                "UNDECLARED_SCOPE",
                `"${plugin}" asked to scope "${table}", which its scope does not name. Add it, or stop scoping a table nobody owns.`,
                { plugin },
            );
        }

        if (identity === undefined && acting === undefined)
        {
            throw new KernelFault(
                "UNSCOPED_CALLER",
                `"${plugin}" scoped "${table}" where nobody is calling. Name the scope with ctx.forScope(...), or read without scoping.`,
                { plugin },
            );
        }

        const tenant = identity === undefined ? acting : identity.claims[scope.claim];

        if (identity !== undefined && typeof identity.claims[scope.claim] !== "string")
        {
            const claimed = identity.claims[scope.claim];
            const explanation = claimed === undefined ? "carries no such claim" : `carries it as ${typeof claimed}, and a scope narrows by a string`;

            throw new KernelFault(
                "UNCLAIMED_SCOPE",
                `"${plugin}" scopes by "${scope.claim}", and the identity answered ${explanation}. Put it in the claims identifies returns, or scope by one it carries.`,
                { plugin },
            );
        }

        if (typeof tenant !== "string" || tenant.trim() === "")
        {
            throw new Refusal(
                403,
                "OUT_OF_SCOPE",
                "This request carries nothing to say whose rows it may reach.",
            );
        }

        return { column, tenant };
    };

    const ctx: Context = {
        name: plugin,
        config: wiring.settings.get(plugin) ?? wiring.config[plugin],

        get services(): unknown
        {
            return servicesFor(plugin);
        },

        identity,
        headers,
        sent,

        now: wiring.now,

        log: {
            debug: (line, about) =>
            {
                wiring.log("debug", plugin, line, about);
            },
            info: (line, about) =>
            {
                wiring.log("info", plugin, line, about);
            },
            warn: (line, about) =>
            {
                wiring.log("warn", plugin, line, about);
            },
            error: (line, about) =>
            {
                wiring.log("error", plugin, line, about);
            },
        },

        get db(): unknown
        {
            if (openTransaction !== undefined)
            {
                return openTransaction.db;
            }

            return wiring.db === undefined ? absentWiring(plugin, "store", "db", "db", "database") : wiring.db.forPlugin(plugin);
        },

        write: <Returned,>(run: () => Promise<Returned>): Promise<Returned> =>
        {
            if (openTransaction !== undefined || wiring.db?.write === undefined)
            {
                return run();
            }

            return wiring.db.write(run);
        },

        tx: async <Returned,>(run: (ctx: Context) => Promise<Returned>): Promise<Returned> =>
        {
            const store = wiring.db;

            if (store === undefined)
            {
                return absentWiring(plugin, "store", "db", "db", "database");
            }

            const mark = {};
            const outer = wiring.open.getStore();
            const nested = openTransaction !== undefined;

            wiring.pending.set(mark, []);

            try
            {
                const returned = await wiring.open.run(mark, () =>
                    store.tx(plugin, async (db) =>
                    {
                        const answer = await run(contextFor(plugin, { mark, db }));

                        const queued = wiring.pending.get(mark) ?? [];

                        if (wiring.outbox !== undefined && queued.length > 0 && !(nested && outer !== undefined))
                        {
                            wiring.outbox.save(db, queued.map((event) => ({
                                id: event.id,
                                plugin: event.plugin,
                                name: event.name,
                                payload: event.payload,
                            })));
                        }

                        return answer;
                    }));

                const announced = wiring.pending.get(mark) ?? [];

                if (nested && outer !== undefined)
                {
                    wiring.pending.get(outer)?.push(...announced);

                    return returned;
                }

                for (const announcement of announced)
                {
                    const delivered = wiring.bus.deliver(announcement.plugin, announcement.name, announcement.payload, (to) => listenerContext(to));

                    void delivered.then((heard) =>
                    {
                        if (heard)
                        {
                            // a delete that failed leaves the row for start() to
                            // replay, so say so rather than dying on the rejection
                            void wiring.outbox?.markSent(announcement.id).catch((cause: unknown) =>
                            {
                                wiring.log("error", announcement.plugin, `could not clear "${announcement.name}" from the outbox; it will be delivered again`, { cause: cause instanceof Error ? cause.message : String(cause) });
                            });
                        }
                    });
                }

                return returned;
            }
            finally
            {
                wiring.pending.delete(mark);
            }
        },

        // one implementation behind both overloads: a streamed call answers what the client streamed
        fetch: (async (call: HttpRequest): Promise<unknown> =>
        {
            // NaN would bound nothing: every size compares false against it, so a read would never stop
            if (call.maxBytes !== undefined && (!Number.isSafeInteger(call.maxBytes) || call.maxBytes < 1))
            {
                throw new KernelFault("INVALID_CALL", `"${plugin}" passed maxBytes ${String(call.maxBytes)}. Pass a whole number of bytes above 0, or leave it out for the client's default.`, { plugin });
            }

            const allowed = wiring.known.get(plugin)?.definition.allowedHosts ?? [];
            const host = originOf(call.url);
            const redirects = redirectsOf(plugin, call, allowed === "anywhere");

            if (allowed === "anywhere")
            {
                const client = wiring.httpClient ?? absentWiring(plugin, "httpClient", "fetch", "httpClient");
                const most = call.mostRedirects ?? DEFAULT_REDIRECTS;
                const budget = call.timeoutMs ?? FOLLOW_BUDGET_MS;
                const started = Date.now();

                let current = call;

                // every hop is checked as a first call is: the url, the name, every address it resolves to, pinned
                for (let hops = 0; ; hops += 1)
                {
                    const left = budget - (Date.now() - started);

                    if (redirects === "follow" && left <= 0)
                    {
                        throw new HttpRequestError("TIMEOUT", `The redirects did not end within ${String(budget)}ms.`);
                    }

                    const blocked = blockedUrlReason(current.url);

                    if (blocked !== undefined)
                    {
                        throw new KernelFault("UNDECLARED_HOST", `"${plugin}" called an address it may not reach. ${blocked}`, { plugin, detail: { reason: refusalReasonOf(current.url) } });
                    }

                    const pin = await publicAddressOf(new URL(current.url.trim()).hostname, wiring.lookup, plugin);

                    let hop: Hop | undefined;

                    try
                    {
                        const answer = await client(redirects === "follow" ? { ...current, redirects: "manual", timeoutMs: left } : current, pin);

                        hop = redirects === "follow" ? hopOf(answer) : undefined;

                        if (hop === undefined)
                        {
                            return streamedFrom(current, answer);
                        }
                    }
                    catch (cause)
                    {
                        if (redirects !== "follow" || !(cause instanceof HttpRequestError) || cause.code !== "REDIRECT" || cause.location === undefined || cause.status === undefined)
                        {
                            throw cause;
                        }

                        hop = { status: cause.status, location: cause.location };
                    }

                    if (hops + 1 > most)
                    {
                        throw new HttpRequestError("TOO_MANY_REDIRECTS", `The call was redirected more than ${String(most)} times.`);
                    }

                    current = nextHop(current, hop);
                }
            }

            if (host === undefined)
            {
                throw new KernelFault(
                    "UNDECLARED_HOST",
                    `"${plugin}" called "${call.url}", which is not an address.`,
                    { plugin },
                );
            }

            if (!allowed.includes(host))
            {
                throw new KernelFault(
                    "UNDECLARED_HOST",
                    `"${plugin}" called ${host}, which it does not declare. Add it to allowedHosts.`,
                    { plugin },
                );
            }

            if (!isHttps(call.url))
            {
                throw new KernelFault(
                    "UNDECLARED_HOST",
                    `"${plugin}" declares ${host}, but ctx.fetch speaks https and nothing else. Reach it with its own client, opened in setup and closed in teardown.`,
                    { plugin },
                );
            }

            return wiring.httpClient === undefined ? absentWiring(plugin, "httpClient", "fetch", "httpClient") : streamedFrom(call, await wiring.httpClient(call));
        }) as Context["fetch"],

        events: {
            emit: (event, payload) =>
            {
                const payloadChecked = wiring.bus.checkDeclared(plugin, event, payload);

                const mark = openTransaction?.mark ?? wiring.open.getStore();
                const queued = mark === undefined ? undefined : wiring.pending.get(mark);

                if (queued !== undefined)
                {
                    queued.push({ id: crypto.randomUUID(), plugin, name: event, payload: payloadChecked });

                    return;
                }

                // The outbox writes inside the transaction that emitted, so an
                // emit outside one cannot reach it. Delivering anyway looked
                // durable and was not: a failed listener lost the event with
                // nothing kept to retry.
                if (wiring.outbox !== undefined)
                {
                    throw new KernelFault(
                        "UNKEPT_EVENT",
                        `"${plugin}" emitted "${event}" outside a transaction while an outbox is configured, so nothing would keep it if a listener failed. Emit inside ctx.tx, or drop the outbox.`,
                        { plugin },
                    );
                }

                wiring.bus.deliver(plugin, event, payloadChecked, (to) => listenerContext(to));
            },
        },

        push: (channel: string, message: unknown): void =>
        {
            const declared = wiring.known.get(plugin)?.definition.channels?.[channel];

            if (declared === undefined)
            {
                throw new KernelFault(
                    "UNDECLARED_CHANNEL",
                    `"${plugin}" pushed on "${channel}", which it does not declare. Add it to channels.`,
                    { plugin },
                );
            }

            if (wiring.sockets === undefined)
            {
                absentWiring(plugin, "socket server", "push", "sockets");
            }

            const scope = wiring.known.get(plugin)?.definition.scope;
            const pushScope = identity === undefined ? acting : identity.claims[scope?.claim ?? ""];

            if (declared.reach === "scope" && typeof pushScope !== "string")
            {
                throw new Refusal(403, "OUT_OF_SCOPE", "This request carries nothing to say whose rows it may reach.");
            }

            wiring.sockets.push({
                channel,
                message: declared.schema.parse(message),
                reach: declared.reach,
                requires: declared.requires ?? [],
                scope: declared.reach === "scope" ? (pushScope as string) : undefined,
                from: identity,

                // the request path does not carry which socket asked, so a
                // "connection" push reaches nobody rather than every tab
                fromConnection: undefined,
            });
        },

        hooks: {
            run: (hook, payload) =>
            {
                return wiring.points.run(plugin, hook, payload, (to) => contextFor(to));
            },
        },

        permissions,

        commands: {
            run: (command, input) =>
            {
                return wiring.run(command, input, identity);
            },

            later: (command, input, inSeconds) =>
            {
                if (wiring.schedule === undefined)
                {
                    absentWiring(plugin, "schedule", "commands.later", "schedule");
                }

                const owns = wiring.known.get(plugin)?.definition.commands ?? {};

                if (!Object.hasOwn(owns, command))
                {
                    throw new KernelFault(
                        "UNDECLARED_COMMAND",
                        `"${plugin}" scheduled "${command}", which it does not declare. A plugin schedules only its own commands.`,
                        { plugin },
                    );
                }

                wiring.schedule.save(openTransaction?.db, {
                    id: crypto.randomUUID(),
                    plugin,
                    command,
                    input,
                    at: wiring.now() + inSeconds * 1000,
                    attempts: 0,
                });
            },
        },

        owns: <Kept,>(kept: Kept): Kept =>
        {
            wiring.owned.set(plugin, kept);

            return kept;
        },

        owned: <Kept,>(): Kept | undefined =>
        {
            return wiring.owned.get(plugin) as Kept | undefined;
        },

        forScope: (claim: string): Context =>
        {
            if (identity !== undefined)
            {
                throw new KernelFault(
                    "OUT_OF_SCOPE",
                    `"${plugin}" called ctx.forScope where the caller has a scope of their own.`,
                    { plugin },
                );
            }

            if (claim.trim() === "")
            {
                throw new KernelFault(
                    "OUT_OF_SCOPE",
                    `"${plugin}" called ctx.forScope with nothing. A scope acted for is named, or it is every scope.`,
                    { plugin },
                );
            }

            return context(wiring, plugin, undefined, openTransaction, headers, claim, sent);
        },

        stamped: (table: string): Readonly<Record<string, string>> =>
        {
            const { column, tenant } = scopeFor(table);

            return { [column]: tenant };
        },

        scoped: <Condition,>(table: string): Condition =>
        {
            const { column, tenant } = scopeFor(table);

            return (wiring.scopeFilter === undefined
                ? absentWiring(plugin, "createScopeFilter", "scoped", "scopeFilter")
                : wiring.scopeFilter(table, column, tenant)) as Condition;
        },

        use: <Api,>(name: string): Api =>
        {
            const dependsOn = wiring.known.get(plugin)?.definition.dependsOn ?? [];

            if (name !== plugin && !dependsOn.includes(name))
            {
                throw new KernelFault(
                    "UNDECLARED_DEPENDENCY",
                    `"${plugin}" reached "${name}", which it does not depend on. Add "${name}" to dependsOn.`,
                    { plugin },
                );
            }

            return servicesFor(name) as Api;
        },
    };

    return ctx;
}
