import { type Capability, type CredentialGate, type Persona, PersonaPowersSchema, type Rule, SandboxSettingsSchema } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { createMemoryWarnings, type MemoryHeadroom, type TurnAdmission } from "../../../platform/resources/memory-admission.js";
import { createCredentialGrants } from "../../../secrets/credential-grants.js";
import { GATED_CREDENTIALS_TITLE } from "../../../secrets/credential-gating.js";
import type { FieldNotes } from "../../prompt/field-notes.js";
import { GUIDANCE_REVISION } from "../../prompt/guidance.js";
import { IQ_SEARCH_INSTRUCTION_TITLE } from "../../prompt/iq-search-instruction.js";
import { WORKSPACE_MAP_NOTE_TITLE } from "../../prompt/workspace-map.js";
import type { ChildSupervisor } from "../../subagents/children.js";
import { SPAWN_NOTE_TITLE } from "../../subagents/spawn-note.js";
import type { TurnContext } from "../../providers/adapter.js";
import { conversationExperimentArm } from "./experiments.js";
import { conversationAfter } from "../../../testing.js";
import { LANDING_CHECKS_NOTE_TITLE, landingChecksNote } from "../../../workspace/deps/mainline-note.js";
import { base, context, ROOT, turn } from "../turn/turn-plan.testing.js";
import { decideTurn, type TurnDecision } from "./turn-decision.js";
import type { AdmittedTurnFacts, TurnFacts } from "./turn-facts.js";

// decideTurn over facts stated as values: no services, no disk, no clock. Which reads a turn pays for is
// turn-facts.test.ts's subject, and that planTurn joins the two up is turn-plan.test.ts's.

// An unconfigured workspace: nothing installed, gated, declared or read, and the schema's own settings.
const FACTS: AdmittedTurnFacts = {
    root: ROOT,
    entry: undefined,
    settings: SandboxSettingsSchema.parse({}),
    repoChecks: [],
    declared: undefined,
    installed: [],
    setup: [],
    personas: [],
    areas: [],
    skillCatalogNote: undefined,
    contextNote: undefined,
    turnContext: undefined,
    gates: [],
    releases: createCredentialGrants(),
    iqTeaching: undefined,
    fieldNotes: undefined,
    personaPrompt: undefined,
    memoryNote: undefined,
    mapNote: undefined,
    landingChecksNote: undefined,
    sessionStore: `${ROOT}/sessions`,
};

// A refusal here is the test failing, said with the refusal's own words.
const decided = (facts: TurnFacts, input = turn(), turnContext: TurnContext = context): TurnDecision => {
    const decision = decideTurn(facts, input, turnContext);
    if (!decision.ok) {
        throw new Error(`refused: ${decision.message}`);
    }
    return decision;
};

const titles = (decision: TurnDecision): string[] => (decision.context.base.spec.notes ?? []).map((note) => note.title);

// The first of a run of ids whose arm under `salt` is `arm`, so a fixture names its arm rather than a lucky id.
const conversationIn = (salt: string, arm: boolean): string => {
    const id = Array.from({ length: 64 }, (_, index) => `conversation-${index}`).find((each) => conversationExperimentArm(salt, each, 0.5) === arm);
    if (id === undefined) {
        throw new Error(`no conversation draws ${String(arm)} under ${salt}`);
    }
    return id;
};

// the memory gate

const GIB = 1024 ** 3;
// 12 GiB resident and 7 swapped against a 16 GiB cap: short for a person and for background work alike.
const SHORT: MemoryHeadroom = { limitBytes: 16 * GIB, usedBytes: 19 * GIB, swapBytes: 7 * GIB, freeBytes: 0, stalledPercent: 0, oomKills: undefined };
const ROOMY: MemoryHeadroom = { limitBytes: 16 * GIB, usedBytes: 4 * GIB, swapBytes: 0, freeBytes: 12 * GIB, stalledPercent: 0, oomKills: undefined };

const factsAfter = (admission: TurnAdmission): TurnFacts => (admission.admit ? FACTS : { held: admission });

