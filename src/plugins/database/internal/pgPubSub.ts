import type { Client } from "pg";

import type { Logger, PubSub } from "../../kernel/api";

/** What Postgres carries in one notification is under 8000 bytes; a longer text travels as a row the notice points to. */
const MOST_NOTICE_BYTES = 7_900;
const BY_ROW = "row:";

const listenTo = (topic: string): string => `LISTEN "${topic.replaceAll('"', '""')}"`;

/** A key every process creating the pub/sub's table takes, as for the kit's other tables. */
const CREATING = 7_239_104_219;

export type PostgresPubSubTiming = {
    /** How long a long text's row is kept for the processes to read it: 60 s at most. */
    keepMs?: number;
    sweepMs?: number;
};

/**
 * Pub/sub over a Postgres server: LISTEN on one connection of its own, NOTIFY through a small pool of its own. Neither
 * is a store's connection, so nothing published waits for a transaction's commit or dies with its rollback. A text
 * longer than a notification holds is written to `kit_pushes` under a random id and the notice carries the id; rows
 * are swept after `keepMs` whether or not anything is published, since they hold what users were sent. A dropped
 * LISTEN connection is opened again with a growing pause; what was published meanwhile is lost, as at most once allows.
 */
export async function postgresPubSub(url: string, log?: Logger, timing: PostgresPubSubTiming = {}): Promise<PubSub>
{
    const { default: pg } = await import("pg");
    const pool = new pg.Pool({ connectionString: url, max: 2 });
    const keepMs = Math.min(timing.keepMs ?? 60_000, 60_000);
    const hearers = new Map<string, Set<(text: string) => void>>();

    let listening: Client | undefined;
    let closed = false;
    let pauseMs = 250;
    let reconnecting: ReturnType<typeof setTimeout> | undefined;
    let listens = Promise.resolve();

    pool.on("error", (cause: Error) =>
    {
        log?.error("database: an idle pub/sub connection failed; the pool drops it and opens another", { cause: cause.message });
    });

    const created = await pool.connect();

    try
    {
        await created.query("BEGIN");
        await created.query("SELECT pg_advisory_xact_lock($1)", [CREATING]);
        await created.query(`CREATE TABLE IF NOT EXISTS "kit_pushes" ("id" TEXT PRIMARY KEY, "body" TEXT NOT NULL, "at" BIGINT NOT NULL)`);
        await created.query("COMMIT");
    }
    catch (cause)
    {
        await created.query("ROLLBACK").catch(() => undefined);

        throw cause;
    }
    finally
    {
        created.release();
    }

    const hand = async (topic: string, payload: string): Promise<void> =>
    {
        let text = payload;

        if (payload.startsWith(BY_ROW))
        {
            const found = await pool.query<{ body: string }>(`SELECT "body" FROM "kit_pushes" WHERE "id" = $1`, [payload.slice(BY_ROW.length)]);

            if (found.rows[0] === undefined)
            {
                return;
            }

            text = found.rows[0].body;
        }

        for (const hear of [...(hearers.get(topic) ?? [])])
        {
            hear(text);
        }
    };

    const connect = async (): Promise<void> =>
    {
        const client = new pg.Client({ connectionString: url });

        client.on("notification", (notice) =>
        {
            void hand(notice.channel, notice.payload ?? "").catch((cause: unknown) =>
            {
                log?.error("database: a published message could not be read", { cause: cause instanceof Error ? cause.message : String(cause) });
            });
        });

        client.on("error", () =>
        {
            again(client);
        });

        client.on("end", () =>
        {
            again(client);
        });

        await client.connect();

        for (const topic of hearers.keys())
        {
            await client.query(listenTo(topic));
        }

        listening = client;
        pauseMs = 250;
    };

    // one LISTEN at a time on the one connection: pg refuses a query sent while another runs. One refused
    // would leave the process deaf to its topic, so it is logged and the connection is opened again,
    // which listens to every topic afresh.
    const listen = (topic: string): void =>
    {
        listens = listens.then(async () =>
        {
            const client = listening;

            if (client === undefined)
            {
                return;
            }

            try
            {
                await client.query(listenTo(topic));
            }
            catch (cause)
            {
                log?.error("database: the pub/sub connection could not listen to a topic; opening it again", { topic, cause: cause instanceof Error ? cause.message : String(cause) });
                again(client);
                await client.end().catch(() => undefined);
            }
        });
    };

    // once per drop: the listening connection is replaced, and a pause grows while the server stays away
    const again = (client: Client): void =>
    {
        if (closed || listening !== client)
        {
            return;
        }

        listening = undefined;
        log?.warn("database: the pub/sub connection dropped; opening it again");

        const retry = (): void =>
        {
            reconnecting = setTimeout(() =>
            {
                connect().catch(() =>
                {
                    pauseMs = Math.min(pauseMs * 2, 10_000);
                    retry();
                });
            }, pauseMs);
            reconnecting.unref();
        };

        retry();
    };

    await connect();

    const sweeping = setInterval(() =>
    {
        pool.query(`DELETE FROM "kit_pushes" WHERE "at" < $1`, [Date.now() - keepMs]).catch(() => undefined);
    }, timing.sweepMs ?? 10_000);

    sweeping.unref();

    return {
        publish: (topic, text) =>
        {
            const send = async (): Promise<void> =>
            {
                if (Buffer.byteLength(text) <= MOST_NOTICE_BYTES)
                {
                    await pool.query("SELECT pg_notify($1, $2)", [topic, text]);

                    return;
                }

                const id = crypto.randomUUID();

                await pool.query(`INSERT INTO "kit_pushes" ("id", "body", "at") VALUES ($1, $2, $3)`, [id, text, Date.now()]);
                await pool.query("SELECT pg_notify($1, $2)", [topic, `${BY_ROW}${id}`]);
            };

            // at most once: a failed publish is logged without its text, and nobody waits for it
            send().catch((cause: unknown) =>
            {
                log?.error("database: a message could not be published", { topic, cause: cause instanceof Error ? cause.message : String(cause) });
            });
        },

        subscribe: (topic, hear) =>
        {
            const heard = hearers.get(topic) ?? new Set();
            const isFirst = heard.size === 0;

            heard.add(hear);
            hearers.set(topic, heard);

            if (isFirst)
            {
                listen(topic);
            }

            return () =>
            {
                heard.delete(hear);
            };
        },

        close: async () =>
        {
            closed = true;
            clearInterval(sweeping);
            clearTimeout(reconnecting);
            await listening?.end().catch(() => undefined);
            await pool.end();
        },
    };
}
