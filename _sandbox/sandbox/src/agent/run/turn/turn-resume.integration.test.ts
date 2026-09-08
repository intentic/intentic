import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    type AgentEvent,
    type AgentTurn,
    type ParkedCard,
    type Persona,
    RESUME_NOTES,
    type SandboxSettings,
    SandboxSettingsSchema,
    type TranscriptRow,
    withResumeNote,
} from "@intentic/sandbox-contract";
import { expect, test, vi } from "vitest";
import type { PersistedAgent } from "../../../agents/registry/agents-store.js";
import { fileHeldWakesStore } from "../../../automations/held-wakes-store.js";
import { fileAutomationsStore } from "../../../automations/automations-store.js";
import type { WakeFn } from "../../../automations/scheduler.js";
import type { Services } from "../../../composition.js";
import { unstubbed } from "@intentic/testing";
import { SETTLES } from "@intentic/testing/vitest";
import type { TranscriptAgent } from "../../../sessions/agent-transcript.js";
import { testMintedSlices } from "../../../harness/route-services.testing.js";
import { automationConfig } from "../../../harness/route-stores.testing.js";
import { fileTranscriptRecord } from "../../../sessions/transcript-record.js";
import { fileSandboxSettingsStore } from "../../../settings/settings-store.js";
import { resolveRequest } from "../../tools/agent-requests.js";
import { stopTurn } from "../../anchors/agent-steering.js";
import { OUTAGE_MAX_ATTEMPTS, recordProviderFailure, recordProviderSuccess } from "../../providers/provider-health.js";
import { fileTurnJournal, type JournalledTurn } from "./turn-journal.js";
import { turnRunOf } from "./turn-runs.js";
import {
    clearPendingResume,
    createTurnResumeScheduler,
    fireLimitResume,
    pendingOutageFailure,
    recordAuthFailure,
    recordLimitFailure,
    recordOutageFailure,
    resumeInterruptedTurns,
    startConversationTurn,
} from "./turn-resume.js";

// `takes` answers each abandon attempt (false: the turn is still unwinding); `armed`/`limitArmed` are per-conversation
// overrides for outage/limit resume, a missing id follows the sandbox default.
const fakeServices = (
    root: string,
    abandoned: string[] = [],
    takes: () => boolean = () => true,
    armed: ReadonlyMap<string, boolean> = new Map(),
    limitArmed: ReadonlyMap<string, boolean> = new Map(),
): Services => {
    const record = fileTranscriptRecord(join(root, "transcripts"));
    return unstubbed<Services>("services", {
        sandboxSettings: fileSandboxSettingsStore(join(root, "settings.json")),
        // Read as data by run-role health, so it has to be a real seam: the helpers below spread this object, and a
        // spread keeps only own keys, dropping unstubbed's throwing proxy. Empty ledger: no rung has a failing streak.
        usage: unstubbed<Services["usage"]>("usage", { turns: async () => [] }),
        agents: unstubbed<Services["agents"]>("agents", {
            abandonResume: async (id: string) => {
                abandoned.push(id);
                return takes();
            },
            entry: (id: string) =>
                armed.has(id) || limitArmed.has(id)
                    ? ({
                          id,
                          ...(armed.has(id) ? { resumeAfterOutage: armed.get(id) } : {}),
                          ...(limitArmed.has(id) ? { resumeAfterLimit: limitArmed.get(id) } : {}),
                      } as PersistedAgent)
                    : undefined,
        }),
        // No device subscribed.
        pushSender: unstubbed<Services["pushSender"]>("pushSender", { notifyIfAway: async () => ({ delivered: 0, failed: 0 }) }),
        logger: unstubbed<Services["logger"]>("logger", { info: () => {}, warn: () => {}, error: () => {} }),
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        transcripts: unstubbed<Services["transcripts"]>("transcripts", {
            append: (agent: TranscriptAgent, messages: readonly TranscriptRow[]) => record.append(agent.id, messages),
            // Real record, not stubbed, so this suite reads transcripts in the same order the daemon does.
            count: (agent: TranscriptAgent) => record.count(agent.id),
        }),
    });
};

const fakeWake = (prompts: string[], events: AgentEvent[] = [{ kind: "done" }]): WakeFn =>
    async function* (_services, input) {
        prompts.push(input.prompt);
        yield* events;
    };

// Waits for a fire's detached run to finish; its wake lands after tick() returns, one I/O round-trip later.
const settle = async (conversationId: string): Promise<void> => {
    await turnRunOf(conversationId)?.waitUntilFinished();
};

test("a started turn records its settled transcript, whatever provider ran it", async () => {
    const root = mkdtempSync(join(tmpdir(), "turn-resume-"));
    const record = fileTranscriptRecord(join(root, "transcripts"));
    const started = await startConversationTurn(fakeServices(root), fakeWake([], [{ kind: "delta", text: "shipped" }, { kind: "done" }]), {
        prompt: "ship it",
        conversationId: "tr-record",
        agent: "codex",
        harness: "native",
    });
    expect(started).toEqual(expect.any(Object));
    await vi.waitFor(async () => expect(await record.read("tr-record")).toHaveLength(2), SETTLES);
    expect(await record.read("tr-record")).toEqual([
        { role: "user", text: "ship it", sentAt: expect.any(Number) },
        { role: "assistant", text: "shipped" },
    ]);
});

// `connected` names which providers are reachable, ordered (first entry is the head of the list); `routed` is the
// cheapest fake for `harnessReadyProviders`.
const routed = (provider: string, connected: readonly string[]): { name: string; label: string }[] =>
    connected.includes(provider) ? [{ name: "acct", label: "Account" }] : [];

const withProviders = (services: Services, connected: readonly string[]): Services => ({
    ...services,
    config: unstubbed<Services["config"]>("config", {
        translator: { url: "http://translator.test", token: "tok" },
        claudeCodeOauthToken: "",
        anthropicApiKey: "",
    }),
    cliProxy: unstubbed<Services["cliProxy"]>("cliProxy", {
        accounts: async () => ({
            codex: routed("codex", connected),
            grok: routed("grok", connected),
            kimi: routed("kimi", connected),
            gemini: routed("gemini", connected),
        }),
    }),
    claudeStore: unstubbed<Services["claudeStore"]>("claudeStore", {
        list: async () => (connected.includes("claude") ? [{ id: "acct", label: "Claude", connectedAt: 0 }] : []),
    }),
    // Cursor answers from a stored key, not the translator's map, so it can't ride `routed` like the others.
    cursorStore: unstubbed<Services["cursorStore"]>("cursorStore", {
        credentials: async () => (connected.includes("cursor") ? [{ id: "acct", apiKey: "key", connectedAt: 0 }] : []),
    }),
    // No model endpoints configured.
    capabilities: unstubbed<Services["capabilities"]>("capabilities", { list: async () => [] }),
    // Present with nobody signed in: the sweep iterates every provider module, so a missing slice throws.
    minted: testMintedSlices(),
});

// Shared role id for every agent-run test below; what's under test is the fill, so any real role name works.
const ROLE = "pipeline-fix" as const;

const ranWith = async (
    settings: Partial<SandboxSettings>,
    turn: AgentTurn & { conversationId: string },
    connected: readonly string[] = ["claude", "codex", "gemini"],
): Promise<AgentTurn> => {
    const services = withProviders(fakeServices(mkdtempSync(join(tmpdir(), "agent-run-model-"))), connected);
    await services.sandboxSettings.set({ ...SandboxSettingsSchema.parse({}), ...settings });
    const seen: AgentTurn[] = [];
    await startConversationTurn(
        services,
        async function* (_services, input) {
            seen.push(input);
            yield { kind: "done" };
        },
        turn,
    );
    await settle(turn.conversationId);
    return seen[0]!;
};

test("an unattended turn takes the agent-run model, provider and effort", async () => {
    const ran = await ranWith(
        { modelRoles: { [ROLE]: [{ provider: "codex", model: "gpt-5.6", effort: "high" }] } },
        { prompt: "fix CI", conversationId: "ar-fill", unattended: true, runRole: ROLE },
    );
    expect(ran).toMatchObject({ agent: "codex", model: "gpt-5.6", effort: "high" });
});

test("every knob the pin carries rides onto the turn, and the ones it doesn't stay absent", async () => {
    const ran = await ranWith(
        { modelRoles: { [ROLE]: [{ provider: "codex", model: "gpt-5.6", effort: "xhigh", thinking: true, harness: "claude-code" }] } },
        { prompt: "fix CI", conversationId: "ar-knobs", unattended: true, runRole: ROLE },
    );
    expect(ran).toMatchObject({ agent: "codex", model: "gpt-5.6", effort: "xhigh", thinking: true, harness: "claude-code" });
    expect(ran.fast).toBeUndefined();
});

