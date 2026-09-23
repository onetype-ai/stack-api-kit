import type { Identity, HttpRequest, ChannelReach } from "./contract";
import type { ResolvedAddress } from "./resolve";

/** What the kernel needs to reach storage. */
export type KernelStore = {
    /** One plugin's own handle. What it holds is the project's business. */
    forPlugin: (plugin: string) => unknown;

    /** Runs work in one transaction, rolled back if it throws. */
    tx: <Result>(plugin: string, run: (db: unknown) => Promise<Result>) => Promise<Result>;

    /** Runs work that is not in a transaction, but never during someone else's. Optional, so a project may pass a store needing no such ordering. */
    write?: <Result>(run: () => Promise<Result>) => Promise<Result>;

    /** Whether a transaction is open right now. For diagnosis. */
    inTransaction?: () => boolean;
};

/** One event, as it waits to be delivered. */
export type OutboxMessage = {
    id: string;
    plugin: string;
    name: string;
    payload: unknown;
};

/** Where events wait, so one is never lost between a commit and its delivery. */
/**
 * Delivery is at least once per listener: a listener that throws is retried in the running process with backoff (2^n s, 300 s at most),
 * and only the listeners that have not heard the event are called again. After `mostAttempts` the row stays as a dead letter,
 * logged once, until `work.retryFailed`. A listener that charges, sends or bills must recognise what it already did (the event id).
 * Order holds within one event's listeners only: a retried event can reach a listener after a later one.
 */
export type Outbox = {
    /** Writes events inside the transaction that emitted them. */
    save: (db: unknown, messages: readonly OutboxMessage[]) => void;

    /** Marks one delivered. */
    markSent: (id: string) => Promise<void>;

    /** What was kept but never marked sent. Read once, at startup, by a kernel whose outbox cannot `claim`. */
    pending: () => Promise<readonly OutboxMessage[]>;

    /** Leases what is due for another delivery: failed before and waiting out its backoff, or never cleared after a grace period. */
    claim?: (now: number, limit: number) => Promise<readonly (OutboxMessage & { heard: readonly string[]; attempts: number })[]>;

    /** How long a row stays with the process delivering it without a renewal. */
    leaseMs?: number;

    /** Keeps the lease on a row this process is delivering; false when another has taken it. */
    renew?: (id: string, now: number) => Promise<boolean>;

    /** One listener heard it: kept at once, so a process that dies mid-delivery repeats only the rest. */
    markHeard?: (id: string, listener: string) => Promise<void>;

    /** Some listeners threw: keep which heard it, and try the rest again at `at`. */
    markRetry?: (id: string, heard: readonly string[], attempts: number, at: number) => Promise<void>;

    /** A listener kept throwing: keep the row as a dead letter. */
    markDead?: (id: string, heard: readonly string[], attempts: number, at: number) => Promise<void>;

    /** The dead letters, without their payloads. */
    failed?: () => Promise<readonly FailedEvent[]>;

    /** Puts one dead letter back to be delivered now; false when no dead letter has that id. */
    revive?: (id: string, now: number) => Promise<boolean>;

    /** How many rows wait for their first delivery, are being retried, or are dead letters. */
    counts?: (now: number) => Promise<{ waiting: number; retrying: number; dead: number }>;
};

/** How scheduled work and the outbox are doing, as an operator sees it: counts, names and times, never a job's input or an event's payload. */
export type WorkWatch = {
    health: () => Promise<{
        jobs: { due?: number; later?: number; running?: number; abandoned?: number; failed: number };
        outbox: { waiting?: number; retrying?: number; dead?: number };
    }>;

    /** Scheduled commands given up in this process, newest last, without their input. */
    failedJobs: () => readonly { plugin: string; command: string; attempts: number; at: number; error: string }[];

    failedEvents: () => Promise<readonly FailedEvent[]>;
    retryFailed: (id: string) => Promise<boolean>;
};

/** An event a listener kept refusing, as an operator sees it. */
export type FailedEvent = {
    id: string;
    plugin: string;
    name: string;

    /** The listeners (plugin names) that did hear it. */
    heard: readonly string[];
    attempts: number;
    failedAt: number;
};

/** One command waiting for its moment. */
export type QueuedJob = {
    id: string;
    plugin: string;
    command: string;
    input: unknown;
    at: number;
    attempts: number;

    /** Which claim holds it, when the schedule leases per claim. */
    lease?: string;
};

/** One scheduled command that ran out of attempts, and why. */
export type FailedJob = {
    plugin: string;
    command: string;
    input: unknown;
    attempts: number;
    error: unknown;
    at: number;
};

/** Where work waits until it is time. */
export type Schedule = {
    /** Writes one, inside the transaction that asked for it when there is one. */
    save: (db: unknown, job: QueuedJob) => void;

    /** Claims what is due, at most `limit`, marking each taken; a job whose lease ran out is claimed again with its lost run counted. */
    claim: (now: number, limit: number) => Promise<readonly QueuedJob[]>;

    /** How long a claim holds without `renew`; the kernel renews every third of it while the command runs. */
    leaseMs?: number;

    /** How many jobs are due, waiting for later, running within their lease, and held by a lease that ran out. */
    counts?: (now: number) => Promise<{ due: number; later: number; running: number; abandoned: number }>;

    /** Keeps a claim; false when the lease was taken since, and this run should stop counting on it. */
    renew?: (id: string, now: number, lease?: string) => Promise<boolean>;

    /** It ran. Forget it; with `lease`, only if that claim still holds it. */
    markDone: (id: string, lease?: string) => Promise<void>;

    /** It threw. Put it back for `at`, having counted the attempt; with `lease`, only if that claim still holds it. */
    markFailed: (id: string, at: number, lease?: string) => Promise<void>;

    /** It threw too many times. Stop trying; with `lease`, only if that claim still holds it. */
    giveUp: (id: string, lease?: string) => Promise<void>;
};

/** How a scope becomes a condition the database understands; `plugin` names whose table it is, since two plugins may each name a table alike. */
export type ScopeFilter = (table: string, column: string, value: string, plugin?: string) => unknown;

/** What the kernel needs to call another server; `pin`, when given, is the address the kernel checked, and the call is dialled there rather than wherever the name resolves now. */
export type HttpClient = (call: HttpRequest, pin?: ResolvedAddress) => Promise<unknown>;

/** One message on its way out, and how far it goes. */
export type ChannelMessage = {
    channel: string;
    message: unknown;
    reach: ChannelReach;
    requires: readonly string[];

    /** The scope it stays inside, when its reach is one. */
    scope: string | undefined;

    /** Whose request pushed it, for a reach of "viewer". */
    from: Identity | undefined;

    /** Which socket pushed it, for a reach of "connection"; absent means none can hear it. */
    fromConnection: string | undefined;

    /** The identity it is for, for a reach of "identity". */
    to?: string | undefined;
};

/** What holds the open sockets, when anything does. */
export type Sockets = {
    push: (sending: ChannelMessage) => void;

    /** Who holding a permission has a socket open in a scope, for `ctx.presence`. */
    connected?: (scope: string, permission: string) => readonly string[];
};
