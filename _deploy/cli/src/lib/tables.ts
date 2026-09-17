import { plural } from "@intentic/base/format";
import type { Step } from "@intentic/engine";
import { columns } from "./output.js";

// The blocks `plan`, `apply` and `destroy` show a person: a verdict per resource, then the counts and what to do
// about them. Here rather than in the commands because all three render the same rows, and because every word is
// asserted.

/** A resource by id and type: what an orphan, a pending delete and a teardown row all are. */
export interface Named {
    readonly id: string;
    readonly type: string;
}

const HEADER = ["ACTION", "RESOURCE", "TYPE"];

// Rows stay in the caller's order, which is dependency order for both plan (creates before what waits on them) and
// destroy (the reverse). The WHY column appears only when some row fills it, or the header labels empty space.
export const planTable = (steps: readonly Step[]): string[] => {
    if (steps.length === 0) {
        return ["The artifact declares no resources."];
    }
    const why = steps.some((step) => step.reason !== undefined);
    return columns([
        why ? [...HEADER, "WHY"] : HEADER,
        ...steps.map((step) => [step.action, step.id, step.type, ...(why ? [step.reason ?? ""] : [])]),
    ]);
};

/** One `action` for every row: `apply`'s pending deletes and `destroy`'s dry run both list a single verb. */
export const resourceTable = (action: string, resources: readonly Named[]): string[] =>
    columns([HEADER, ...resources.map((resource) => [action, resource.id, resource.type])]);

/** A resource `destroy` walks: id, type, and whether the artifact protects it from deletion. */
export interface Teardown extends Named {
    readonly protected: boolean;
}

// `destroy`'s dry run. The instruction is last because it is the only line with anything to do in it, and the last
// line is the one still on screen; the protected count is stated separately, since "4 resources" and "4 deleted" are
// different numbers whenever anything is protected.
export const teardownTable = (order: readonly Teardown[]): string[] => {
    if (order.length === 0) {
        return ["The artifact declares no resources: there is nothing to tear down."];
    }
    const doomed = order.filter((node) => !node.protected).length;
    const kept = order.length - doomed;
    return [
        ...columns([
            [...HEADER, "NOTE"],
            ...order.map((node) => (node.protected ? ["keep", node.id, node.type, "protected"] : ["delete", node.id, node.type, ""])),
        ]),
        "",
        ...(doomed === 0
            ? [`Every resource the artifact declares is protected: destroy has nothing to delete.`]
            : [
                  `Nothing was deleted${kept === 0 ? "" : `, and ${plural(kept, "protected resource")} never will be`}.`,
                  `\`intentic deploy destroy --yes\` tears down ${doomed === 1 ? "the resource" : `the ${doomed} resources`} above. This cannot be undone.`,
              ]),
    ];
};

// In the order a reader cares about them: what changes first, what does not last.
const ACTION_LABELS = [
    ["create", "to create"],
    ["update", "to update"],
    ["noop", "unchanged"],
] as const;

// The counts, and what to do about them. `noop` everywhere is the engine's success condition ("state reads true"), so
// it gets a sentence rather than leaving the reader to count rows and infer it. One action covering every resource is
// stated as "all …", since the total and that action's count are then the same number said twice.
const stepCounts = (steps: readonly Step[]): string[] => {
    if (steps.length === 0) {
        return [];
    }
    const total = plural(steps.length, "resource");
    const present = ACTION_LABELS.map(([action, label]) => ({ label, count: steps.filter((step) => step.action === action).length })).filter(
        (entry) => entry.count > 0,
    );
    if (present.length === 1 && present[0]?.label === "unchanged") {
        return [`${total}, all unchanged: state reads true, apply has nothing to do.`];
    }
    const counts =
        present.length === 1
            ? `${total}, all ${present[0]?.label}`
            : `${total}: ${present.map((entry) => `${entry.count} ${entry.label}`).join(", ")}`;
    return [`${counts}. Run \`intentic deploy apply\` to execute.`];
};

// Orphans are a second, unrelated verdict (live but undeclared) and get their own block: in one table with the steps
// they read as a fourth action, which is how the tab-separated version read.
const orphanBlock = (orphans: readonly Named[]): string[] => {
    if (orphans.length === 0) {
        return [];
    }
    const them = orphans.length === 1 ? "it" : "them";
    return [
        "",
        `${plural(orphans.length, "orphan")} on the host, not in the desired graph:`,
        ...columns(orphans.map((orphan) => [`  ${orphan.id}`, orphan.type])),
        `Delete ${them} with \`intentic deploy apply --yes\`, or declare ${them} to keep ${them}.`,
    ];
};

export const planSummary = (steps: readonly Step[], orphans: readonly Named[]): string[] => {
    const counts = stepCounts(steps);
    return [...(counts.length > 0 ? ["", ...counts] : []), ...orphanBlock(orphans)];
};