test("a knob the turn already carries is not overwritten by the pin's", async () => {
    const ran = await ranWith(
        { modelRoles: { [ROLE]: [{ provider: "codex", model: "gpt-5.6", effort: "low" }] } },
        { prompt: "fix CI", conversationId: "ar-knob-kept", unattended: true, runRole: ROLE, effort: "max" },
    );
    expect(ran).toMatchObject({ agent: "codex", model: "gpt-5.6", effort: "max" });
});

test("the head of the list wins while its account is connected", async () => {
    const ran = await ranWith(
        {
            modelRoles: {
                [ROLE]: [
                    { provider: "codex", model: "gpt-5.6" },
                    { provider: "claude", model: "claude-opus-4-5" },
                ],
            },
        },
        { prompt: "fix CI", conversationId: "ar-head", unattended: true, runRole: ROLE },
    );
    expect(ran).toMatchObject({ agent: "codex", model: "gpt-5.6" });
});

test("a disconnected head is stepped over, and the entry that answers brings its own knobs", async () => {
    const ran = await ranWith(
        {
            modelRoles: {
                [ROLE]: [
                    { provider: "codex", model: "gpt-5.6", effort: "low" },
                    { provider: "claude", model: "claude-opus-4-5", effort: "max" },
                ],
            },
        },
        { prompt: "fix CI", conversationId: "ar-fallback", unattended: true, runRole: ROLE },
        ["claude"],
    );
    expect(ran).toMatchObject({ agent: "claude", model: "claude-opus-4-5", effort: "max" });
});

test("a list with nothing reachable left leaves the turn unset: it does not reach for a connected account", async () => {
    const ran = await ranWith(
        { modelRoles: { [ROLE]: [{ provider: "codex", model: "gpt-5.6" }] } },
        { prompt: "fix CI", conversationId: "ar-none", unattended: true, runRole: ROLE },
        ["claude", "gemini"],
    );
    expect(ran.model).toBeUndefined();
    expect(ran.agent).toBeUndefined();
});

test("an unattended turn that names its own model keeps it", async () => {
    const ran = await ranWith(
        { modelRoles: { [ROLE]: [{ provider: "codex", model: "gpt-5.6" }] } },
        { prompt: "walk the story", conversationId: "ar-explicit", unattended: true, runRole: ROLE, agent: "claude", model: "claude-opus-4-5" },
    );
    expect(ran).toMatchObject({ agent: "claude", model: "claude-opus-4-5" });
});

// Injects a persona store the base fixture lacks; a turn that names no persona never reaches it.
const withPersonas = (services: Services, cards: readonly Persona[]): Services => ({
    ...services,
    personas: unstubbed<Services["personas"]>("personas", { get: async (id) => cards.find((card) => card.id === id) }),
});

const ranAs = async (cards: readonly Persona[], settings: Partial<SandboxSettings>, turn: AgentTurn & { conversationId: string }): Promise<AgentTurn> => {
    const services = withPersonas(withProviders(fakeServices(mkdtempSync(join(tmpdir(), "agent-run-model-"))), ["claude", "codex", "gemini"]), cards);
    await services.sandboxSettings.set({ ...SandboxSettingsSchema.parse({}), ...settings });
    const seen: AgentTurn[] = [];
    await startConversationTurn(
        services,
        async function* (_services, input) {
            seen.push(input);
            yield { kind: "done" };
        },
        turn,
    );
    await settle(turn.conversationId);
    return seen[0]!;
};

test("the persona's own ladder outranks the role's list, and brings its knobs", async () => {
    const ran = await ranAs(
        [{ id: "backend", capabilities: [], models: [{ provider: "claude", model: "claude-opus-4-5", effort: "max" }] }],
        { modelRoles: { [ROLE]: [{ provider: "codex", model: "gpt-5.6", effort: "low" }] } },
        { prompt: "fix CI", conversationId: "ar-persona", unattended: true, runRole: ROLE, actsAs: "backend" },
    );
    expect(ran).toMatchObject({ agent: "claude", model: "claude-opus-4-5", effort: "max" });
});

test("a persona with no ladder, or none reachable, leaves the question to the role", async () => {
    const roles = { modelRoles: { [ROLE]: [{ provider: "codex", model: "gpt-5.6" }] } };
    const silent = await ranAs([{ id: "quiet", capabilities: [] }], roles, { prompt: "fix CI", conversationId: "ar-persona-silent", unattended: true, runRole: ROLE, actsAs: "quiet" });
    expect(silent).toMatchObject({ agent: "codex", model: "gpt-5.6" });
    // Kimi isn't connected in this fixture.
    const unreachable = await ranAs([{ id: "far", capabilities: [], models: [{ provider: "kimi", model: "k2" }] }], roles, {
        prompt: "fix CI",
        conversationId: "ar-persona-far",
        unattended: true,
        runRole: ROLE,
        actsAs: "far",
    });
    expect(unreachable).toMatchObject({ agent: "codex", model: "gpt-5.6" });
    // A persona nobody has behaves like an empty ladder.
    const missing = await ranAs([], roles, { prompt: "fix CI", conversationId: "ar-persona-missing", unattended: true, runRole: ROLE, actsAs: "gone" });
    expect(missing).toMatchObject({ agent: "codex", model: "gpt-5.6" });
});

test("a turn that names its own model keeps it over the persona's ladder too", async () => {
    const ran = await ranAs(
        [{ id: "backend", capabilities: [], models: [{ provider: "claude", model: "claude-opus-4-5" }] }],
        {},
        { prompt: "fix CI", conversationId: "ar-persona-explicit", unattended: true, runRole: ROLE, actsAs: "backend", agent: "codex", model: "gpt-5.6" },
    );
    expect(ran).toMatchObject({ agent: "codex", model: "gpt-5.6" });
});

test("a turn nobody flagged unattended is left alone", async () => {
    // The flag, not a missing model, gates this: an unloaded chat catalog also sends no model.
    const ran = await ranWith({ modelRoles: { [ROLE]: [{ provider: "codex", model: "gpt-5.6" }] } }, { prompt: "hello", conversationId: "ar-chat" });
    expect(ran.model).toBeUndefined();
    expect(ran.agent).toBeUndefined();
});

test("an empty agent-run list leaves the turn unset rather than inventing one", async () => {
    const ran = await ranWith({ modelRoles: { [ROLE]: [] } }, { prompt: "fix CI", conversationId: "ar-unpinned", unattended: true, runRole: ROLE });
    expect(ran.model).toBeUndefined();
});

// A token rotation retires every in-flight turn's snapshotted credential at once, failing them with `401 OAuth access
// token has been revoked`; the fix is an automatic re-mint and re-run.