test.each([
    ["a person is held on the first press of a spell and let through on the next", SHORT, false, [false, true]],
    ["background work is held on every short reading, since nobody is there to be told", SHORT, true, [false, false]],
    ["a box with room holds nobody", ROOMY, false, [true, true]],
] as const)("the memory gate: %s", (_case, reading, unattended, expected) => {
    const spell = createMemoryWarnings();
    const presses = expected.map(() => decideTurn(factsAfter(spell.admit(reading, { unattended, actor: "ada@example.com", conversationId: undefined })), turn(), context).ok);
    expect(presses).toEqual([...expected]);
});

test("a held turn is refused with the reading behind it, and owes the log nothing", () => {
    const held = createMemoryWarnings().admit(SHORT, { unattended: false, actor: "ada@example.com", conversationId: undefined });
    if (held.admit) {
        throw new Error("the fixture's box is meant to be short");
    }

    expect(decideTurn({ held }, turn(), context)).toEqual({
        ok: false,
        code: "sandbox-memory-low",
        message: held.message,
        memory: { limitBytes: 16 * GIB, residentBytes: 12 * GIB, swapBytes: 7 * GIB },
        warnings: [],
        spawn: false,
    });
});

// who the turn acts as

const NPMJS: Capability = { id: "npmjs", kind: "browser", config: { platform: "npmjs" } };

test("a turn acting as a card this workspace lacks reaches no account and no tool, and the log names the card", () => {
    const decision = decided({ ...FACTS, installed: [NPMJS] }, turn({ actsAs: "ghost" }));

    expect(decision.warnings).toEqual([{ fields: { actsAs: "ghost" }, message: "persona: no such card, this turn reaches no account and no tools" }]);
    expect(decision.granted).toEqual([]);
    expect(decision.context.base.policy.disallowedTools).toEqual([
        "Read",
        "Glob",
        "Grep",
        "NotebookRead",
        "Edit",
        "Write",
        "NotebookEdit",
        "Bash",
        "BashOutput",
        "KillShell",
        "WebFetch",
        "WebSearch",
        "Agent",
        "Task",
        "Workflow",
        "Skill(npmjs)",
    ]);
    expect(decision.context.persona?.reason).toBe("unknown-persona");
});

test.each([
    ["no card named", undefined],
    ["a card the workspace holds", "writer"],
] as const)("%s owes the log nothing", (_case, actsAs) => {
    const writer: Persona = { id: "writer", capabilities: ["npmjs"], powers: PersonaPowersSchema.parse({}) };

    const decision = decided({ ...FACTS, installed: [NPMJS], personas: [writer] }, turn({ actsAs }));

    expect(decision.warnings).toEqual([]);
    expect(decision.granted).toEqual([NPMJS]);
});

// what the owner's gates withhold

const REDDIT: Capability = { id: "reddit-main", kind: "browser", config: { platform: "reddit" } };
const GITHUB: Capability = { id: "github", kind: "cli", config: { provider: "github" } };
const gateOn = (subject: string): CredentialGate => ({ subject, kind: "capability", approvers: ["ada@example.com"], scope: "conversation" });
const withEnv: TurnContext = { ...context, base: { ...base, tools: { ...base.tools, cliEnv: { TOKEN_GITHUB: "gho_secret", PATH: "/usr/bin" } } } };

test.each([
    ["with no release", undefined, false],
    ["released in this conversation", "c-gated", true],
    ["released in another conversation", "c-other", false],
] as const)("a gated account %s", (_case, releasedIn, mounted) => {
    const releases = createCredentialGrants();
    if (releasedIn !== undefined) {
        releases.grant(releasedIn, "reddit-main", { approvedBy: "ada@example.com", at: 1 });
    }

    const decision = decided({ ...FACTS, installed: [REDDIT], gates: [gateOn("reddit-main")], releases }, turn({ conversationId: "c-gated" }));

    expect(decision.granted).toEqual(mounted ? [REDDIT] : []);
    expect(decision.context.base.policy.disallowedTools).toEqual(mounted ? undefined : ["Skill(reddit-main)"]);
    // honoured's note, since an absence alone reads as an account that is not connected.
    expect(decision.context.base.spec.notes).toEqual(
        mounted
            ? []
            : [
                  {
                      title: GATED_CREDENTIALS_TITLE,
                      text: expect.stringContaining('- `reddit-main` needs approval from ada@example.com: `secrets request reddit-main --why "…"`'),
                  },
              ],
    );
});

