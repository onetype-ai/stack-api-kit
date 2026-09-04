import type { Outbound } from "./contract";

/**
 * What the kernel needs to reach storage.
 *
 * A shape rather than a driver: the kernel never imports a database, so a
 * project chooses one and a test passes its own. Narrower than what
 * `database()` returns, which also opens, migrates and closes: the kernel
 * needs none of that and should not be able to do it.
 */
export type Storage = {
    /** One plugin's own handle. What it holds is the project's business. */
    of: (plugin: string) => unknown;

    /** Runs work in one transaction, rolled back if it throws. */
    tx: <Made>(plugin: string, run: (db: unknown) => Promise<Made>) => Promise<Made>;

    /**
     * Runs work that is not in a transaction, but never during someone
     * else's. Optional, so a project may pass a store that needs no such
     * ordering.
     */
    write?: <Made>(run: () => Promise<Made>) => Promise<Made>;

    /** Whether a transaction is open right now. For diagnosis. */
    inTransaction?: () => boolean;
};

/** One event, as it waits to be delivered. */
export type Announcement = {
    id: string;
    plugin: string;
    name: string;
    payload: unknown;
};

/**
 * Where events wait, so one is never lost between a commit and its delivery.
 *
 * Without this, an event lives only in memory: the work commits, the process
 * dies, and the listener is never called by anything. Nobody is told, because
 * the emitter was told nothing to begin with.
 *
 * `keep` runs inside the emitting transaction, so an event is written exactly
 * when the work it announces is, and rolled back with it. `sent` runs after
 * delivery. Anything still kept at startup was interrupted, and `waiting`
 * hands it back to be delivered again.
 *
 * Delivery is therefore at least once, never exactly once: a listener that
 * writes must be able to run twice on one event without doubling anything.
 */
export type Outbox = {
    /** Writes events inside the transaction that emitted them. */
    keep: (db: unknown, announcements: readonly Announcement[]) => void;

    /** Marks one delivered. */
    sent: (id: string) => Promise<void>;

    /** What was kept but never marked sent. Read once, at startup. */
    waiting: () => Promise<readonly Announcement[]>;
};

/** One command waiting for its moment. */
export type Scheduled = {
    id: string;
    plugin: string;
    command: string;
    input: unknown;
    at: number;
    attempts: number;
};

/**
 * Where work waits until it is time.
 *
 * The kernel has no clock of its own and no timer: it asks `due` on a beat
 * the project set, runs what it is handed, and says how it went. Everything
 * that has to survive a restart lives in the database, so a process that
 * stops between taking a job and finishing it leaves the job takeable again.
 *
 * `take` is what makes one process pick up a job and not another: it must
 * claim and return in one step, or two processes run the same work.
 */
export type Schedule = {
    /** Writes one, inside the transaction that asked for it when there is one. */
    keep: (db: unknown, job: Scheduled) => void;

    /** Claims what is due, at most `limit`, marking each taken. */
    take: (now: number, limit: number) => Promise<readonly Scheduled[]>;

    /** It ran. Forget it. */
    done: (id: string) => Promise<void>;

    /** It threw. Put it back for `at`, having counted the attempt. */
    failed: (id: string, at: number) => Promise<void>;

    /** It threw too many times. Stop trying. */
    gaveUp: (id: string) => Promise<void>;
};

/**
 * How a scope becomes a condition the database understands.
 *
 * The kernel imports no driver, so it cannot build one: it knows which table
 * and which value, and the project turns that into whatever its store speaks.
 */
export type Narrowing = (table: string, column: string, value: string) => unknown;

/** What the kernel needs to call another server. */
export type Dialer = (call: Outbound) => Promise<unknown>;