// Represents the store after rotation already succeeded: it holds the successor token, so resume adopts it without
// refreshing again.
const fakeStore = (stored: { accessToken: string; revokedAt?: number }): Services["claudeStore"] =>
    unstubbed<Services["claudeStore"]>("claudeStore", {
        read: async () => ({ id: "acct", label: "Claude", connectedAt: 0, refreshToken: "rt", ...stored }),
        write: async () => {},
        clear: async () => {},
        list: async () => [],
        withRefreshLock: async (_id, act) => act(),
        logger: unstubbed<Services["logger"]>("logger", { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
    });

// A store that fails outright (endpoint unreachable, timeout, disk write refused): the question is never answered,
// unlike a revoked account's clear no.
const brokenStore = (): Services["claudeStore"] =>
    unstubbed<Services["claudeStore"]>("claudeStore", {
        read: async () => {
            throw new Error("claude token endpoint unreachable");
        },
        write: async () => {},
        clear: async () => {},
        list: async () => [],
        withRefreshLock: async (_id, act) => act(),
        logger: unstubbed<Services["logger"]>("logger", { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
    });

const authServices = (root: string, claudeStore: Services["claudeStore"], abandoned: string[] = [], takes: () => boolean = () => true): Services =>
    unstubbed<Services>("services", { ...fakeServices(root, abandoned, takes), claudeStore });

test("a turn the API refused mid-flight is re-minted and re-run on the next pass", async () => {
    const services = authServices(mkdtempSync(join(tmpdir(), "turn-resume-")), fakeStore({ accessToken: "tok-2" }));
    const prompts: string[] = [];
    recordAuthFailure({ input: { prompt: "finish the report", conversationId: "auth-1", isolated: true }, account: "acct", refusedToken: "tok-1" });
    await createTurnResumeScheduler(services, fakeWake(prompts)).tick();
    await settle("auth-1");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("finish the report");
    expect(prompts[0]).toMatch(/renew/i);
});

test("no resume when the credential is genuinely dead, the error frame's reconnect prompt is the real fix", async () => {
    // revokedAt marks it: rotate answers undefined for an already-revoked account.
    const abandoned: string[] = [];
    const services = authServices(mkdtempSync(join(tmpdir(), "turn-resume-")), fakeStore({ accessToken: "tok-1", revokedAt: 1 }), abandoned);
    const prompts: string[] = [];
    recordAuthFailure({ input: { prompt: "finish the report", conversationId: "auth-2", isolated: true }, account: "acct", refusedToken: "tok-1" });
    await createTurnResumeScheduler(services, fakeWake(prompts)).tick();
    expect(prompts).toHaveLength(0);
    expect(abandoned).toEqual(["auth-2"]);
});

test("a resume that is itself refused is not resumed again: a dead credential must not respawn forever", async () => {
    const services = authServices(mkdtempSync(join(tmpdir(), "turn-resume-")), fakeStore({ accessToken: "tok-2" }));
    const prompts: string[] = [];
    // The recorded prompt must match exactly what a fired resume builds, or the loop guard won't recognise it.
    recordAuthFailure({
        input: {
            prompt: withResumeNote("finish the report", RESUME_NOTES.auth),
            conversationId: "auth-3",
            isolated: true,
        },
        account: "acct",
        refusedToken: "tok-1",
    });
    await createTurnResumeScheduler(services, fakeWake(prompts)).tick();
    expect(prompts).toHaveLength(0);
});

test("the next turn on the conversation supersedes a pending auth resume", async () => {
    const services = authServices(mkdtempSync(join(tmpdir(), "turn-resume-")), fakeStore({ accessToken: "tok-2" }));
    const prompts: string[] = [];
    recordAuthFailure({ input: { prompt: "finish the report", conversationId: "auth-4", isolated: true }, account: "acct", refusedToken: "tok-1" });
    clearPendingResume("auth-4");
    await createTurnResumeScheduler(services, fakeWake(prompts)).tick();
    expect(prompts).toHaveLength(0);
});

test("a re-mint that cannot be attempted keeps its place, then gives the card up once the minute is out", async () => {
    const abandoned: string[] = [];
    const services = authServices(mkdtempSync(join(tmpdir(), "turn-resume-")), brokenStore(), abandoned);
    const prompts: string[] = [];
    const scheduler = createTurnResumeScheduler(services, fakeWake(prompts));
    recordAuthFailure(
        { input: { prompt: "finish the report", conversationId: "auth-5", isolated: true }, account: "acct", refusedToken: "tok-1" },
        1_000,
    );
    await scheduler.tick(1_000);
    expect(prompts).toHaveLength(0);
    expect(abandoned).toEqual([]);
    await scheduler.tick(30_000);
    expect(abandoned).toEqual([]);
    await scheduler.tick(61_002);
    expect(abandoned).toEqual(["auth-5"]);
    // Idempotent: a later tick must not abandon it again.
    await scheduler.tick(90_000);
    expect(abandoned).toEqual(["auth-5"]);
    expect(prompts).toHaveLength(0);
});

test("an abandon lost to a turn still unwinding is made good on the next pass", async () => {
    const abandoned: string[] = [];
    let unwound = false;
    const services = authServices(
        mkdtempSync(join(tmpdir(), "turn-resume-")),
        fakeStore({ accessToken: "tok-1", revokedAt: 1 }),
        abandoned,
        () => unwound,
    );
    const prompts: string[] = [];
    const scheduler = createTurnResumeScheduler(services, fakeWake(prompts));
    recordAuthFailure(
        { input: { prompt: "finish the report", conversationId: "auth-6", isolated: true }, account: "acct", refusedToken: "tok-1" },
        1_000,
    );
    await scheduler.tick(1_000);
    expect(abandoned).toEqual(["auth-6"]);
    unwound = true;
    await scheduler.tick(2_000);
    expect(abandoned).toEqual(["auth-6", "auth-6"]);
    // Consumed once landed; a further tick doesn't re-abandon.
    await scheduler.tick(3_000);
    expect(abandoned).toEqual(["auth-6", "auth-6"]);
    expect(prompts).toHaveLength(0);
});

// The breaker's wait lives in provider-health.ts; this module only picks which stranded turn spends it. Each test uses
// its own provider name since the breaker is process-wide.

const OUT_NOW = 5_000_000;

const outage = (conversationId: string, provider: string, extra: Record<string, unknown> = {}) => ({
    input: { prompt: "finish the report", conversationId, isolated: true },
    provider,
    ...extra,
});

// resumeAfterOutage is the sandbox default; armed is the per-conversation override that takes precedence.
const outageServices = async (
    root: string,
    resumeAfterOutage = true,
    abandoned: string[] = [],
    armed: ReadonlyMap<string, boolean> = new Map(),
): Promise<Services> => {
    const services = fakeServices(root, abandoned, () => true, armed);
    const settings = await services.sandboxSettings.get();
    await services.sandboxSettings.set({ ...settings, resumeAfterOutage });
    return services;
};

test("a stranded turn resumes once the provider's wait elapses, under a note saying why", async () => {
    const services = await outageServices(mkdtempSync(join(tmpdir(), "turn-resume-")));
    const { retryAt } = recordProviderFailure("out-fire", OUT_NOW);
    recordOutageFailure(outage("out-1", "out-fire"), OUT_NOW);
    const prompts: string[] = [];
    const scheduler = createTurnResumeScheduler(services, fakeWake(prompts));

    await scheduler.tick(retryAt - 1);
    await settle("out-1");
    expect(prompts).toEqual([]);

    await scheduler.tick(retryAt);
    await settle("out-1");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("finish the report");
    expect(prompts[0]).toMatch(/unavailable|outage/i);
    expect(pendingOutageFailure("out-1")).toBeUndefined();
});

test("an outage costs ONE turn per window however many conversations are stranded on it", async () => {
    const services = await outageServices(mkdtempSync(join(tmpdir(), "turn-resume-")));
    const { retryAt } = recordProviderFailure("out-herd", OUT_NOW);
    for (const id of ["herd-1", "herd-2", "herd-3", "herd-4"]) {
        recordOutageFailure(outage(id, "out-herd"), OUT_NOW);
    }
    const prompts: string[] = [];
    await createTurnResumeScheduler(services, fakeWake(prompts)).tick(retryAt);
    await settle("herd-1");

    // Firing moves the breaker's clock, so the other three are refused within this same pass.
    expect(prompts).toHaveLength(1);
    expect(pendingOutageFailure("herd-1")).toBeUndefined();
    expect(pendingOutageFailure("herd-2")).toEqual(expect.any(Object));
    expect(pendingOutageFailure("herd-4")).toEqual(expect.any(Object));
    for (const id of ["herd-2", "herd-3", "herd-4"]) {
        clearPendingResume(id);
    }
});

test("evidence that the provider is back releases the stranded set without waiting out the backoff", async () => {
    const services = await outageServices(mkdtempSync(join(tmpdir(), "turn-resume-")));
    recordProviderFailure("out-back", OUT_NOW);
    recordOutageFailure(outage("back-1", "out-back"), OUT_NOW);
    const prompts: string[] = [];
    const scheduler = createTurnResumeScheduler(services, fakeWake(prompts));
    await scheduler.tick(OUT_NOW);
    await settle("back-1");
    expect(prompts).toEqual([]);

    recordProviderSuccess("out-back");
    await scheduler.tick(OUT_NOW + 1);
    await settle("back-1");
    expect(prompts).toHaveLength(1);
});

test("with the toggle off the turn is remembered, not resumed: turning it on arms that same turn", async () => {
    const services = await outageServices(mkdtempSync(join(tmpdir(), "turn-resume-")), false);
    const { retryAt } = recordProviderFailure("out-toggle", OUT_NOW);
    recordOutageFailure(outage("toggle-1", "out-toggle"), OUT_NOW);
    const prompts: string[] = [];
    const scheduler = createTurnResumeScheduler(services, fakeWake(prompts));
    await scheduler.tick(retryAt);
    await settle("toggle-1");
    expect(prompts).toEqual([]);
    expect(pendingOutageFailure("toggle-1")).toEqual(expect.any(Object));

    const settings = await services.sandboxSettings.get();
    await services.sandboxSettings.set({ ...settings, resumeAfterOutage: true });
    await scheduler.tick(retryAt);
    await settle("toggle-1");
    expect(prompts).toHaveLength(1);
});

test("a conversation armed on its own resumes while the sandbox default leaves the rest alone", async () => {
    const services = await outageServices(mkdtempSync(join(tmpdir(), "turn-resume-")), false, [], new Map([["own-armed", true]]));
    const { retryAt } = recordProviderFailure("out-own", OUT_NOW);
    recordOutageFailure(outage("own-armed", "out-own"), OUT_NOW);
    recordOutageFailure(outage("own-quiet", "out-own"), OUT_NOW + 1);
    const prompts: string[] = [];
    const scheduler = createTurnResumeScheduler(services, fakeWake(prompts));

    await scheduler.tick(retryAt);
    await settle("own-armed");
    expect(prompts).toHaveLength(1);
    // Remembered without ever spending the breaker's window.
    expect(pendingOutageFailure("own-quiet")).toEqual(expect.any(Object));
    // Process-wide map: an uncleared entry here would leak into the next test's pass.
    clearPendingResume("own-quiet");
});

test("a conversation that opted out stays stopped even though the sandbox default resumes", async () => {
    const services = await outageServices(mkdtempSync(join(tmpdir(), "turn-resume-")), true, [], new Map([["own-off", false]]));
    const { retryAt } = recordProviderFailure("out-opt", OUT_NOW);
    recordOutageFailure(outage("own-off", "out-opt"), OUT_NOW);
    const prompts: string[] = [];
    const scheduler = createTurnResumeScheduler(services, fakeWake(prompts));

    await scheduler.tick(retryAt);
    await settle("own-off");
    expect(prompts).toEqual([]);
    expect(pendingOutageFailure("own-off")).toEqual(expect.any(Object));
    clearPendingResume("own-off");
});

test("a stranded turn nobody resumed within the hour is dropped rather than sprung back to life", async () => {
    const abandoned: string[] = [];
    const services = await outageServices(mkdtempSync(join(tmpdir(), "turn-resume-")), true, abandoned);
    recordOutageFailure(outage("stale-1", "out-stale"), OUT_NOW - 61 * 60_000);
    const prompts: string[] = [];
    await createTurnResumeScheduler(services, fakeWake(prompts)).tick(OUT_NOW);
    expect(prompts).toEqual([]);
    expect(pendingOutageFailure("stale-1")).toBeUndefined();
    expect(abandoned).toEqual(["stale-1"]);
});

test("once the attempt budget is spent the failure stands: the retrying is finite by design", async () => {
    const services = await outageServices(mkdtempSync(join(tmpdir(), "turn-resume-")));
    const prompts: string[] = [];
    const scheduler = createTurnResumeScheduler(services, fakeWake(prompts));
    let now = OUT_NOW;
    // Each iteration: a window releases one attempt, the attempt fails again, and the failure re-records the turn.
    for (let i = 0; i < OUTAGE_MAX_ATTEMPTS + 2; i += 1) {
        const { retryAt } = recordProviderFailure("out-spent", now);
        recordOutageFailure(outage("spent-1", "out-spent"), now);
        now = retryAt;
        await scheduler.tick(now);
        // Settles to avoid racing the next window's resume under the one-turn-per-conversation rule.
        await settle("spent-1");
    }
    expect(prompts).toHaveLength(OUTAGE_MAX_ATTEMPTS);
    clearPendingResume("spent-1");
});

test("the next turn on the conversation supersedes a pending outage resume", async () => {
    const services = await outageServices(mkdtempSync(join(tmpdir(), "turn-resume-")));
    const { retryAt } = recordProviderFailure("out-super", OUT_NOW);
    recordOutageFailure(outage("super-1", "out-super"), OUT_NOW);
    clearPendingResume("super-1");
    const prompts: string[] = [];
    await createTurnResumeScheduler(services, fakeWake(prompts)).tick(retryAt);
    expect(prompts).toEqual([]);
});

test("one provider's outage never gates a conversation on another", async () => {
    const services = await outageServices(mkdtempSync(join(tmpdir(), "turn-resume-")));
    recordProviderFailure("out-claude", OUT_NOW);
    recordOutageFailure(outage("iso-claude", "out-claude"), OUT_NOW);
    recordOutageFailure(outage("iso-codex", "out-codex"), OUT_NOW);
    const prompts: string[] = [];
    await createTurnResumeScheduler(services, fakeWake(prompts)).tick(OUT_NOW);
    await settle("iso-codex");
    expect(prompts).toHaveLength(1);
    expect(pendingOutageFailure("iso-codex")).toBeUndefined();
    expect(pendingOutageFailure("iso-claude")).toEqual(expect.any(Object));
    clearPendingResume("iso-claude");
});

// Boot pass over the turn journal: every surviving entry is a turn or fire cut off by the daemon dying; each is
// consumed exactly once.

// Real journal on a temp dir. autoResumeOnRestart is opt-in and off by default, so a test expecting a re-run must set
// it explicitly.
const journalServices = async (root: string, autoResumeOnRestart = true): Promise<Services> => {
    const services = unstubbed<Services>("services", {
        ...fakeServices(root),
        turnJournal: fileTurnJournal(join(root, "turns")),
        automations: fileAutomationsStore(join(root, "automations.json"), join(root, "automation-runs.json")),
        heldWakes: fileHeldWakesStore(join(root, "approvals")),
        activity: { append: async () => {}, list: async () => [] },
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
    });
    const settings = await services.sandboxSettings.get();
    await services.sandboxSettings.set({ ...settings, autoResumeOnRestart });
    return services;
};

const journalled = (conversationId: string, extra: Partial<JournalledTurn> = {}): JournalledTurn => ({
    kind: "turn",
    turn: { prompt: "finish the report", conversationId, isolated: true },
    startedAt: 10_000,
    attempts: 0,
    ...extra,
});

// Just inside the six-hour staleness cap, measured from the entry's startedAt.
const BOOT_AT = 10_000 + 60_000;

test("an interrupted chat turn is re-run under the restart note, on the session holding its partial work", async () => {
    const services = await journalServices(mkdtempSync(join(tmpdir(), "restart-")));
    await services.turnJournal.recordTurn(journalled("rs-1", { sessionId: "s-partial" }));
    const prompts: string[] = [];
    const inputs: AgentTurn[] = [];
    const capture: WakeFn = async function* (_services, input) {
        prompts.push(input.prompt);
        inputs.push(input);
        yield { kind: "done" };
    };
    await resumeInterruptedTurns(services, capture, BOOT_AT);

    await vi.waitFor(() => expect(prompts).toHaveLength(1), SETTLES);
    expect(prompts[0]).toMatch(/restarted/i);
    expect(prompts[0]).toContain("finish the report");
    expect(inputs[0]?.sessionId).toBe("s-partial");
});

test("the attempt is spent on disk BEFORE the turn restarts, so a turn that kills the daemon cannot loop the boot", async () => {
    const root = mkdtempSync(join(tmpdir(), "restart-"));
    const real = fileTurnJournal(join(root, "turns"));
    await real.recordTurn(journalled("rs-spend"));
    // The order log avoids a race with the resumed run's own fire-and-forget journal write.
    const order: string[] = [];
    const services = unstubbed<Services>("services", {
        ...(await journalServices(root)),
        turnJournal: {
            ...real,
            recordTurn: async (entry: JournalledTurn) => {
                order.push(`record:attempts=${entry.attempts}`);
                await real.recordTurn(entry);
            },
        },
    });
    const wake: WakeFn = async function* () {
        order.push(`wake`);
        yield { kind: "done" };
    };
    await resumeInterruptedTurns(services, wake, BOOT_AT);
    await vi.waitFor(() => expect(order).toContain(`wake`), SETTLES);

    expect(order[0]).toBe(`record:attempts=1`);
    expect(order.indexOf(`record:attempts=1`)).toBeLessThan(order.indexOf(`wake`));
});

test("an entry whose attempt is already spent is dropped WITHOUT running: no boot loop on a turn that kills the daemon", async () => {
    const services = await journalServices(mkdtempSync(join(tmpdir(), "restart-")));
    await services.turnJournal.recordTurn(journalled("rs-spent", { attempts: 1 }));
    const prompts: string[] = [];
    await resumeInterruptedTurns(services, fakeWake(prompts), BOOT_AT);
    expect(prompts).toEqual([]);
    expect(await services.turnJournal.list()).toEqual([]);
});

test("an entry older than the staleness cap is dropped: a sandbox off for the weekend must not wake mid-thought", async () => {
    const services = await journalServices(mkdtempSync(join(tmpdir(), "restart-")));
    await services.turnJournal.recordTurn(journalled("rs-stale"));
    const prompts: string[] = [];
    await resumeInterruptedTurns(services, fakeWake(prompts), 10_000 + 7 * 60 * 60_000);
    expect(prompts).toEqual([]);
    expect(await services.turnJournal.list()).toEqual([]);
});

test("autoResumeOnRestart off records the interruption and re-runs nothing", async () => {
    // Off is the SandboxSettingsSchema default: the journal drains and records the interruption, but nothing runs.
    const root = mkdtempSync(join(tmpdir(), "restart-"));
    const services = await journalServices(root, false);

    await services.turnJournal.recordTurn(journalled("rs-off"));
    await services.automations.upsert(automationConfig("nightly", { prompt: "sweep" }));
    await services.turnJournal.recordFire({
        kind: "automation",
        automationId: "nightly",
        conversationId: "a-nightly-1",
        startedAt: 10_000,
        attempts: 0,
    });

    const prompts: string[] = [];
    await resumeInterruptedTurns(services, fakeWake(prompts), BOOT_AT);
    expect(prompts).toEqual([]);
    expect(await services.turnJournal.list()).toEqual([]);
    // Written to the transcript with an explicit notice before the journal entry drains.
    expect(await fileTranscriptRecord(join(root, "transcripts")).read("rs-off")).toEqual([
        { role: "user", text: "finish the report", sentAt: 10_000 },
        {
            role: "notice",
            text: "The sandbox restarted before this turn finished. Send another message to continue from the saved worktree.",
        },
    ]);
    expect((await services.automations.get("nightly"))?.runs[0]).toMatchObject({ outcome: "interrupted" });
});

// The transcript record is appended per settled turn, so an interrupted turn recorded nothing; boot reads the session's
// streamed tail before consuming its journal entry, the last moment it can.
test("an interrupted turn is recorded from the work it did, not from its prompt alone", async () => {
    const root = mkdtempSync(join(tmpdir(), "restart-"));
    const base = await journalServices(root, false);
    const services = unstubbed<Services>("services", {
        ...base,
        sessions: unstubbed<Services["sessions"]>("sessions", {
            ...base.sessions,
            readTail: async (_dir: string, id: string) => [
                { role: "user", text: "finish the report" },
                { role: "assistant", text: `two chapters in, on ${id}` },
            ],
        }),
    });
    await services.turnJournal.recordTurn(journalled("rs-work", { sessionId: "s-partial" }));

    await resumeInterruptedTurns(services, fakeWake([]), BOOT_AT);

    expect(await fileTranscriptRecord(join(root, "transcripts")).read("rs-work")).toEqual([
        // sentAt is the turn's own start time, not the provider's, matching every other user row.
        { role: "user", text: "finish the report", sentAt: 10_000 },
        // Reads the session the journal recorded; the registry entry may predate it if the daemon died early.
        { role: "assistant", text: "two chapters in, on s-partial" },
        {
            role: "notice",
            text: "The sandbox restarted before this turn finished. Send another message to continue from the saved worktree.",
        },
    ]);
});

test("a failed interrupted-transcript append retains the journal for a later boot", async () => {
    const root = mkdtempSync(join(tmpdir(), "restart-"));
    const base = await journalServices(root, false);
    const services = unstubbed<Services>("services", {
        ...base,
        transcripts: unstubbed<Services["transcripts"]>("transcripts", {
            ...base.transcripts,
            append: async () => {
                throw new Error("disk unavailable");
            },
        }),
    });
    await services.turnJournal.recordTurn(journalled("rs-retry"));

    await resumeInterruptedTurns(services, fakeWake([]), BOOT_AT);

    expect((await services.turnJournal.list()).map((entry) => entry.kind === "turn" && entry.turn.conversationId)).toEqual(["rs-retry"]);
});

test("an interrupted fire records `interrupted`, then re-fires with its snapshotted payload through the guard", async () => {
    const services = await journalServices(mkdtempSync(join(tmpdir(), "restart-")));
    // The guard passes only because the payload reached it: proof the re-fire runs the real gate, not around it.
    await services.automations.upsert(
        automationConfig("hook", { trigger: { kind: "event" }, guard: `test "$AUTOMATION_PAYLOAD" = "ping"`, prompt: "handle it" }),
    );
    const origin = { automationId: "hook", provider: "webhook" };
    await services.turnJournal.recordFire({
        kind: "automation",
        automationId: "hook",
        conversationId: "a-hook-1",
        payload: "ping",
        origin,
        startedAt: 10_000,
        attempts: 0,
    });

    const prompts: string[] = [];
    await resumeInterruptedTurns(services, fakeWake(prompts), BOOT_AT);
    await vi.waitFor(async () => expect((await services.automations.get("hook"))?.runs).toHaveLength(2), SETTLES);

    const runs = (await services.automations.get("hook"))?.runs ?? [];
    // runs sorts newest first: the completed re-fire sits above the interrupted record it replaced.
    expect(runs[0]?.outcome).toBe("completed");
    expect(runs[1]?.outcome).toBe("interrupted");
    expect(runs.map((run) => run.conversationId)).toEqual(["a-hook-1", "a-hook-1"]);
    expect(prompts).toEqual(["handle it\n\n--- Event payload ---\nping"]);
});

test("a re-fire skips the approval gate: the wake was already past it when the daemon died", async () => {
    const services = await journalServices(mkdtempSync(join(tmpdir(), "restart-")));
    await services.automations.upsert(automationConfig("gated", { prompt: "sweep", requireApproval: true }));
    await services.turnJournal.recordFire({ kind: "automation", automationId: "gated", conversationId: "a-gated-1", startedAt: 10_000, attempts: 0 });

    const prompts: string[] = [];
    await resumeInterruptedTurns(services, fakeWake(prompts), BOOT_AT);
    await vi.waitFor(() => expect(prompts).toEqual(["sweep"]), SETTLES);
    // Re-holding it would ask a question the owner has already answered.
    expect(await services.heldWakes.list()).toEqual([]);
});

test("an entry for an automation since deleted or disabled is consumed, not left to invent a run on every boot", async () => {
    const services = await journalServices(mkdtempSync(join(tmpdir(), "restart-")));
    await services.automations.upsert(automationConfig("off", { prompt: "sweep", enabled: false }));
    await services.turnJournal.recordFire({ kind: "automation", automationId: "off", conversationId: "a-off-1", startedAt: 10_000, attempts: 0 });
    await services.turnJournal.recordFire({
        kind: "automation",
        automationId: "deleted",
        conversationId: "a-deleted-1",
        startedAt: 10_000,
        attempts: 0,
    });

    const prompts: string[] = [];
    await resumeInterruptedTurns(services, fakeWake(prompts), BOOT_AT);
    expect(prompts).toEqual([]);
    expect(await services.turnJournal.list()).toEqual([]);
    expect((await services.automations.get("off"))?.runs[0]?.outcome).toBe("interrupted");
});

test("an empty journal is a no-op: a clean shutdown reads the settings for nothing", async () => {
    const services = await journalServices(mkdtempSync(join(tmpdir(), "restart-")));
    const prompts: string[] = [];
    await resumeInterruptedTurns(services, fakeWake(prompts), BOOT_AT);
    expect(prompts).toEqual([]);
});

// Rehydration is not a re-run: parked cards restore verbatim under their original request ids, and nothing spends a
// token until the user answers. autoResumeOnRestart (kept off here) gates unattended re-runs only, not this.
const parkedServices = async (root: string): Promise<{ services: Services; observed: AgentEvent[]; resuming: string[] }> => {
    const observed: AgentEvent[] = [];
    const resuming: string[] = [];
    const services = unstubbed<Services>("services", {
        ...(await journalServices(root, false)),
        agents: unstubbed<Services["agents"]>("agents", {
            entry: () => undefined,
            begin: async () => true,
            observe: (_id: string, event: AgentEvent) => {
                observed.push(event);
            },
            markResuming: (id: string) => {
                resuming.push(id);
            },
            finish: async () => {},
        }),
    });
    return { services, observed, resuming };
};

const planCard = (requestId: string): ParkedCard => ({ kind: "plan", requestId, text: "1. Ship it" });
const questionCard = (requestId: string): ParkedCard => ({
    kind: "question",
    requestId,
    questions: [
        {
            question: "Deploy now?",
            header: "Deploy",
            multiSelect: false,
            options: [
                { label: "Yes", description: "ship it" },
                { label: "No", description: "hold it" },
            ],
        },
    ],
});
const permissionCard = (requestId: string): ParkedCard => ({
    kind: "permission",
    requestId,
    toolName: "Bash",
    title: "Claude wants to run pnpm deploy",
});

const parkedEntry = (conversationId: string, cards: ParkedCard[], extra: Partial<JournalledTurn> = {}): JournalledTurn =>
    journalled(conversationId, { sessionId: "s-parked", parked: cards, ...extra });

// True once the cards' frames have folded through registry observe, the same moment the fleet and any attached window
// render them.
const cardsUp = async (observed: AgentEvent[], kind: ParkedCard["kind"]): Promise<void> => {
    await vi.waitFor(() => expect(observed.map((event) => event.kind)).toContain(kind), SETTLES);
};

test("a parked turn is rehydrated at boot: the cards go back up as they stood, and nothing runs until the user answers", async () => {
    const { services, observed, resuming } = await parkedServices(mkdtempSync(join(tmpdir(), "parked-")));
    await services.turnJournal.recordTurn(parkedEntry("pk-up", [planCard("r-up")]));
    const prompts: string[] = [];
    await resumeInterruptedTurns(services, fakeWake(prompts), BOOT_AT);
    await cardsUp(observed, "plan");

    // Session frame comes first, then the card verbatim: same id and text, so a saved answer draft still matches.
    expect(observed[0]).toEqual({ kind: "session", sessionId: "s-parked" });
    expect(observed[1]).toEqual(planCard("r-up"));
    expect(prompts).toEqual([]);
    // Re-journals through the ordinary frame loop, so a second restart rehydrates it again.
    await vi.waitFor(async () => {
        const [entry] = await services.turnJournal.list();
        expect(entry?.kind === "turn" ? (entry.parked ?? []).map((card) => card.requestId) : []).toEqual(["r-up"]);
    }, SETTLES);

    // Stopping a rehydrated park behaves like stopping a live turn: cards resolve without a reply and the journal entry
    // drains.
    expect(stopTurn("pk-up")).toBe(true);
    await settle("pk-up");
    expect(observed).toContainEqual({ kind: "resolved", requestId: "r-up" });
    expect(prompts).toEqual([]);
    expect(resuming).toEqual([]);
    await vi.waitFor(async () => expect(await services.turnJournal.list()).toEqual([]), SETTLES);
});

test("approving the restored plan resumes the session in the posture a live approval grants", async () => {
    const { services, observed, resuming } = await parkedServices(mkdtempSync(join(tmpdir(), "parked-")));
    await services.turnJournal.recordTurn(parkedEntry("pk-plan", [planCard("r-plan")]));
    const prompts: string[] = [];
    const inputs: AgentTurn[] = [];
    const capture: WakeFn = async function* (_services, input) {
        prompts.push(input.prompt);
        inputs.push(input);
        yield { kind: "done" };
    };
    await resumeInterruptedTurns(services, capture, BOOT_AT);
    await cardsUp(observed, "plan");

    expect(resolveRequest({ kind: "plan", requestId: "r-plan", approve: true })).toBe("settled");
    await vi.waitFor(() => expect(prompts).toHaveLength(1), SETTLES);
    expect(prompts[0]?.startsWith(RESUME_NOTES.answered)).toBe(true);
    expect(prompts[0]).toMatch(/approved.*plan/i);
    // bypassPermissions is POST_PLAN_MODE; a restart must not re-add per-tool prompts a live approval already spared.
    expect(inputs[0]).toMatchObject({ conversationId: "pk-plan", sessionId: "s-parked", permissionMode: "bypassPermissions" });
    expect(observed.map((event) => event.kind)).toContain("mode");
    // `resuming` holds the card out of Finished for the blink between placeholder and resumed turn.
    expect(resuming).toEqual(["pk-plan"]);
    await settle("pk-plan");
});

test("rejecting the restored plan with feedback goes back into plan mode carrying it", async () => {
    const { services, observed } = await parkedServices(mkdtempSync(join(tmpdir(), "parked-")));
    await services.turnJournal.recordTurn(parkedEntry("pk-rej", [planCard("r-rej")]));
    const prompts: string[] = [];
    const inputs: AgentTurn[] = [];
    const capture: WakeFn = async function* (_services, input) {
        prompts.push(input.prompt);
        inputs.push(input);
        yield { kind: "done" };
    };
    await resumeInterruptedTurns(services, capture, BOOT_AT);
    await cardsUp(observed, "plan");

    const feedback = "Use pnpm, not npm.";
    expect(resolveRequest({ kind: "plan", requestId: "r-rej", approve: false, feedback })).toBe("settled");
    await vi.waitFor(() => expect(prompts).toHaveLength(1), SETTLES);
    expect(prompts[0]).toContain(feedback);
    expect(inputs[0]).toMatchObject({ permissionMode: "plan" });
    await settle("pk-rej");
});

test("answering the restored question resumes with the picks, worded as a live answer is", async () => {
    const { services, observed } = await parkedServices(mkdtempSync(join(tmpdir(), "parked-")));
    await services.turnJournal.recordTurn(parkedEntry("pk-q", [questionCard("r-q")]));
    const prompts: string[] = [];
    await resumeInterruptedTurns(services, fakeWake(prompts), BOOT_AT);
    await cardsUp(observed, "question");

    expect(resolveRequest({ kind: "question", requestId: "r-q", answers: { "Deploy now?": ["Yes"] } })).toBe("settled");
    await vi.waitFor(() => expect(prompts).toHaveLength(1), SETTLES);
    // formatAnswers' own wording, so a restart reads identically to a live answer.
    expect(prompts[0]).toMatch(/user answered/i);
    expect(prompts[0]).toContain("Yes");
    await settle("pk-q");
});

test("dismissing the restored question ends the turn quietly, exactly as a live dismissal does", async () => {
    const { services, observed, resuming } = await parkedServices(mkdtempSync(join(tmpdir(), "parked-")));
    await services.turnJournal.recordTurn(parkedEntry("pk-dis", [questionCard("r-dis")]));
    const prompts: string[] = [];
    await resumeInterruptedTurns(services, fakeWake(prompts), BOOT_AT);
    await cardsUp(observed, "question");

    expect(resolveRequest({ kind: "question", requestId: "r-dis", cancelled: true })).toBe("settled");
    await settle("pk-dis");
    expect(prompts).toEqual([]);
    expect(resuming).toEqual([]);
    await vi.waitFor(async () => expect(await services.turnJournal.list()).toEqual([]), SETTLES);
});

test("allowing the restored permission resumes the turn told to run the tool", async () => {
    const { services, observed } = await parkedServices(mkdtempSync(join(tmpdir(), "parked-")));
    await services.turnJournal.recordTurn(parkedEntry("pk-allow", [permissionCard("r-allow")]));
    const prompts: string[] = [];
    await resumeInterruptedTurns(services, fakeWake(prompts), BOOT_AT);
    await cardsUp(observed, "permission");

    expect(resolveRequest({ kind: "permission", requestId: "r-allow", decision: "once" })).toBe("settled");
    await vi.waitFor(() => expect(prompts).toHaveLength(1), SETTLES);
    expect(prompts[0]?.startsWith(RESUME_NOTES.answered)).toBe(true);
    expect(prompts[0]).toMatch(/allowed Bash/i);
    await settle("pk-allow");
});

test("denying the restored permission with feedback resumes as a redirection; a bare deny ends the turn", async () => {
    const { services, observed } = await parkedServices(mkdtempSync(join(tmpdir(), "parked-")));
    await services.turnJournal.recordTurn(parkedEntry("pk-redir", [permissionCard("r-redir")]));
    const prompts: string[] = [];
    await resumeInterruptedTurns(services, fakeWake(prompts), BOOT_AT);
    await cardsUp(observed, "permission");
    const feedback = "Read the file instead.";
    expect(resolveRequest({ kind: "permission", requestId: "r-redir", decision: "deny", feedback })).toBe("settled");
    await vi.waitFor(() => expect(prompts).toHaveLength(1), SETTLES);
    expect(prompts[0]).toContain(feedback);
    await settle("pk-redir");

    // A bare deny is the user pulling the plug, as live: nothing resumes.
    const bare = await parkedServices(mkdtempSync(join(tmpdir(), "parked-")));
    await bare.services.turnJournal.recordTurn(parkedEntry("pk-bare", [permissionCard("r-bare")]));
    const barePrompts: string[] = [];
    await resumeInterruptedTurns(bare.services, fakeWake(barePrompts), BOOT_AT);
    await cardsUp(bare.observed, "permission");
    expect(resolveRequest({ kind: "permission", requestId: "r-bare", decision: "deny" })).toBe("settled");
    await settle("pk-bare");
    expect(barePrompts).toEqual([]);
    expect(bare.resuming).toEqual([]);
});

test("one answer resumes a turn parked on several cards: the others freeze cancelled", async () => {
    const { services, observed } = await parkedServices(mkdtempSync(join(tmpdir(), "parked-")));
    await services.turnJournal.recordTurn(parkedEntry("pk-multi", [questionCard("r-mq"), permissionCard("r-mp")]));
    const prompts: string[] = [];
    await resumeInterruptedTurns(services, fakeWake(prompts), BOOT_AT);
    await cardsUp(observed, "permission");

    expect(resolveRequest({ kind: "permission", requestId: "r-mp", decision: "once" })).toBe("settled");
    await vi.waitFor(() => expect(prompts).toHaveLength(1), SETTLES);
    expect(prompts[0]).toMatch(/allowed Bash/i);
    expect(observed).toContainEqual({ kind: "resolved", requestId: "r-mq" });
    await settle("pk-multi");
});

test("rehydration answers to none of the resume gates: spent, stale and toggle-off all still restore the card", async () => {
    // Every gate that stops a re-run (stale, spent, toggle off) is set here; rehydrating a parked card answers to none
    // of them.
    const { services, observed } = await parkedServices(mkdtempSync(join(tmpdir(), "parked-")));
    await services.turnJournal.recordTurn(parkedEntry("pk-gates", [questionCard("r-gates")], { attempts: 1, startedAt: 0 }));
    const prompts: string[] = [];
    await resumeInterruptedTurns(services, fakeWake(prompts), 10_000 + 7 * 60 * 60_000);
    await cardsUp(observed, "question");
    expect(prompts).toEqual([]);

    stopTurn("pk-gates");
    await settle("pk-gates");
});

// A spent allowance is never auto-resumed; only a user press re-runs the held turn, and each press builds a fresh
// prompt rather than replaying provider filler messages.

// Captures whole turns, not just prompts: which session a re-run lands on is half of what these tests assert.
const heldWake = (turns: AgentTurn[]): WakeFn =>
    async function* (_services, input) {
        turns.push(input);
        yield { kind: "done" } as AgentEvent;
    };

test("a turn refused before it ran is sent again in full, and NOT onto the session it left behind", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "held-")));
    const turns: AgentTurn[] = [];
    recordLimitFailure({ input: { prompt: "ship the parser", conversationId: "lim-1", isolated: true }, sessionId: "s-void", ran: false });

    expect(await fireLimitResume(services, heldWake(turns), "lim-1")).toEqual(expect.any(Object));
    await settle("lim-1");

    expect(turns).toHaveLength(1);
    expect(turns[0]!.prompt).toContain("ship the parser");
    // The alternative notes ("continue from that point") would instruct a model to resume work that never happened.
    expect(turns[0]!.prompt).toMatch(/no part of the request below/i);
    expect(turns[0]!.prompt).not.toMatch(/continue from that point/i);
    // Dropping s-void avoids the CLI materializing a "Continue from where you left off." / "No response requested."
    // pair per press; a fresh session gets the same seeded handoff a provider switch does.
    expect(turns[0]!.sessionId).toBeUndefined();

    clearPendingResume("lim-1");
});