test("a gated connector loses its variables from the shell and its skill, and nothing else in the environment", () => {
    const decision = decided({ ...FACTS, installed: [GITHUB], gates: [gateOn("github")] }, turn({ conversationId: "c-gated" }), withEnv);

    expect(decision.context.base.tools.cliEnv).toEqual({ PATH: "/usr/bin" });
    expect(decision.context.base.policy.disallowedTools).toEqual(["Skill(github)"]);
    expect(titles(decision)).toEqual([GATED_CREDENTIALS_TITLE]);
});

// the project map: an opening, non-fork message, and only in the treatment arm of a measured conversation

const MAP = "## Map of this project\n\nbilling/ takes the payments; mailer/ sends the receipts.";
const MAP_ON = SandboxSettingsSchema.parse({ workspaceMap: true });
const MAP_MEASURED = SandboxSettingsSchema.parse({ workspaceMap: true, workspaceMapHoldout: 0.5 });
const MAP_TREATED = conversationIn("workspace-map", true);
const MAP_CONTROL = conversationIn("workspace-map", false);
const LEAN: Persona = { id: "lean", capabilities: [], briefing: { omit: ["map"] } };
// A conversation cut from another, on its first turn.
const FORK = { conversationId: "parent", keep: 2, files: "now" } as const;

test.each([
    ["an opening turn with the map on and nothing measured", MAP_ON, { conversationId: undefined }, undefined, true, { mapChars: MAP.length }],
    [
        "the opening turn of a treated conversation",
        MAP_MEASURED,
        { conversationId: MAP_TREATED },
        undefined,
        true,
        { turnIndex: 0, mapArm: true, mapChars: MAP.length },
    ],
    ["the opening turn of a control conversation", MAP_MEASURED, { conversationId: MAP_CONTROL }, undefined, false, { turnIndex: 0, mapArm: false }],
    ["a fork's opening turn", MAP_MEASURED, { conversationId: MAP_TREATED, forkOf: FORK }, undefined, false, { turnIndex: 0, mapArm: true }],
    ["a follow-up, whose transcript already holds the map", MAP_MEASURED, { conversationId: MAP_TREATED }, 3, false, { turnIndex: 3, mapArm: true }],
    [
        "a card that drops the map, taken out of the experiment",
        MAP_MEASURED,
        { conversationId: MAP_TREATED, actsAs: "lean" },
        undefined,
        false,
        { turnIndex: 0 },
    ],
    [
        "a workspace with the map off",
        SandboxSettingsSchema.parse({ workspaceMapHoldout: 0.5 }),
        { conversationId: MAP_TREATED },
        undefined,
        false,
        { turnIndex: 0 },
    ],
] as const)("the map on %s", (_case, settings, input, turns, sent, experiments) => {
    const entry = turns === undefined ? undefined : conversationAfter(turns);

    const decision = decided({ ...FACTS, settings, entry, personas: [LEAN], mapNote: MAP }, turn(input));

    expect(titles(decision).includes(WORKSPACE_MAP_NOTE_TITLE)).toBe(sent);
    expect(decision.experiments).toEqual(experiments);
});

// what runs after the work lands: told to every runtime alike, isolated or not, whenever the facts carry the note (when a
// turn owes it is turn-facts.test.ts's), and never past a card that dropped it

// The note as gatherTurnFacts reads it for a turn that owes it, with the main tree green.
const LANDING_NOTE = landingChecksNote([], false);
const QUIET: Persona = { id: "quiet", capabilities: [], briefing: { omit: ["checks"] } };
const IN_WORKTREE: TurnContext = { ...context, localCwd: `${ROOT}-worktree`, effectiveCwd: `${ROOT}-worktree` };

