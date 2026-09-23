//
// Which suites run on which database. A suite that reaches a store runs on
// SQLite and on Postgres (PGlite), and is named here; one testing what only
// SQLite does says so in its name and stays on SQLite. A kit test fails a
// store suite named in no list, so none runs on one database unnoticed.
//

/** Suites run on SQLite and on Postgres. */
export const bothDialects = [
    "src/testing/tests/openApi.test.ts",
    "src/plugins/http/tests/sockets.test.ts",
    "src/plugins/kernel/tests/context.test.ts",
    "src/plugins/kernel/tests/inference.test.ts",
    "src/plugins/kernel/tests/later.test.ts",
    "src/plugins/kernel/tests/listener-scope.test.ts",
    "src/plugins/kernel/tests/outbox.test.ts",
    "src/plugins/kernel/tests/route-matching.test.ts",
    "src/plugins/kernel/tests/scoped-writes.test.ts",
    "src/plugins/kernel/tests/scoping.test.ts",
    "src/plugins/kernel/tests/shutdown.test.ts",
    "src/plugins/mount/tests/database.test.ts",
    "src/testing/tests/any-origin.test.ts",
    "src/testing/tests/anywhere.test.ts",
    "src/testing/tests/documents.test.ts",
    "src/testing/tests/egress-csv.test.ts",
    "src/testing/tests/either.test.ts",
    "src/testing/tests/empty.test.ts",
    "src/testing/tests/fakes-clock.test.ts",
    "src/testing/tests/fetching.test.ts",
    "src/testing/tests/files.test.ts",
    "src/testing/tests/flush-hops.test.ts",
    "src/testing/tests/flush.test.ts",
    "src/testing/tests/options.test.ts",
    "src/testing/tests/outbound-faults.test.ts",
    "src/testing/tests/recorder.test.ts",
    "src/testing/tests/records.test.ts",
    "src/testing/tests/redaction.test.ts",
    "src/testing/tests/redelivery.test.ts",
    "src/testing/tests/redirects.test.ts",
    "src/testing/tests/resolving.test.ts",
    "src/testing/tests/sockets.test.ts",
    "src/testing/tests/startTestKernel.test.ts",
    "src/testing/tests/started.test.ts",
    "src/testing/tests/streams.test.ts",
    "src/testing/tests/work.test.ts",
    "src/testing/tests/later.test.ts",
    "src/testing/tests/closure.test.ts",
    "src/plugins/database/tests/store.test.ts",
];

/** Suites about what happens once in a fresh process, which one worker keeping its modules across files would hide. */
export const freshProcess = [
    "src/testing/tests/outbox-default.test.ts",
];

/** Suites that open each database themselves, so they run once. */
export const eachDatabaseItself = [
    "src/plugins/database/tests/portable.test.ts",
    "src/plugins/database/tests/sql.test.ts",
];

/** Suites against a real Postgres server (`pnpm test:pg`, with KIT_PG_URL), where concurrency between connections shows. */
export const postgresServer = [
    "src/plugins/database/tests/workers.server.ts",
];

/** Suites about SQLite's own behaviour: its busy wait, its one connection, the layout before 9.0. */
export const sqliteOnly = [
    "src/plugins/database/tests/sqlite-concurrency.test.ts",
    "src/plugins/database/tests/sqlite-store.test.ts",
    "src/plugins/database/tests/sqlite-types.test.ts",
    "src/testing/tests/sqlite-leases.test.ts",
];

/** Store suites not yet moved to both databases. Empty before 9.0 ships. */
export const notYetOnPostgres = [];