test("a limit reached mid-flight keeps the session holding its work, and says so", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "held-")));
    const turns: AgentTurn[] = [];
    recordLimitFailure({ input: { prompt: "ship the parser", conversationId: "lim-2", isolated: true }, sessionId: "s-real", ran: true });

    await fireLimitResume(services, heldWake(turns), "lim-2");
    await settle("lim-2");

    expect(turns[0]!.sessionId).toBe("s-real");
    expect(turns[0]!.prompt).toMatch(/allowance ran out/i);
    expect(turns[0]!.prompt).toMatch(/continue from that point/i);

    clearPendingResume("lim-2");
});

test("a press on a switched account runs on it, and cannot take the old account's session with it", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "held-")));
    const turns: AgentTurn[] = [];
    recordLimitFailure({
        input: { prompt: "ship the parser", conversationId: "lim-moved", isolated: true, account: "spent-one" },
        sessionId: "s-real",
        ran: true,
    });

    await fireLimitResume(services, heldWake(turns), "lim-moved", { agent: "claude", harness: "native", account: "with-room" });
    await settle("lim-moved");

    expect(turns[0]!.account).toBe("with-room");
    // A session belongs to the credential that minted it: switching accounts can't reuse it, so the re-run opens a
    // fresh one seeded from the record.
    expect(turns[0]!.sessionId).toBeUndefined();
    // Not the mid-flight note: it points at a session this turn no longer has.
    expect(turns[0]!.prompt).toMatch(/sent again on a different account/i);
    expect(turns[0]!.prompt).toContain("ship the parser");

    clearPendingResume("lim-moved");
});

