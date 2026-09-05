export { startTestKernel, TestTables, createCaller } from "./testing/startTestKernel";
export { findImportViolations } from "./testing/boundaries";
export { findMissingDocs, findOversizedDocs, findUndocumentedKeys, findUnexplainedPlugins } from "./testing/docs";
export { Project } from "./testing/project";
export { findUnusedFields } from "./testing/wiring";

export type { TestKernel, TestKernelOptions, OutboundCall, LogLine } from "./testing/startTestKernel";
export type { Caller, Outbound } from "./plugins/kernel/api";
export type { ImportEdge, ImportViolation } from "./testing/boundaries";
export type { OversizedDoc, UndocumentedKey } from "./testing/docs";
export type { ProjectCheckOptions, ProjectProblem } from "./testing/project";
export type { UnusedField } from "./testing/wiring";
