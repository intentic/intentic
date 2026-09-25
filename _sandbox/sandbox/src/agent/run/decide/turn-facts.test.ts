import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { type CredentialGate, type Persona, type SandboxSettings, SandboxSettingsSchema } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../../../composition.js";
import { createCredentialGrants } from "../../../secrets/credential-grants.js";
import { conversationAfter, testConfig } from "../../../testing.js";
import type { TurnContext } from "../../providers/adapter.js";
import { base, budgetOn, context, memoryReading, servicesWith, turn } from "../turn/turn-plan.testing.js";
import { LANDING_CHECKS_NOTE_TITLE } from "../../../workspace/deps/mainline-note.js";
import { type AdmittedTurnFacts, gatherTurnFacts, type TurnFacts } from "./turn-facts.js";

// Which reads a turn pays for, named by the `turn.plan.*` span each is timed under: diagnostics read those names, and
// a read skipped for a fact the turn already carries must stay skipped. What the facts decide is turn-decision.test.ts's.

const admitted = (facts: TurnFacts): AdmittedTurnFacts => {
    if ("held" in facts) {
        throw new Error(`held: ${facts.held.message}`);
    }
    return facts;
};

const settingsOf = (settings: SandboxSettings): Services["sandboxSettings"] =>
    unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: async () => settings });

const conversationAt = (turns: number): Services["agents"] => unstubbed<Services["agents"]>("agents", { entry: () => conversationAfter(turns) });

const GIB = 1024 ** 3;

// Every seam but the memory gate's is left to name itself, so a read past the hold fails by that seam's name.
test("a held turn reads nothing past the memory gate", async () => {
    const services = unstubbed<Services>("services", { resources: budgetOn(memoryReading(16, 15), { waitDeadlineMs: 20 }) });

    expect(await gatherTurnFacts(services, turn({ unattended: true }), context)).toEqual({
        held: {
            message:
                "Sandbox memory is low: 15.0 GiB of 16.0 GiB used. This background work waited 1 minute for room and did not start: work people send gets the room first.",
            memory: { limitBytes: 16 * GIB, residentBytes: 15 * GIB, swapBytes: 0 },
        },
    });
});

// A card that sends every note but the one about checks after landing.
const QUIET: Persona = { id: "quiet", capabilities: [], briefing: { omit: ["checks"] } };

const resumed: TurnContext = { ...context, base: { ...base, spec: { ...base.spec, sessionId: "session-1" } } };
const routed: TurnContext = { ...context, settings: SandboxSettingsSchema.parse({}) };

