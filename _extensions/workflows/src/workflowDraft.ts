import type { Workflow } from "@intentic/sandbox-contract";

// Detached copy of a workflow via JSON round-trip, not `structuredClone`: `initial` arrives as a Vue reactive proxy,
// and `structuredClone` throws `DataCloneError` on one. JSON is safe since a `Workflow` is already a wire document that
// survives this same round-trip on every save and load.
export const editableCopy = (workflow: Workflow): Workflow => JSON.parse(JSON.stringify(workflow)) as Workflow;
