/** Suites run on SQLite and on Postgres. */
export declare const bothDialects: readonly string[];
/** Suites that open each database themselves, so they run once. */
export declare const eachDatabaseItself: readonly string[];
/** Suites against a real Postgres server. */
export declare const postgresServer: readonly string[];
/** Suites about SQLite's own behaviour. */
export declare const sqliteOnly: readonly string[];
/** Store suites not yet moved to both databases. */
export declare const notYetOnPostgres: readonly string[];
/** Suites about what happens once in a fresh process. */
export declare const freshProcess: readonly string[];