// Same routing isn't a switch: the session survives. The held turn leaves provider/harness implicit (absent means
// claude/native); the press spells them out, and that alone must not read as a move.
test("a press that names the routing the turn already had resumes its session", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "held-")));
    const turns: AgentTurn[] = [];
    recordLimitFailure({ input: { prompt: "ship the parser", conversationId: "lim-same", isolated: true }, sessionId: "s-real", ran: true });

    await fireLimitResume(services, heldWake(turns), "lim-same", { agent: "claude", harness: "native", model: "claude-sonnet-4-5" });
    await settle("lim-same");

    expect(turns[0]!.sessionId).toBe("s-real");
    expect(turns[0]!.prompt).toMatch(/continue from that point/i);
    // A same-provider model swap doesn't retire the session: the session outlives the model it was minted under.
    expect(turns[0]!.model).toBe("claude-sonnet-4-5");

    clearPendingResume("lim-same");
});

test("a press on a switched account still says nothing ran, when nothing ran", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "held-")));
    const turns: AgentTurn[] = [];
    recordLimitFailure({
        input: { prompt: "ship the parser", conversationId: "lim-door", isolated: true, account: "spent-one", model: "claude-opus-4-1" },
        sessionId: "s-void",
        ran: false,
    });

    await fireLimitResume(services, heldWake(turns), "lim-door", { agent: "claude", harness: "native", account: "with-room" });
    await settle("lim-door");

    expect(turns[0]!.account).toBe("with-room");
    expect(turns[0]!.prompt).toMatch(/no part of the request below/i);
    // No model in the press (unloaded catalog) leaves the refused turn's own model standing.
    expect(turns[0]!.model).toBe("claude-opus-4-1");

    clearPendingResume("lim-door");
});