test.each([
    [
        "the Claude Code loop, which asks its own deps server and loads its own skills",
        { agent: "claude" },
        context,
        {},
        [
            "turn.plan.settings",
            "turn.plan.window",
            "turn.plan.capabilities",
            "turn.plan.personas",
            "turn.plan.areas",
            "turn.plan.context",
            "turn.plan.repo-checks",
            "turn.plan.mainline",
        ],
    ],
    [
        "a turn whose settings the route already read",
        { agent: "claude" },
        routed,
        {},
        [
            "turn.plan.window",
            "turn.plan.capabilities",
            "turn.plan.personas",
            "turn.plan.areas",
            "turn.plan.context",
            "turn.plan.repo-checks",
            "turn.plan.mainline",
        ],
    ],
    [
        "native Codex, told of the tree's dependencies in prose",
        { agent: "codex" },
        context,
        {},
        [
            "turn.plan.settings",
            "turn.plan.window",
            "turn.plan.capabilities",
            "turn.plan.deps",
            "turn.plan.personas",
            "turn.plan.areas",
            "turn.plan.context",
            "turn.plan.repo-checks",
            "turn.plan.mainline",
        ],
    ],
    [
        "a resumed Codex session, which would throw the probe's answer away",
        { agent: "codex" },
        resumed,
        {},
        [
            "turn.plan.settings",
            "turn.plan.window",
            "turn.plan.capabilities",
            "turn.plan.personas",
            "turn.plan.areas",
            "turn.plan.context",
            "turn.plan.repo-checks",
            "turn.plan.mainline",
        ],
    ],
    [
        "OpenCode's opening turn, which is sent the skill catalogue",
        { agent: "grok" },
        context,
        {},
        [
            "turn.plan.settings",
            "turn.plan.window",
            "turn.plan.capabilities",
            "turn.plan.deps",
            "turn.plan.personas",
            "turn.plan.areas",
            "turn.plan.skills",
            "turn.plan.context",
            "turn.plan.repo-checks",
            "turn.plan.mainline",
        ],
    ],
    [
        "an OpenCode follow-up, whose session already carries the catalogue",
        { agent: "grok", conversationId: "c-grok" },
        context,
        { agents: conversationAt(2) },
        [
            "turn.plan.settings",
            "turn.plan.window",
            "turn.plan.capabilities",
            "turn.plan.deps",
            "turn.plan.personas",
            "turn.plan.areas",
            "turn.plan.context",
            "turn.plan.repo-checks",
            "turn.plan.mainline",
        ],
    ],
    [
        "a turn behind the retrieval flag with iq search on",
        { agent: "claude" },
        context,
        { config: { ...testConfig, iqTurnContext: true }, sandboxSettings: settingsOf(SandboxSettingsSchema.parse({ iqSearch: true })) },
        [
            "turn.plan.settings",
            "turn.plan.window",
            "turn.plan.capabilities",
            "turn.plan.personas",
            "turn.plan.areas",
            "turn.plan.context",
            "turn.plan.repo-checks",
            "turn.plan.turn-context",
            "turn.plan.mainline",
        ],
    ],
    [
        "the retrieval flag with iq search off",
        { agent: "claude" },
        context,
        { config: { ...testConfig, iqTurnContext: true } },
        [
            "turn.plan.settings",
            "turn.plan.window",
            "turn.plan.capabilities",
            "turn.plan.personas",
            "turn.plan.areas",
            "turn.plan.context",
            "turn.plan.repo-checks",
            "turn.plan.mainline",
        ],
    ],
    [
        "a card that drops the checks note, which is never read for it",
        { agent: "claude", actsAs: "quiet" },
        context,
        { personas: unstubbed<Services["personas"]>("personas", { list: async () => [QUIET] }) },
        [
            "turn.plan.settings",
            "turn.plan.window",
            "turn.plan.capabilities",
            "turn.plan.personas",
            "turn.plan.areas",
            "turn.plan.context",
            "turn.plan.repo-checks",
        ],
    ],
] as const)("the reads for %s", async (_case, input, turnContext, overrides, spans) => {
    const opened: string[] = [];
    const perf = unstubbed<Services["perf"]>("perf", {
        track: (op, _fields, run) => {
            opened.push(op);
            return run();
        },
    });

    await gatherTurnFacts(servicesWith({ ...overrides, perf }), turn(input), turnContext);

    expect(opened).toEqual([...spans]);
});

const gateOn = (subject: string): CredentialGate => ({ subject, kind: "capability", approvers: ["ada@example.com"], scope: "conversation" });

test("the releases are the ones held when the gates were read, not a store the decision could see move", async () => {
    const grants = createCredentialGrants();
    grants.grant("c-gated", "reddit-main", { approvedBy: "ada@example.com", at: 1 });
    const services = servicesWith({
        credentialGrants: grants,
        credentialGates: unstubbed<Services["credentialGates"]>("credentialGates", { list: async () => [gateOn("reddit-main"), gateOn("github")] }),
        agents: unstubbed<Services["agents"]>("agents", { entry: () => undefined }),
    });

    const facts = admitted(await gatherTurnFacts(services, turn({ conversationId: "c-gated" }), context));
    grants.forget("c-gated");

    expect(facts.releases.has("c-gated", "reddit-main")).toEqual({ approvedBy: "ada@example.com", at: 1 });
    expect(facts.releases.has("c-gated", "github")).toBeUndefined();
});

