import { describe, expect, it } from "vitest";
import { capabilitiesOf, limitationsOf } from "./agent-catalog.js";
import type { AgentCapabilities } from "./agent-runtimes.js";

// Whether a capability claim is backed by an enforcement seam or merely descriptive prose reaching the user through
// limitationsOf; the split must stay exhaustive against AgentCapabilities.

type Backing = "enforced" | "descriptive";

const LEDGER: Record<keyof AgentCapabilities, Backing> = {
    // adapter-registry.ts maps this runtime to its serving adapter; also keys per-runtime health probes.
    runtime: "enforced",
    // conversation.ts's `steerable`: the composer offers mid-turn injection only where there is a queue.
    steering: "enforced",
    // turn-plan.ts forwards permissionMode only under "modes"; the composer's mode list is built from it.
    permissions: "enforced",
    // turn-plan.ts opens the tool seam on "full"; anything less gets the setup notice instead.
    mcp: "enforced",
    // turn-plan.ts drops effort unless the runtime takes it; ComposerEffort.vue renders no scale without it.
    effort: "enforced",
    // turn-plan.ts drops fast unless the loop can request it; fastAllowed, not this field, is the real answer.
    fastMode: "enforced",
    // turn-plan.ts tells a "cwd" turn its worktree path; under "namespace" the mount makes that unnecessary.
    isolation: "enforced",
    // system-prompt.ts composes standing instructions against this: replace, append, or a user-message note.
    instructions: "enforced",
    // turn-plan.ts notes the catalogue only for "prompt"; "native" runtimes use their own loader instead.
    skillDiscovery: "enforced",
    // turn-plan.ts plans jsExecution only where "js" is declared; without it no Code tool is mounted.
    execution: "enforced",
    // turn-plan.ts carries this on every request; guard/turn-gate.ts derives the gate's shape from it:
    // - none: no consult, taint bit stays permanently set
    // - refuse-only: a hold refuses instead of parking
    // - other values: park on a card
    rulebook: "enforced",

    // Descriptive: true of the runtime but nothing consults these; wiring one up moves it to enforced.
    questions: "descriptive",
    commands: "descriptive",
    terminals: "descriptive",
    recovery: "descriptive",
    // descriptive: only the Claude Code loop can mask a secret before the model reads it, via its PostToolUse hook.
    secrets: "descriptive",
};

// Every ability true, read live from the catalog: the ceiling limitationsOf has nothing to disclose against.
const CEILING = capabilitiesOf("claude", "native");

const fieldsWhere = (backing: Backing): (keyof AgentCapabilities)[] =>
    (Object.keys(LEDGER) as (keyof AgentCapabilities)[]).filter((field) => LEDGER[field] === backing);

it("classifies exactly the fields a live record carries", () => {
    expect(Object.keys(LEDGER).toSorted()).toEqual(Object.keys(CEILING).toSorted());
});

// Checked per field rather than by an aggregate count, so one field silently contributing nothing still fails.
describe("a descriptive claim reaches the user", () => {
    it("has something to disclose against: the ceiling discloses nothing", () => {
        expect(limitationsOf(CEILING)).toEqual([]);
    });

    // A boolean field's floor is false; every other descriptive field must name its own weak value here.
    const DIMINISHED: Partial<Record<keyof AgentCapabilities, unknown>> = { secrets: "none" };

    it.each(fieldsWhere("descriptive"))("%s puts its own sentence in the picker when the runtime lacks it", (field) => {
        const boolean = typeof CEILING[field] === "boolean";
        // A boolean's floor is false and needs no entry here; every other descriptive field must have one or this
        // fails.
        expect(
            boolean ? [field] : Object.keys(DIMINISHED),
            `${field} is descriptive and not a boolean: add its weakest value to DIMINISHED above`,
        ).toContain(field);
        const floor = boolean ? false : DIMINISHED[field];

        const lacking: AgentCapabilities = { ...CEILING, [field]: floor };

        expect(limitationsOf(lacking)).toHaveLength(1);
    });
});

it("is a real split: neither side is empty", () => {
    expect(fieldsWhere("enforced").length).toBeGreaterThan(0);
    expect(fieldsWhere("descriptive").length).toBeGreaterThan(0);
});