test("a press that names no routing runs the turn exactly as it was", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "held-")));
    const turns: AgentTurn[] = [];
    recordLimitFailure({
        input: {
            prompt: "ship the parser",
            conversationId: "lim-bare",
            isolated: true,
            account: "spent-one",
            agent: "codex",
            harness: "claude-code",
        },
        sessionId: "s-real",
        ran: true,
    });

    await fireLimitResume(services, heldWake(turns), "lim-bare");
    await settle("lim-bare");

    expect(turns[0]).toMatchObject({ account: "spent-one", agent: "codex", harness: "claude-code", sessionId: "s-real" });

    clearPendingResume("lim-bare");
});

test("pressing again after a re-run was refused too states the note once, not once per press", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "held-")));
    const turns: AgentTurn[] = [];
    const wake = heldWake(turns);
    recordLimitFailure({ input: { prompt: "ship the parser", conversationId: "lim-3", isolated: true }, ran: false });

    await fireLimitResume(services, wake, "lim-3");
    await settle("lim-3");
    // Re-held using the prompt the last fire built, simulating a second refusal.
    recordLimitFailure({ input: { ...turns[0]!, conversationId: "lim-3" }, ran: false });
    await fireLimitResume(services, wake, "lim-3");
    await settle("lim-3");

    expect(turns).toHaveLength(2);
    expect(turns[1]!.prompt).toBe(turns[0]!.prompt);
    expect(turns[1]!.prompt.match(/no part of the request below/gu)).toHaveLength(1);

    clearPendingResume("lim-3");
});

