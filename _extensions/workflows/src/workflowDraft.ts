import type { Workflow } from "@intentic/sandbox-contract";

/* AN EDITABLE COPY OF A SAVED WORKFLOW — the designer's own draft, detached from whatever it was handed.
 *
 * WHY THIS IS NOT `structuredClone`. It was, and that is what took the whole feature down: `initial` reaches
 * the designer as a Vue REACTIVE PROXY on every path into it — out of the list's query data when you press
 * edit, out of the parent's ref when you press New or pick a template — and `structuredClone` does not clone
 * through a proxy, it throws `DataCloneError`. The throw happened inside `setup()`, so the dialog did not
 * render at all: every door into the designer was a crash, which is the one bug shape that looks like the
 * feature itself is broken rather than one control in it.
 *
 * WHY A JSON ROUND-TRIP IS THE RIGHT ANSWER AND NOT A RETREAT. A Workflow is a wire document — a zod-defined
 * shape that is POSTed as JSON on every save and parsed back as JSON on every load — so a value that could not
 * survive this trip could never have been saved or loaded either. There is nothing here for a structured clone
 * to preserve that JSON drops. And unlike `toRaw`, it cannot be defeated by a proxy nested somewhere in the
 * graph, which matters precisely because the caller has no way to know how deeply Vue wrapped what it holds.
 */
export const editableCopy = (workflow: Workflow): Workflow => JSON.parse(JSON.stringify(workflow)) as Workflow;
