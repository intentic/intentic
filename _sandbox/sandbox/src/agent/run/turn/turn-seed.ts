import type { AgentTurn } from "@intentic/sandbox-contract";

// What a turn was, kept so a watch wake or a verify-nudge can continue it instead of starting fresh. Session is
// resolved at delivery time, never snapshotted; absent fields stay absent under exactOptionalPropertyTypes.
export type TurnSeed = Pick<
    AgentTurn,
    "agent" | "harness" | "account" | "model" | "effort" | "thinking" | "fast" | "actsAs" | "isolated" | "unattended" | "runRole"
>;

// Fields copied from the seed when present; `runRole` also carries through, absent if the turn had none.
const CARRIED = ["agent", "harness", "account", "model", "effort", "thinking", "fast", "actsAs", "runRole"] as const;

/** Turn fields to spread into the turn a wake or a nudge starts. */
export const seedFields = (seed: TurnSeed): TurnSeed => ({
    ...Object.fromEntries(CARRIED.flatMap((key) => (seed[key] === undefined ? [] : [[key, seed[key]] as const]))),
    // `isolated`/`unattended` read as `=== true`; carrying a false would assert placement never stated.
    ...(seed.isolated === true ? { isolated: true } : {}),
    ...(seed.unattended === true ? { unattended: true } : {}),
});