test.each([
    ["the Claude Code loop on the main tree", "claude", context],
    ["the Claude Code loop in its own worktree", "claude", IN_WORKTREE],
    ["native Codex on the main tree", "codex", context],
    ["native Codex in its own worktree", "codex", IN_WORKTREE],
    ["OpenCode", "grok", context],
] as const)("the checks-after-landing note reaches %s", (_case, agent, turnContext) => {
    const decision = decided({ ...FACTS, landingChecksNote: LANDING_NOTE }, turn({ agent, conversationId: "c-checks" }), turnContext);

    expect(decision.context.base.spec.notes?.filter((note) => note.title === LANDING_CHECKS_NOTE_TITLE)).toEqual([LANDING_NOTE]);
});

test("a turn whose facts carry no checks note is told nothing about checks, whatever rules stand", () => {
    const declared: Rule = {
        id: "repo-check-root-0",
        label: "Lint the edit",
        moment: "file.edited",
        when: { repo: "root" },
        action: { kind: "command", command: "pnpm lint {file}", timeoutMs: 900_000 },
        enabled: true,
    };

    const decision = decided({ ...FACTS, repoChecks: [declared] }, turn({ agent: "codex" }), IN_WORKTREE);

    expect(decision.context.settings?.rules.map((rule) => rule.id)).toEqual(["repo-check-root-0"]);
    expect(titles(decision)).not.toContain(LANDING_CHECKS_NOTE_TITLE);
});

test("a card that drops the checks note never shows it, even where the facts carry one", () => {
    const decision = decided({ ...FACTS, personas: [QUIET], landingChecksNote: LANDING_NOTE }, turn({ actsAs: "quiet", conversationId: "c-quiet" }));

    expect(titles(decision)).not.toContain(LANDING_CHECKS_NOTE_TITLE);
});

// the iq teaching: runtimes with no plugin loader, on a conversation's opening turn

const TEACHING = { note: "## iq workspace search\n\nAsk iq before you grep.", cohort: "c0ffee" };
const SEARCH_ON = SandboxSettingsSchema.parse({ iqSearch: true });
const SEARCH_MEASURED = SandboxSettingsSchema.parse({ iqSearch: true, iqSearchHoldout: 0.5 });

test.each([
    ["native Codex on an opening turn", SEARCH_ON, "codex", "c-iq", undefined, true, { turnIndex: 0 }],
    ["OpenCode on an opening turn", SEARCH_ON, "grok", "c-iq", undefined, true, { turnIndex: 0 }],
    ["native Codex on a follow-up, which its session already carries", SEARCH_ON, "codex", "c-iq", conversationAfter(2), false, { turnIndex: 2 }],
    ["the Claude Code loop, which loads it as a plugin", SEARCH_ON, "claude", "c-iq", undefined, false, { turnIndex: 0 }],
    ["a workspace with search off", SandboxSettingsSchema.parse({}), "codex", "c-iq", undefined, false, { turnIndex: 0 }],
    [
        "a treated conversation, stamped with its cohort",
        SEARCH_MEASURED,
        "codex",
        conversationIn("iq-search", true),
        undefined,
        true,
        { turnIndex: 0, iqSearchArm: true, iqSearchCohort: "c0ffee" },
    ],
    [
        "a control conversation, stamped with the cohort it was withheld",
        SEARCH_MEASURED,
        "codex",
        conversationIn("iq-search", false),
        undefined,
        false,
        { turnIndex: 0, iqSearchArm: false, iqSearchCohort: "c0ffee" },
    ],
] as const)("the iq teaching on %s", (_case, settings, agent, conversationId, entry, sent, experiments) => {
    const decision = decided({ ...FACTS, settings, entry, iqTeaching: TEACHING }, turn({ agent, conversationId }));

    expect(titles(decision).includes(IQ_SEARCH_INSTRUCTION_TITLE)).toBe(sent);
    expect(decision.context.base.spec.notes?.find((note) => note.title === IQ_SEARCH_INSTRUCTION_TITLE)?.text).toBe(sent ? TEACHING.note : undefined);
    expect(decision.experiments).toEqual(experiments);
});

// the window: the last gate, measured on the prompt as it will be sent

const SMALL_WINDOW = { window: 16_384, onACard: true };
const withChildren: TurnContext = { ...context, children: unstubbed<ChildSupervisor>("children", {}) };

