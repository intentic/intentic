import { describe, expect, it } from "vitest";
import { capabilitiesOf, limitationsOf } from "./agent-catalog.js";
import type { AgentCapabilities } from "./agent-runtimes.js";

/* THE CAPABILITY LEDGER, which claims in the record are backed by machinery, and which by prose.
 *
 * agent-catalog.test.ts asks two other questions: does every provider/harness pair HAVE a row, and does every
 * axis a record can lack have words for it. A row can pass both and still be a lie. The ability is declared,
 * the sentence renders in the picker's footer, and nothing anywhere behaves differently, so the day the
 * runtime gains the ability (or loses it), the declaration keeps its old value and the footer keeps telling the
 * user something that stopped being true. Over-promising is the direction that hurts: told a runtime can be
 * steered, someone types a mid-turn correction into a queue that does not exist.
 *
 * The record's header already states the rule: "a capability is listed here only if something READS it". This
 * is the rule with teeth. Every field is ENFORCED (a seam opens or closes on it, and the entry cites where) or
 * DESCRIPTIVE (it gates nothing; its whole job is that one sentence). `Record<keyof AgentCapabilities, …>`
 * makes the split exhaustive at COMPILE time: a field added to the interface without an entry here does not
 * typecheck, and neither does an entry for a field that no longer exists. There is no way to add an ability and
 * leave the question of what backs it unanswered.
 *
 * WHAT THIS DOES NOT DO, deliberately: prove an ENFORCED gate exists. Those gates live in the daemon and the
 * web, which sit ABOVE this package and must not be imported back into it. So an enforced entry's citation is a
 * comment a reader checks, and the honest reading is "someone verified this once", not "CI verifies it". The
 * descriptive half IS machine-checked below, because it can be: those claims reach the user through
 * `limitationsOf`, which is right here.
 *
 * Moving a field between the two sets belongs in the same change that adds or removes its gate. */

type Backing = "enforced" | "descriptive";

const LEDGER: Record<keyof AgentCapabilities, Backing> = {
    // adapter-registry.ts maps runtime → the adapter that serves the turn; getting it wrong runs the turn on
    // the wrong loop entirely. Also keys the daemon's per-runtime health probes (useSandboxVersion.ts).
    runtime: "enforced",
    // conversation.ts's `steerable`: the composer offers mid-turn injection only where there is a queue.
    steering: "enforced",
    // turn-plan.ts forwards `permissionMode` only under "modes" (bar plan); modesFor/clampMode build the
    // composer's mode list from it, so a plan-only runtime is offered two postures rather than four names.
    permissions: "enforced",
    // turn-plan.ts opens the tool seam on "full" and attaches the setup notice when it is anything less.
    mcp: "enforced",
    // turn-plan.ts drops `effort` unless the runtime takes it; ComposerEffort.vue renders no scale without it.
    effort: "enforced",
    // turn-plan.ts drops `fast` unless the loop can ask for it. The one axis with no sentence of its own: a
    // record alone cannot tell the truth about it (a translator-routed turn reads true and still cannot go
    // fast), so the user-facing answer comes from fastAllowed instead.
    fastMode: "enforced",
    // turn-plan.ts tells a "cwd" turn where its worktree is, because an absolute /work path still reaches the
    // shared checkout there. Under "namespace" the mount does it and the note would be noise.
    isolation: "enforced",
    /* system-prompt.ts composes a turn's standing instructions AGAINST this value: a replacement where one may
     * be sent, an addition where only that is possible, and the user-message door for the persona note where
     * there is no system seam at all, and each adapter reads the field the composition set (codex-agent.ts's
     * two config keys, grok-agent.ts's per-message `system`). It is also the one axis whose absence was the bug
     * that produced it: before the field existed, every runtime was composed for as though it were the Claude
     * Code loop, and five of the six silently dropped the owner's prompt. */
    instructions: "enforced",
    // turn-plan.ts reads this before an opening turn: a "prompt" runtime receives the generated catalogue as
    // a typed note, while a "native" runtime is left to its own loader so the same list never arrives twice.
    skillDiscovery: "enforced",
    // turn-plan.ts (honoured) plans the JS backend only where "js" is declared, so a runtime without it is
    // handed no `jsExecution` and mounts no Code tool: the same drop-what-you-can't-honour rule as `effort`.
    execution: "enforced",
    /* turn-plan.ts (honoured) carries this onto every request and guard/turn-gate.ts DERIVES the gate's shape
     * from it: "none" gets no consult and a permanently-set taint bit, "refuse-only" cannot park so a hold
     * refuses, the other two park on a card. So a row that lies about itself changes how its turns behave.
     * It also decides whether Codex is asked to raise approvals at all (codex-agent.ts threadOptions). */
    rulebook: "enforced",

    /* DESCRIPTIVE: true of the runtime, and nothing consults them. Each describes behaviour that is emergent
     * rather than gated: an agent that never emits `question` frames simply never asks, one that publishes no
     * commands leaves the `/` popover empty. Nothing has to switch off, which is why nothing does. That also
     * means the declaration and the behaviour are two independent facts, and only the reader below keeps them
     * from disagreeing in the one place a user can see. Wiring one up (hiding the terminal tab, skipping
     * auto-resume) moves it to ENFORCED: in the change that wires it. */
    questions: "descriptive",
    commands: "descriptive",
    terminals: "descriptive",
    recovery: "descriptive",
    /* DESCRIPTIVE, and the one entry here whose gap cannot be closed by wiring. Masking a stored credential in
     * what the model READS needs a seam that edits a tool result before the model sees it, and only the Claude
     * Code loop has one (a PostToolUse hook). Every other runtime runs its tools inside the VENDOR'S loop: the
     * model has read the result before the daemon sees any frame about it. So nothing consults this field, and
     * nothing can: it exists so limitationsOf can say out loud what is true, instead of letting an owner who
     * stored a credential assume it is hidden everywhere. Moving it to ENFORCED would take a runtime that
     * publishes a result-rewriting seam, not a change here. */
    secrets: "descriptive",
};

