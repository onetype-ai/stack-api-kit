import type { PipelineRun, PipelineStore } from "../../kernel/api";

import { createTogether } from "./schedule";
import { serialized } from "./sql";

import type { Around, Sql } from "./sql";

type Row = { id: string; pipeline: string; scope: string; status: PipelineRun["status"]; step: string | null; attempts: number | string; output: string | null; input: string };

/** Both tables, as either dialect creates them. */
function tablesOf(sql: Sql): string
{
    const whole = sql.dialect === "postgres" ? "BIGINT" : "INTEGER";

    return `
        CREATE TABLE IF NOT EXISTS "kit_pipeline_runs" (
            "id" TEXT PRIMARY KEY,
            "pipeline" TEXT NOT NULL,
            "scope" TEXT NOT NULL,
            "key" TEXT NOT NULL,
            "input" TEXT NOT NULL,
            "status" TEXT NOT NULL,
            "step" TEXT,
            "attempts" INTEGER NOT NULL DEFAULT 0,
            "output" TEXT,
            "createdAt" ${whole} NOT NULL,
            UNIQUE ("pipeline", "scope", "key")
        );
        CREATE TABLE IF NOT EXISTS "kit_pipeline_steps" (
            "runId" TEXT NOT NULL,
            "stepId" TEXT NOT NULL,
            "result" TEXT NOT NULL,
            PRIMARY KEY ("runId", "stepId")
        );
    `;
}

function prepare(sql: Sql): Promise<void>
{
    if (sql.now === undefined)
    {
        return createTogether(sql, tablesOf(sql));
    }

    sql.now.exec(tablesOf(sql));

    return Promise.resolve();
}

/** Where durable pipeline runs keep their input and results, in the same database as the schedule running them. */
export function runsOver(sql: Sql, around: Around = {}): PipelineStore
{
    const ready = prepare(sql);
    const within = around.within ?? (() => sql);
    const free = around.outside === undefined ? sql : serialized(sql, around.outside);

    ready.catch(() => undefined);

    return {
        begin: async (db, { id, pipeline, scope, key, input }) =>
        {
            await ready;

            const inside = within(db);

            // one statement, so two runs asked for with one key at once cannot both start
            const { changes } = await inside.run(
                `INSERT INTO "kit_pipeline_runs" ("id", "pipeline", "scope", "key", "input", "status", "createdAt") VALUES (?, ?, ?, ?, ?, 'running', ?)
                 ON CONFLICT ("pipeline", "scope", "key") DO NOTHING`,
                [id, pipeline, scope, key, JSON.stringify(input), Date.now()],
            );

            if (changes > 0)
            {
                return { id, isNew: true };
            }

            const [first] = await inside.rows<{ id: string }>(`SELECT "id" FROM "kit_pipeline_runs" WHERE "pipeline" = ? AND "scope" = ? AND "key" = ?`, [pipeline, scope, key]);

            return { id: first?.id ?? id, isNew: false };
        },

        get: async (id) =>
        {
            await ready;

            const [row] = await free.rows<Row>(`SELECT "id", "pipeline", "scope", "status", "step", "attempts", "output", "input" FROM "kit_pipeline_runs" WHERE "id" = ?`, [id]);

            return row === undefined ? undefined : {
                id: row.id,
                pipeline: row.pipeline,
                scope: row.scope,
                status: row.status,
                step: row.step ?? undefined,
                attempts: Number(row.attempts),
                output: row.output === null ? undefined : JSON.parse(row.output) as unknown,
                input: JSON.parse(row.input) as unknown,
            };
        },

        results: async (id) =>
        {
            await ready;

            const rows = await free.rows<{ stepId: string; result: string }>(`SELECT "stepId", "result" FROM "kit_pipeline_steps" WHERE "runId" = ?`, [id]);

            return new Map(rows.map((row) => [row.stepId, JSON.parse(row.result) as unknown]));
        },

        keep: async (db, id, step, result) =>
        {
            await ready;

            const { changes } = await within(db).run(
                `INSERT INTO "kit_pipeline_steps" ("runId", "stepId", "result") VALUES (?, ?, ?) ON CONFLICT ("runId", "stepId") DO NOTHING`,
                [id, step, JSON.stringify(result)],
            );

            return changes > 0;
        },

        finish: async (db, id, output) =>
        {
            await ready;

            await within(db).run(`UPDATE "kit_pipeline_runs" SET "status" = 'done', "output" = ?, "step" = NULL WHERE "id" = ?`, [JSON.stringify(output), id]);
        },

        attempted: async (id) =>
        {
            await ready;

            const [row] = await free.rows<{ attempts: number | string }>(`UPDATE "kit_pipeline_runs" SET "attempts" = "attempts" + 1 WHERE "id" = ? RETURNING "attempts"`, [id]);

            return Number(row?.attempts ?? 0);
        },

        fail: async (db, id, step) =>
        {
            await ready;

            const { changes } = await within(db).run(`UPDATE "kit_pipeline_runs" SET "status" = 'failed', "step" = ? WHERE "id" = ? AND "status" = 'running'`, [step, id]);

            return changes > 0;
        },

        revive: async (db, id) =>
        {
            await ready;

            const { changes } = await within(db).run(`UPDATE "kit_pipeline_runs" SET "status" = 'running', "step" = NULL, "attempts" = 0 WHERE "id" = ? AND "status" = 'failed'`, [id]);

            return changes > 0;
        },
    };
}