test("a turn that ran before it was refused stops claiming nothing had been done", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "held-")));
    const turns: AgentTurn[] = [];
    const wake = heldWake(turns);
    recordLimitFailure({ input: { prompt: "ship the parser", conversationId: "lim-4", isolated: true }, ran: false });
    await fireLimitResume(services, wake, "lim-4");
    await settle("lim-4");

    // This retry got partway before failing again, crossing to the ran:true arm.
    recordLimitFailure({ input: { ...turns[0]!, conversationId: "lim-4" }, sessionId: "s-partial", ran: true });
    await fireLimitResume(services, wake, "lim-4");
    await settle("lim-4");

    // withResumeNote is idempotent: it replaces the note rather than stacking, so a changed reason still gets the right
    // one.
    expect(turns[1]!.prompt).toMatch(/allowance ran out/i);
    expect(turns[1]!.prompt).not.toMatch(/no part of the request below/i);
    expect(turns[1]!.prompt).toContain("ship the parser");

    clearPendingResume("lim-4");
});

test("nothing held answers with nothing, so the press falls back to saying carry on", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "held-")));
    expect(await fireLimitResume(services, heldWake([]), "lim-none")).toBeUndefined();
});

test("the next turn on the conversation supersedes the held one, whatever started it", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "held-")));
    recordLimitFailure({ input: { prompt: "ship the parser", conversationId: "lim-5", isolated: true }, ran: false });
    // Simulates the user typing instead of pressing: the pending hold must not survive their new message.
    clearPendingResume("lim-5");

    expect(await fireLimitResume(services, heldWake([]), "lim-5")).toBeUndefined();
});