test("a window that cannot hold the loop refuses, and the log says how short it fell", () => {
    const decision = decideTurn({ ...FACTS, declared: SMALL_WINDOW }, turn({ agent: "endpoint/tiny", model: "llama" }), context);

    expect(decision).toMatchObject({ ok: false, code: "context-window-too-small", message: expect.stringContaining("16,384 tokens") });
    expect(decision.warnings).toEqual([
        {
            fields: { provider: "endpoint/tiny", model: "llama", window: 16_384, needed: expect.any(Number) },
            message: "context: the model's window cannot hold a turn of this loop, refused before sending",
        },
    ]);
});

// Decided before the window is measured, which is why the planner still arms the door on this refusal.
test("the spawn door is decided even for a turn the window then refuses", () => {
    expect(decideTurn({ ...FACTS, declared: SMALL_WINDOW }, turn({ agent: "endpoint/tiny", conversationId: "c-small" }), withChildren)).toMatchObject(
        {
            ok: false,
            code: "context-window-too-small",
            spawn: true,
        },
    );
});

test.each([
    ["a window that holds a full turn is left alone", { window: 131_072, onACard: true }, undefined],
    ["an unpublished window is never trimmed", undefined, undefined],
    [
        "a window under a full turn sheds this product's guidance instead of refusing",
        { window: 40_000, onACard: true },
        { guidance: true, base: false },
    ],
] as const)("the window: %s", (_case, declared, trim) => {
    const decision = decided({ ...FACTS, declared }, turn({ agent: "endpoint/tiny", model: "llama" }));

    expect(decision.context.base.spec.contextTrim).toEqual(trim);
    expect(decision.contextTrim?.trim).toEqual(trim === undefined ? undefined : { window: 40_000, base: false });
});

// the experiments' arms: one per salt, the same on every turn of a conversation

const BRIEF: FieldNotes = {
    text: "## Field notes for this sandbox\n\nThe box has 16 GiB.",
    chars: 52,
    revision: "rev-1",
    ranksSent: 1,
    ranksTotal: 1,
    writtenAt: 0,
};
const ALL_MEASURED = SandboxSettingsSchema.parse({
    iqSearch: true,
    iqSearchHoldout: 0.5,
    workspaceMap: true,
    workspaceMapHoldout: 0.5,
    fieldNotes: true,
    fieldNotesHoldout: 0.5,
});
const MEASURED_FACTS: AdmittedTurnFacts = { ...FACTS, settings: ALL_MEASURED, iqTeaching: TEACHING, mapNote: MAP, fieldNotes: BRIEF };

test.each(Array.from({ length: 8 }, (_, index) => `conversation-${index}`))("%s draws one arm per salt, the same on every turn", (conversationId) => {
    const search = conversationExperimentArm("iq-search", conversationId, 0.5);
    const map = conversationExperimentArm("workspace-map", conversationId, 0.5);
    const notes = conversationExperimentArm("field-notes", conversationId, 0.5);

    const first = decided(MEASURED_FACTS, turn({ conversationId }));

    expect(first.experiments).toEqual({
        turnIndex: 0,
        iqSearchArm: search,
        iqSearchCohort: TEACHING.cohort,
        mapArm: map,
        ...(map ? { mapChars: MAP.length } : {}),
        notesArm: notes,
        // What the prompt paid, so only on a turn that was sent the brief; the cohort on both arms, to pair them.
        ...(notes ? { notesChars: BRIEF.chars } : {}),
        notesCohort: BRIEF.revision,
    });
    expect(decided(MEASURED_FACTS, turn({ conversationId })).experiments).toEqual(first.experiments);
});

test("a turn with no conversation is in no experiment, and still stamps what its prompt paid", () => {
    expect(decided(MEASURED_FACTS).experiments).toEqual({ mapChars: MAP.length, notesChars: BRIEF.chars, notesCohort: BRIEF.revision });
});

// Whether the brief reached anything the turn sends: the system prompt, its append, or a note.
const briefSent = (decision: TurnDecision): boolean => {
    const { systemPrompt, systemAppend, notes } = decision.context.base.spec;
    return [systemPrompt, systemAppend, ...(notes ?? []).map((note) => note.text)].some((text) => text?.includes(BRIEF.text) === true);
};

