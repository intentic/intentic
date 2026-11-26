import type { HostedPlanMachine, HostedPlanState } from "@intentic/api-contract";
import { HOSTED_TIER_IDS } from "@intentic/constants";

// WHERE A CLOUD SANDBOX'S PLAN IS GOING, read off the two fields the platform sends beside its tier (2026-11-26): a
// `change` waiting (a downgrade scheduled for the renewal date, or one due now) and the latest `migration` of its machine
// (the restart onto a bigger size that an upgrade pays for). Pure, so every surface that draws the plan (the sandbox's
// own card, Billing's rows, the change dialog) reads the same move, and so the plan state knows when to be read again.

/** The machine's resize steps still under way; `done`, `failed` and `rolledBack` have ended. */
const UNDER_WAY: ReadonlySet<string> = new Set([`planned`, `snapshotting`, `applying`, `verifying`]);

/** The three steps a resize walks after the payment, in order. */
export type MoveStep = `snapshot` | `resizing` | `starting`;

const STEP_OF: ReadonlyMap<string, MoveStep> = new Map([
    [`planned`, `snapshot`],
    [`snapshotting`, `snapshot`],
    [`applying`, `resizing`],
    [`verifying`, `starting`],
]);

export type PlanMove =
    | { readonly kind: `none` }
    /** A downgrade the owner scheduled: on `tier` from `at`, on the plan paid for until then. */
    | { readonly kind: `scheduled`; readonly tier: string; readonly at: string }
    /** The machine restarting onto `tier`'s size now, since `since`, at `step`. */
    | { readonly kind: `moving`; readonly tier: string; readonly since: string; readonly step: MoveStep }
    /** An upgrade paid for whose resize ended unfinished; the same press tries it again with no new charge. */
    | { readonly kind: `failed`; readonly tier: string; readonly error: string | undefined }
    /** A downgrade that is due, waiting for its machine to sleep before it is resized. */
    | { readonly kind: `waiting`; readonly tier: string };

/** A plan's place on the ladder, cheapest first; an id the ladder does not know ranks lowest. */
const RANKS: ReadonlyMap<string, number> = new Map(HOSTED_TIER_IDS.map((id, index) => [id, index]));
const planRank = (tier: string): number => RANKS.get(tier) ?? -1;

/** Whether `to` is a bigger plan than `from`, by the ladder's order. */
export const isUpgrade = (from: string, to: string): boolean => planRank(to) > planRank(from);

/** The move this machine's plan is making at `now`; `none` on a platform older than the two fields. */
export const planMove = (machine: Pick<HostedPlanMachine, `tier` | `change` | `migration`>, now: number): PlanMove => {
    const { change, migration } = machine;
    if (change !== undefined && Date.parse(change.at) > now) {
        return { kind: `scheduled`, tier: change.tier, at: change.at };
    }
    if (migration !== undefined && UNDER_WAY.has(migration.state)) {
        return { kind: `moving`, tier: migration.toTier, since: migration.startedAt, step: STEP_OF.get(migration.state) ?? `snapshot` };
    }
    if (change === undefined) {
        return { kind: `none` };
    }
    if (migration !== undefined && (migration.state === `failed` || migration.state === `rolledBack`)) {
        return { kind: `failed`, tier: change.tier, error: migration.error };
    }
    // Due and not begun: an upgrade is paid for and about to restart; a downgrade waits for its machine to sleep.
    return isUpgrade(machine.tier, change.tier) ? { kind: `moving`, tier: change.tier, since: change.at, step: `snapshot` } : { kind: `waiting`, tier: change.tier };
};

/** Whether any of the account's machines is restarting onto a new size now: the plan is read again every few seconds meanwhile. */
export const planMoving = (state: HostedPlanState | undefined, now: number): boolean =>
    (state?.hosted?.machines ?? []).some((machine) => planMove(machine, now).kind === `moving`);