// RECORDED is when the refusal happened; REOPENS is the window it named. Every test below pins some gate around that
// pair.
const RECORDED = 1_700_000_000_000;
const REOPENS = Math.round((RECORDED + 4 * 60 * 60 * 1000) / 1000);

test("an armed conversation sends the held turn again once the window reopens, and not before", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "limit-")), [], () => true, new Map(), new Map([["lim-auto-1", true]]));
    const turns: AgentTurn[] = [];
    const scheduler = createTurnResumeScheduler(services, heldWake(turns));
    recordLimitFailure(
        { input: { prompt: "ship the parser", conversationId: "lim-auto-1", isolated: true }, ran: false, reopensAt: REOPENS },
        RECORDED,
    );

    // An hour into a four-hour window: still shut, so firing here would repeat the same refusal.
    await scheduler.tick(RECORDED + 60 * 60 * 1000);
    expect(turns).toHaveLength(0);

    await scheduler.tick(REOPENS * 1000 + 1);
    await settle("lim-auto-1");
    expect(turns).toHaveLength(1);
    expect(turns[0]!.prompt).toContain("ship the parser");
    clearPendingResume("lim-auto-1");
});

// The entry survives its own fire, unlike the outage pass's delete-then-fire, so a press still works after the
// automatic one.
test("an armed conversation fires exactly once per hold", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "limit-")), [], () => true, new Map(), new Map([["lim-auto-2", true]]));
    const turns: AgentTurn[] = [];
    const scheduler = createTurnResumeScheduler(services, heldWake(turns));
    recordLimitFailure(
        { input: { prompt: "ship the parser", conversationId: "lim-auto-2", isolated: true }, ran: false, reopensAt: REOPENS },
        RECORDED,
    );

    await scheduler.tick(REOPENS * 1000 + 1);
    await settle("lim-auto-2");
    await scheduler.tick(REOPENS * 1000 + 5_000);
    await scheduler.tick(REOPENS * 1000 + 10_000);
    await settle("lim-auto-2");

    expect(turns).toHaveLength(1);
    clearPendingResume("lim-auto-2");
});

// Unarmed waits indefinitely; the turn stays held, so a press still works.
test("an unarmed conversation is never fired for, however long the window has been open", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "limit-")));
    const turns: AgentTurn[] = [];
    const scheduler = createTurnResumeScheduler(services, heldWake(turns));
    recordLimitFailure(
        { input: { prompt: "ship the parser", conversationId: "lim-auto-3", isolated: true }, ran: false, reopensAt: REOPENS },
        RECORDED,
    );

    await scheduler.tick(REOPENS * 1000 + 24 * 60 * 60 * 1000);
    expect(turns).toHaveLength(0);
    expect(await fireLimitResume(services, heldWake(turns), "lim-auto-3")).toEqual(expect.any(Object));
    await settle("lim-auto-3");
    clearPendingResume("lim-auto-3");
});

test("the sandbox setting arms a conversation that has said nothing itself", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "limit-")));
    const settings = await services.sandboxSettings.get();
    await services.sandboxSettings.set({ ...settings, resumeAfterLimit: true });
    const turns: AgentTurn[] = [];
    recordLimitFailure(
        { input: { prompt: "ship the parser", conversationId: "lim-auto-4", isolated: true }, ran: false, reopensAt: REOPENS },
        RECORDED,
    );

    await createTurnResumeScheduler(services, heldWake(turns)).tick(REOPENS * 1000 + 1);
    await settle("lim-auto-4");
    expect(turns).toHaveLength(1);
    clearPendingResume("lim-auto-4");
});

// Grok and Cursor publish no readable quota reset, so their refusals carry no instant to schedule against; armed or
// not, only the press remains.
test("a limit that named no reset instant is never fired for, armed or not", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "limit-")), [], () => true, new Map(), new Map([["lim-auto-5", true]]));
    const turns: AgentTurn[] = [];
    recordLimitFailure({ input: { prompt: "ship the parser", conversationId: "lim-auto-5", isolated: true }, ran: false }, RECORDED);

    await createTurnResumeScheduler(services, heldWake(turns)).tick(RECORDED + 24 * 60 * 60 * 1000);
    expect(turns).toHaveLength(0);
    clearPendingResume("lim-auto-5");
});

// A stale reset instant must not read as "open now": firing on it would re-refuse, re-record the same instant, and loop
// forever.
test("a reset instant that had already passed when the refusal happened is never fired for", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "limit-")), [], () => true, new Map(), new Map([["lim-auto-6", true]]));
    const turns: AgentTurn[] = [];
    const stale = Math.round((RECORDED - 60 * 60 * 1000) / 1000);
    recordLimitFailure(
        { input: { prompt: "ship the parser", conversationId: "lim-auto-6", isolated: true }, ran: false, reopensAt: stale },
        RECORDED,
    );

    await createTurnResumeScheduler(services, heldWake(turns)).tick(RECORDED + 5_000);
    expect(turns).toHaveLength(0);
    clearPendingResume("lim-auto-6");
});

// A session is a file the daemon keeps; a credential is per-turn env. `carry` keeps the session across an account
// change; the model isn't told its context is read on another allowance.
test("a press that carries keeps the session across the account change, and says so", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "held-")));
    const turns: AgentTurn[] = [];
    recordLimitFailure({
        input: { prompt: "ship the parser", conversationId: "lim-carry", isolated: true, account: "spent-one" },
        sessionId: "s-real",
        ran: true,
    });

    await fireLimitResume(services, heldWake(turns), "lim-carry", { agent: "claude", harness: "native", account: "with-room", carry: true });
    await settle("lim-carry");

    expect(turns[0]!.account).toBe("with-room");
    expect(turns[0]!.sessionId).toBe("s-real");
    expect(turns[0]!.prompt).toMatch(/in this same session/i);
    expect(turns[0]!.prompt).toContain("ship the parser");

    clearPendingResume("lim-carry");
});

// A refused carry is tried once, then falls back fresh via `carryRefused` and a move to the account the turn's already
// on.
test("a carry the other account refused re-runs fresh on that account, once", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "limit-")));
    const turns: AgentTurn[] = [];
    const scheduler = createTurnResumeScheduler(services, heldWake(turns));
    recordLimitFailure(
        {
            input: { prompt: "ship the parser", conversationId: "lim-refused-carry", isolated: true, account: "with-room" },
            sessionId: "s-real",
            ran: true,
            carryRefused: true,
            move: { account: "with-room", carry: false },
        },
        RECORDED,
    );

    await scheduler.tick(RECORDED + 5_000);
    await settle("lim-refused-carry");
    await scheduler.tick(RECORDED + 10_000);
    await settle("lim-refused-carry");

    expect(turns).toHaveLength(1);
    expect(turns[0]!.account).toBe("with-room");
    expect(turns[0]!.sessionId).toBeUndefined();
    expect(turns[0]!.prompt).toMatch(/sent again on a different account/i);
    clearPendingResume("lim-refused-carry");
});

// A booked move (LimitFailure.move) fires on the very next pass, no instant needed, and only once: the entry keeps a
// `fired` stamp like the appointment does.
test("a booked move fires on the next pass, with the session the policy said to carry, and only once", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "limit-")));
    const turns: AgentTurn[] = [];
    const scheduler = createTurnResumeScheduler(services, heldWake(turns));
    recordLimitFailure(
        {
            input: { prompt: "ship the parser", conversationId: "lim-move", isolated: true, account: "spent-one" },
            sessionId: "s-real",
            ran: true,
            reopensAt: REOPENS,
            move: { account: "with-room", carry: true },
        },
        RECORDED,
    );

    await scheduler.tick(RECORDED + 5_000);
    await settle("lim-move");
    expect(turns).toHaveLength(1);
    expect(turns[0]!.account).toBe("with-room");
    expect(turns[0]!.sessionId).toBe("s-real");
    expect(turns[0]!.prompt).toMatch(/in this same session/i);

    // One hold, one fire: neither the next pass nor the reset fires it again.
    await scheduler.tick(RECORDED + 10_000);
    await scheduler.tick(REOPENS * 1000 + 1);
    await settle("lim-move");
    expect(turns).toHaveLength(1);
    clearPendingResume("lim-move");
});

test("a held turn with no booked move and no arming stays held", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "limit-")));
    const turns: AgentTurn[] = [];
    const scheduler = createTurnResumeScheduler(services, heldWake(turns));
    recordLimitFailure({ input: { prompt: "ship the parser", conversationId: "lim-unbooked", isolated: true }, ran: false, reopensAt: REOPENS }, RECORDED);

    await scheduler.tick(RECORDED + 5_000);
    await scheduler.tick(REOPENS * 1000 + 1);
    expect(turns).toHaveLength(0);
    clearPendingResume("lim-unbooked");
});