// The full ceiling: every ability real, so `limitationsOf` has nothing to say about it. Read from the catalog
// rather than written out, so this is the record the product actually ships.
const CEILING = capabilitiesOf("claude", "native");

const fieldsWhere = (backing: Backing): (keyof AgentCapabilities)[] =>
    (Object.keys(LEDGER) as (keyof AgentCapabilities)[]).filter((field) => LEDGER[field] === backing);

/* The compiler pins the ledger against the INTERFACE. This pins it against a live record, which is not the same
 * claim: an optional field, or one a record leaves off, typechecks and then is not there to gate anything. */
it("classifies exactly the fields a live record carries", () => {
    expect(Object.keys(LEDGER).toSorted()).toEqual(Object.keys(CEILING).toSorted());
});

/* A DESCRIPTIVE field earns its place by reaching the user, since by definition it does nothing else. Checked
 * per field rather than by counting sentences: an aggregate is satisfied by one axis contributing two lines
 * while another contributes none, which is exactly the case worth catching. Anything that survives here without
 * a sentence is decoration, and the fix is to delete the field or wire it up, not to add an exemption. */
describe("a descriptive claim reaches the user", () => {
    it("has something to disclose against: the ceiling discloses nothing", () => {
        expect(limitationsOf(CEILING)).toEqual([]);
    });

    /* What "lacking this axis" MEANS for a field that is not a boolean. A boolean diminishes to false; anything
     * else has to name its own floor here, because only the axis knows which of its values is the weak one.
     * Adding a non-boolean descriptive field without an entry fails below rather than silently testing nothing. */
    const DIMINISHED: Partial<Record<keyof AgentCapabilities, unknown>> = { secrets: "none" };

    it.each(fieldsWhere("descriptive"))("%s puts its own sentence in the picker when the runtime lacks it", (field) => {
        const boolean = typeof CEILING[field] === "boolean";
        // A boolean's floor is `false` and needs no entry; every other descriptive field has to name its own.
        // Asserted against the KEYS of DIMINISHED so the failure prints the floors that do exist, which is what
        // tells "this field was never added" apart from "this field was renamed and its entry left behind".
        expect(
            boolean ? [field] : Object.keys(DIMINISHED),
            `${field} is descriptive and not a boolean: add its weakest value to DIMINISHED above`,
        ).toContain(field);
        const floor = boolean ? false : DIMINISHED[field];

        const lacking: AgentCapabilities = { ...CEILING, [field]: floor };

        expect(limitationsOf(lacking)).toHaveLength(1);
    });
});

/* The ledger is a split, not a label: a set that swallowed everything would typecheck and prove nothing. Both
 * sides being occupied is what makes reading an entry informative, and if the descriptive side ever empties
 * because every axis got wired up, that is a real event, and deleting this file is the right response to it. */
it("is a real split: neither side is empty", () => {
    expect(fieldsWhere("enforced").length).toBeGreaterThan(0);
    expect(fieldsWhere("descriptive").length).toBeGreaterThan(0);
});