test("a window too small for the field notes withholds them, so the ledger records no cost", () => {
    const facts = { ...FACTS, settings: SandboxSettingsSchema.parse({ fieldNotes: true }), fieldNotes: BRIEF };
    const decision = decided({ ...facts, declared: { window: 40_000, onACard: true } }, turn({ agent: "endpoint/tiny" }));

    expect(briefSent(decided(facts, turn({ agent: "endpoint/tiny" })))).toBe(true);
    expect(briefSent(decision)).toBe(false);
    expect(decision.experiments).toEqual({ notesCohort: BRIEF.revision });
});

// the guidance experiment: the arm is the short form, and a turn composed with neither form is no control turn

const GUIDANCE_MEASURED = SandboxSettingsSchema.parse({ leanGuidance: true, leanGuidanceHoldout: 0.5 });

test.each([true, false])("a conversation drawing the %s arm is composed with that form and stamped with it", (arm) => {
    const decision = decided({ ...FACTS, settings: GUIDANCE_MEASURED }, turn({ conversationId: conversationIn("lean-guidance", arm) }));

    expect(decision.context.base.spec.guidance).toBe(arm ? "lean" : "full");
    expect(decision.experiments).toEqual({ turnIndex: 0, guidanceArm: arm, guidanceCohort: GUIDANCE_REVISION });
});

test("the switch with no holdout sends the short form and measures nothing", () => {
    const decision = decided({ ...FACTS, settings: SandboxSettingsSchema.parse({ leanGuidance: true }) }, turn({ conversationId: "c-1" }));

    expect(decision.context.base.spec.guidance).toBe("lean");
    expect(decision.experiments).toEqual({ turnIndex: 0 });
});

test.each([
    ["a custom prompt", { ...FACTS, settings: { ...GUIDANCE_MEASURED, systemPromptMode: "custom", systemPrompt: "Own." } }],
    ["a window too small for guidance", { ...FACTS, settings: GUIDANCE_MEASURED, declared: { window: 40_000, onACard: true } }],
] as const)("%s sends neither form, so its conversation is stamped with no arm", (_case, facts) => {
    const decision = decided(facts, turn({ agent: "endpoint/tiny", conversationId: conversationIn("lean-guidance", false) }));

    expect(decision.experiments.guidanceArm).toBeUndefined();
    expect(decision.experiments.guidanceCohort).toBeUndefined();
});

// the spawn door: the delegate shelf and full agency, on a conversation with a supervisor handed down

test.each([
    ["an open turn in a conversation with a supervisor", undefined, withChildren, "c-spawn", true],
    ["no supervisor handed down", undefined, context, "c-spawn", false],
    ["no conversation to arm", undefined, withChildren, undefined, false],
    ["a card without the delegate shelf", { delegate: false }, withChildren, "c-spawn", false],
    ["a card without a shell", { shell: false }, withChildren, "c-spawn", false],
    ["a card that may only read", { files: "read" }, withChildren, "c-spawn", false],
    ["a card with every shelf", {}, withChildren, "c-spawn", true],
] as const)("the spawn door for %s", (_case, powers, turnContext, conversationId, spawn) => {
    const card: Persona = { id: "card", capabilities: [], powers: PersonaPowersSchema.parse(powers ?? {}) };

    const decision = decided(
        { ...FACTS, personas: [card] },
        turn({ actsAs: powers === undefined ? undefined : "card", conversationId }),
        turnContext,
    );

    expect(decision.spawn).toBe(spawn);
});

test.each([
    ["native Codex, whose only door is its shell", "codex", undefined, true],
    ["the Claude Code loop, which carries the tools in-prompt", "claude", undefined, false],
    ["Cursor, which does too", "cursor", undefined, false],
    ["a follow-up, whose session already carries the teaching", "codex", conversationAfter(2), false],
] as const)("the spawn teaching for %s", (_case, agent, entry, taught) => {
    const decision = decided({ ...FACTS, entry }, turn({ agent, conversationId: "c-spawn" }), withChildren);

    expect(decision.spawn).toBe(true);
    expect(titles(decision).includes(SPAWN_NOTE_TITLE)).toBe(taught);
});
