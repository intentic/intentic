import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { defineStep, type StepContext } from "../state-steps.js";

// The flat `.intentic/` every release before 2026-08-19 kept (commit 4f8f73552), regrouped into config, records,
// local, identity and secrets. That change shipped a script to run by hand, which nothing ran: a sandbox updated past
// it read its settings, personas, skills and automations as absent, and looked reset. This step does what the script
// did, plus the renames made around it (identities → personas, bridge-tokens → control-tokens, drafts → approvals,
// attachments and acceptance reports into artifacts), so such a sandbox comes up with everything it had.
// Small owner-maintained files are copied, so a rollback to a flat build still finds them; trees and ledgers are
// renamed, instant on one volume and put back by the journal on a rollback. Caches and scratch are left to regrow.
// Where the grouped address already holds something (the owner set things up again after the "reset"), that wins and
// the flat copy stays where it is; a directory present at both gets the flat entries it lacks.

type Mode = "copy" | "rename";

interface Placement {
    // The flat name directly under the state dir, and where it belongs now, both relative to the state dir.
    readonly flat: string;
    readonly grouped: string;
    readonly mode: Mode;
}

const placed = (group: string, mode: Mode, names: readonly string[]): Placement[] => names.map((flat) => ({ flat, grouped: `${group}/${flat}`, mode }));

// In the order they apply: a tree before anything that lands inside it (artifacts before attachments).
const PLACEMENTS: readonly Placement[] = [
    ...placed("config", "copy", [
        "automations.json",
        "capabilities.json",
        "capability-dismissals.json",
        "docs",
        "environment.custom.Dockerfile",
        "environment.d",
        "environment.Dockerfile",
        "extension-enablement.json",
        "extension-settings.json",
        "extension-update-policy.json",
        "loop-designs.json",
        "personas",
        "personas.json",
        "settings.json",
        "skills",
        "templates.json",
        "workflows.json",
        "workspace-extensions",
    ]),
    { flat: "drafts", grouped: "config/approvals", mode: "copy" },
    { flat: "identities.json", grouped: "config/personas.json", mode: "copy" },
    ...placed("records", "rename", [
        "approvals",
        "artifacts",
        "automation-runs.json",
        "chores",
        "extension-updates.json",
        "extension-usage.json",
        "loops.json",
        "plugins",
        "secret-uses.json",
        "sessions",
        "thread-sessions.json",
        "verify.json",
        "webchat-installs.json",
        "workflow-runs.json",
    ]),
    { flat: "attachments", grouped: "records/artifacts/attachments", mode: "rename" },
    { flat: "acceptance", grouped: "records/artifacts/acceptance", mode: "rename" },
    { flat: "loops", grouped: "records/artifacts/loops", mode: "rename" },
    // What is worth keeping of the local group: logins, extension checkouts, the stamps. Caches and scratch regrow.
    ...placed("local", "rename", ["browser", "environment.approved.Dockerfile", "extensions", "newest-run.json", "rule-firings.json", "runtime", "verify"]),
    ...placed("identity", "copy", ["control-tokens.json", "members.json", "owner.json", "workspace.json"]),
    { flat: "bridge-tokens.json", grouped: "identity/control-tokens.json", mode: "copy" },
    { flat: "auth", grouped: "secrets/auth", mode: "rename" },
    { flat: "ci.json", grouped: "secrets/ci.json", mode: "copy" },
];

interface Planned {
    readonly copies: Map<string, string>;
    readonly renames: Map<string, string>;
    readonly changes: string[];
}

// One placement: the whole entry when the grouped address is free; for two directories, each flat child the grouped
// one lacks. A file already at its grouped address stays as it is.
const place = async (context: StepContext, state: string, placement: Placement, planned: Planned): Promise<void> => {
    const flat = join(state, placement.flat);
    const grouped = join(state, placement.grouped);
    const flatKind = await context.kind(flat);
    if (flatKind === undefined) {
        return;
    }
    const target = placement.mode === "copy" ? planned.copies : planned.renames;
    const groupedKind = await context.kind(grouped);
    if (groupedKind === undefined) {
        target.set(flat, grouped);
        planned.changes.push(`${placement.mode === "copy" ? "copies" : "moves"} ${placement.flat} to ${placement.grouped}`);
        return;
    }
    if (flatKind !== "directory" || groupedKind !== "directory") {
        return;
    }
    const present = new Set(await context.list(grouped));
    const missing = (await context.list(flat)).filter((name) => !present.has(name));
    for (const name of missing) {
        target.set(join(flat, name), join(grouped, name));
    }
    if (missing.length > 0) {
        planned.changes.push(`${placement.mode === "copy" ? "copies" : "moves"} ${missing.length} entries of ${placement.flat} into ${placement.grouped}`);
    }
};

export const stateRegroupStep = defineStep({
    id: "state-dir-regroup",
    describe: "brings a state dir from before the 2026-08-19 regroup into its groups",
    phase: "layout",
    plan: async (context) => {
        const state = join(context.roots.workspace, STATE_DIR);
        const planned: Planned = { copies: new Map(), renames: new Map(), changes: [] };
        for (const placement of PLACEMENTS) {
            await place(context, state, placement, planned);
        }
        return planned.changes.length === 0 ? undefined : { changes: planned.changes, writes: new Map(), copies: planned.copies, renames: planned.renames };
    },
});
