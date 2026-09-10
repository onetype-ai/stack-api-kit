import type { Identity, HttpRequest, ChannelReach } from "./contract";

/** What the kernel needs to reach storage. */
export type KernelStore = {
    /** One plugin's own handle. What it holds is the project's business. */
    forPlugin: (plugin: string) => unknown;

    /** Runs work in one transaction, rolled back if it throws. */
    tx: <Result>(plugin: string, run: (db: unknown) => Promise<Result>) => Promise<Result>;

    /**
     * Runs work that is not in a transaction, but never during someone
     * else's. Optional, so a project may pass a store that needs no such
     * ordering.
     */
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
export type Outbox = {
    /** Writes events inside the transaction that emitted them. */
    save: (db: unknown, messages: readonly OutboxMessage[]) => void;

    /** Marks one delivered. */
    markSent: (id: string) => Promise<void>;

    /** What was kept but never marked sent. Read once, at startup. */
    pending: () => Promise<readonly OutboxMessage[]>;
};

/** One command waiting for its moment. */
export type QueuedJob = {
    id: string;
    plugin: string;
    command: string;
    input: unknown;
    at: number;
    attempts: number;
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

    /** Claims what is due, at most `limit`, marking each taken. */
    claim: (now: number, limit: number) => Promise<readonly QueuedJob[]>;

    /** It ran. Forget it. */
    markDone: (id: string) => Promise<void>;

    /** It threw. Put it back for `at`, having counted the attempt. */
    markFailed: (id: string, at: number) => Promise<void>;

    /** It threw too many times. Stop trying. */
    giveUp: (id: string) => Promise<void>;
};

/** How a scope becomes a condition the database understands. */
export type ScopeFilter = (table: string, column: string, value: string) => unknown;

/** What the kernel needs to call another server. */
export type HttpClient = (call: HttpRequest) => Promise<unknown>;

/** One message on its way out, and how far it goes. */
export type ChannelMessage = {
    channel: string;
    message: unknown;
    reach: ChannelReach;
    requires: readonly string[];

    /** The scope it stays inside, when its reach is one. */
    scope: string | undefined;

    /** Whose request pushed it, for a reach of "connection" or "viewer". */
    from: Identity | undefined;
};

/** What holds the open sockets, when anything does. */
export type Sockets = {
    push: (sending: ChannelMessage) => void;
};
