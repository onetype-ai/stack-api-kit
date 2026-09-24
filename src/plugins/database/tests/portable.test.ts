import { sql } from "drizzle-orm";
import { getTableConfig as pgConfigOf } from "drizzle-orm/pg-core";
import { getTableConfig as liteConfigOf } from "drizzle-orm/sqlite-core";
import { afterEach, describe, expect, test, vi } from "vitest";

// the dialect is read once a module, so each case loads the entry afresh under its own environment
const load = async (environment: Readonly<Record<string, string | undefined>>): Promise<typeof import("../api")> =>
{
    for (const [name, value] of Object.entries(environment))
    {
        vi.stubEnv(name, value);
    }

    vi.resetModules();

    return import("../api");
};

afterEach(() =>
{
    vi.unstubAllEnvs();
});

const define = (tables: typeof import("../api")) =>
{
    const { column, index, table, uniqueIndex } = tables;

    return table("items_items", {
        id: column.id().primaryKey(),
        title: column.text("title").notNull(),
        position: column.integer("position").notNull().default(0),
        isArchived: column.boolean("is_archived").notNull().default(false),
        details: column.json<{ tags: string[] }>("details").notNull(),
        createdAt: column.timeMs("created_at").notNull(),
        score: column.real("score"),
    }, (self) => [
        index("items_items_by_created").on(self.createdAt),
        uniqueIndex("items_items_one_open").on(self.title).where(sql`is_archived = false`),
    ]);
};

describe("one table definition", () =>
{
    test("is a SQLite table when nothing names a dialect", async () =>
    {
        const tables = await load({ KIT_DIALECT: undefined, DATABASE_URL: "./data/app.db" });

        const config = liteConfigOf(define(tables) as never);

        expect(tables.dialect()).toBe("sqlite");
        expect(config.columns.map((one) => [one.name, one.getSQLType()])).toEqual([
            ["id", "text"], ["title", "text"], ["position", "integer"], ["is_archived", "integer"], ["details", "text"], ["created_at", "integer"], ["score", "real"],
        ]);
        expect(config.indexes.map((one) => [one.config.name, one.config.unique])).toEqual([["items_items_by_created", false], ["items_items_one_open", true]]);
    });

    test.each([
        ["KIT_DIALECT", { KIT_DIALECT: "postgres" }],
        ["a Postgres DATABASE_URL", { KIT_DIALECT: undefined, DATABASE_URL: "postgres://app@localhost/app" }],
    ])("is a Postgres table under %s, with bigint times and jsonb", async (_what, environment) =>
    {
        const tables = await load(environment);

        const config = pgConfigOf(define(tables) as never);

        expect(tables.dialect()).toBe("postgres");
        expect(config.columns.map((one) => [one.name, one.getSQLType()])).toEqual([
            ["id", "text"], ["title", "text"], ["position", "integer"], ["is_archived", "boolean"], ["details", "jsonb"], ["created_at", "bigint"], ["score", "double precision"],
        ]);
        expect(config.indexes.map((one) => [one.config.name, one.config.unique])).toEqual([["items_items_by_created", false], ["items_items_one_open", true]]);
    });
});

describe("a primary key of several columns", () =>
{
    const keyed = (tables: typeof import("../api")) => tables.table("contacts_visitors", {
        workspaceId: tables.column.text("workspace_id").notNull(),
        visitorId: tables.column.text("visitor_id").notNull(),
    }, (self) => [tables.primaryKey({ columns: [self.workspaceId, self.visitorId] })]);

    test("is one key over those columns on SQLite and on Postgres", async () =>
    {
        const lite = liteConfigOf(keyed(await load({ KIT_DIALECT: "sqlite" })) as never);
        const pg = pgConfigOf(keyed(await load({ KIT_DIALECT: "postgres" })) as never);

        expect(lite.primaryKeys.map((key) => key.columns.map((one) => one.name))).toEqual([["workspace_id", "visitor_id"]]);
        expect(pg.primaryKeys.map((key) => key.columns.map((one) => one.name))).toEqual([["workspace_id", "visitor_id"]]);
    });

    test("keeps the name it is given", async () =>
    {
        const tables = await load({ KIT_DIALECT: "postgres" });
        const named = tables.table("contacts_visitors", { workspaceId: tables.column.text("workspace_id").notNull(), visitorId: tables.column.text("visitor_id").notNull() }, (self) => [tables.primaryKey({ name: "contacts_visitors_key", columns: [self.workspaceId, self.visitorId] })]);

        expect(pgConfigOf(named as never).primaryKeys[0]?.getName()).toBe("contacts_visitors_key");
    });
});

describe("refuses", () =>
{
    test("an extra not made with index, uniqueIndex or primaryKey, naming them", async () =>
    {
        const tables = await load({ KIT_DIALECT: "sqlite" });

        const foreign = tables.table("items_items", { id: tables.column.id().primaryKey() }, () => [{ something: "else" }]);

        expect(() => liteConfigOf(foreign as never)).toThrow(/index, uniqueIndex or primaryKey/);
    });

    test("a database of another dialect than the tables were built for, naming both", async () =>
    {
        const tables = await load({ KIT_DIALECT: "postgres" });
        define(tables);

        expect(() => tables.refuseOtherDialect("sqlite")).toThrow(expect.objectContaining({ code: "MIXED_DIALECT", message: expect.stringContaining("items_items were built for postgres, and the database is sqlite") }));
    });

    test("nothing when a column is only inspected, awaited or compared", async () =>
    {
        const tables = await load({ KIT_DIALECT: "sqlite" });
        const title = tables.column.text("title");

        expect(title).toBeDefined();
        expect(() => String(Object.prototype.toString.call(title))).not.toThrow();
        expect(await Promise.resolve(title)).toBe(title);
    });

    test("a column told something outside the portable set", async () =>
    {
        const tables = await load({ KIT_DIALECT: "sqlite" });
        const told = tables.column.text("title") as unknown as { generatedAlwaysAs: (value: string) => unknown };

        expect(() => told.generatedAlwaysAs("x")).toThrow(expect.objectContaining({ code: "UNPORTABLE_COLUMN", plugin: "database" }));
    });

    test("a dialect it does not know", async () =>
    {
        const tables = await load({ KIT_DIALECT: "mysql" });

        expect(() => tables.dialect()).toThrow("KIT_DIALECT is \"mysql\"");
    });
});