test("an approval policy that cannot be read withholds nothing, and says so", async () => {
    const warned: unknown[] = [];
    const services = servicesWith({
        credentialGates: unstubbed<Services["credentialGates"]>("credentialGates", {
            list: async () => {
                throw new Error("EACCES: the policy file");
            },
        }),
        logger: unstubbed<Services["logger"]>("logger", { debug: () => {}, warn: (...line: unknown[]) => warned.push(line[1]) }),
    });

    const facts = admitted(await gatherTurnFacts(services, turn(), context));

    expect(facts.gates).toEqual([]);
    expect(warned).toEqual(["credential gates: the approval policy could not be read, no capability is withheld this turn"]);
});

const IQ_PLUGIN_DIR = join(repoRoot(import.meta.url), "_search/iq/plugin");

// Read for a turn that is sent it, and for a measured conversation's turns that only stamp its cohort.
test.each([
    ["native Codex's opening turn, which is sent it", "codex", 0, true],
    ["the Claude Code loop, which loads the plugin instead", "claude", 0, false],
    ["the Claude Code loop in a measured conversation, which stamps its cohort", "claude", 0.5, true],
] as const)("the iq teaching is read for %s", async (_case, agent, holdout, read) => {
    const services = servicesWith({
        config: { ...testConfig, iqPluginDir: IQ_PLUGIN_DIR },
        sandboxSettings: settingsOf(SandboxSettingsSchema.parse({ iqSearch: true, iqSearchHoldout: holdout })),
        agents: unstubbed<Services["agents"]>("agents", { entry: () => undefined }),
    });

    const facts = admitted(await gatherTurnFacts(services, turn({ agent, conversationId: "c-iq" }), context));

    expect(facts.iqTeaching).toEqual(read ? { note: expect.stringContaining("## iq workspace search"), cohort: expect.any(String) } : undefined);
});

// Said on the opening message and again after a compaction summarizes it away (turn-premise.ts), as every standing note
// is; a turn in between is only told when the main tree's reds moved under it, which is mainline-note.test.ts's.
const FORK = { conversationId: "parent", keep: 2, files: "now" } as const;

test.each([
    ["a conversation's opening message", "c-open", undefined, undefined, true],
    ["a fork's opening message, whose parent's history already holds it", "c-fork", undefined, FORK, false],
    ["a follow-up", "c-follow", conversationAfter(3), undefined, false],
    ["the turn after a compaction", "c-compacted", conversationAfter(4, { compactedTurn: 3 }), undefined, true],
    ["a fork taken right after a compaction", "c-fork-compacted", conversationAfter(4, { compactedTurn: 3 }), FORK, true],
    ["a turn three past the compaction", "c-past", conversationAfter(6, { compactedTurn: 3 }), undefined, false],
] as const)("the checks-after-landing note is read for %s", async (_case, conversationId, entry, forkOf, sent) => {
    const services = servicesWith({ agents: unstubbed<Services["agents"]>("agents", { entry: () => entry }) });

    const facts = admitted(await gatherTurnFacts(services, turn({ conversationId, forkOf }), context));

    expect(facts.landingChecksNote?.title).toBe(sent ? LANDING_CHECKS_NOTE_TITLE : undefined);
});

// Codex and OpenCode run no check at their end any more than the Claude Code loop does, so none is told differently.
test.each(["claude", "codex", "grok"] as const)("%s is read the note on its opening message like every other runtime", async (agent) => {
    const services = servicesWith({ agents: unstubbed<Services["agents"]>("agents", { entry: () => undefined }) });

    const facts = admitted(await gatherTurnFacts(services, turn({ agent, conversationId: `c-${agent}` }), context));

    expect(facts.landingChecksNote?.text).toContain("Nothing checks your work when you finish");
});
