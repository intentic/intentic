import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    type AgentEvent,
    type AgentTurn,
    type ParkedRequest,
    type Persona,
    RESUME_NOTES,
    RETRY_LADDER_MS,
    RETRY_LADDER_TRIES,
    type SandboxSettings,
    SandboxSettingsSchema,
    type TranscriptRow,
    withResumeNote,
} from "@intentic/sandbox-contract";
import { waitFor, SETTLES } from "@intentic/testing/bun";
import { sqliteAgentsStore } from "../../../conversations/registry/agents-store.js";
import { conversationsDbPath, openConversationsDb } from "../../../store/conversations-db.js";
import { fileHeldWakesStore } from "../../../automations/held-wakes-store.js";
import { fileAutomationsStore } from "../../../automations/automations-store.js";
import { resumeInterruptedFires } from "../../../automations/fire-resume.js";
import type { Services } from "../../../composition.js";
import { unstubbed } from "@intentic/testing";
import type { TranscriptAgent } from "../../../sessions/agent-transcript.js";
import { testMintedSlices } from "../../../runtimes/minted/minted-provider.testing.js";
import { beginTurn, conversationEntry, drivenBy, fleetStoreOver, memoryFleet, notedFleet } from "../../../testing.js";
import { automationConfig } from "../../../harness/route-stores.testing.js";
import { fileTranscriptRecord } from "../../../sessions/transcript-record.js";
import { fileSandboxSettingsStore } from "../../../settings/settings-store.js";
import { OUTAGE_MAX_ATTEMPTS, recordProviderFailure, recordProviderSuccess } from "../../providers/provider-health.js";
import { providerReadiness } from "../../providers/provider-registry.js";
import { PROVIDER_MODULES } from "../../../runtimes/runtime-table.js";
import { type JournalledTurn, sqliteTurnJournal, type TurnJournal } from "./turn-journal.js";
import { turnRunOf } from "../../../conversations/actor/conversation-holdings.js";
import { createDomainEvents } from "../../../seams/domain-events.js";
import type { TurnInput, TurnStarter } from "../../../seams/turn-starter.js";
import type { BeginRefusal } from "../../../conversations/actor/conversation-decide.js";
import type { TurnRun } from "./turn-runs.js";
import { createTurnResumeScheduler, fireHeldResume, type HeldTurn, resumeInterruptedTurns, startConversationTurn } from "./turn-resume.js";
import { parkedCards } from "../../../conversations/actor/parked-cards.js";

// `takes` answers each abandon attempt (false: the turn is still unwinding); `armed`/`limitArmed` are per-conversation
// overrides for outage/limit resume, a missing id follows the sandbox default.
const fakeServices = (
    root: string,
    abandoned: string[] = [],
    takes: () => boolean = () => true,
    armed: ReadonlyMap<string, boolean> = new Map(),
    limitArmed: ReadonlyMap<string, boolean> = new Map(),
): Services => {
    const record = fileTranscriptRecord(root);
    // On the same database file the journal below is, so a turn this suite resumes journals where the boot pass reads.
    const { conversations } = memoryFleet(fleetStoreOver(openConversationsDb(conversationsDbPath(root))));
    return unstubbed<Services>("services", {
        // Parked with the same actors, so a restored card is the one a reply resolves.
        cards: parkedCards(conversations),
        sandboxSettings: fileSandboxSettingsStore(join(root, "settings.json")),
        // Read as data by run-role health, so it has to be a real seam: the helpers below spread this object, and a
        // spread keeps only own keys, dropping unstubbed's throwing proxy. Empty ledger: no rung has a failing streak.
        usage: unstubbed<Services["usage"]>("usage", { turns: async () => [] }),
        // Real actors hold the stranded records; only an abandon is answered here, `takes` saying whether the turn had
        // unwound enough for it to land.
        conversations: {
            ...conversations,
            send: (id, event, now) => {
                if (event.kind !== "resume-abandoned") {
                    return conversations.send(id, event, now);
                }
                abandoned.push(id);
                const reply = takes();
                return { reply, settled: Promise.resolve(reply) } as never;
            },
        },
        agents: unstubbed<Services["agents"]>("agents", {
            entry: (id: string) =>
                armed.has(id) || limitArmed.has(id)
                    ? conversationEntry({
                          id,
                          postures: {
                              ...(armed.has(id) ? { outage: armed.get(id) === true ? "retry" : "wait" } : {}),
                              ...(limitArmed.has(id) ? { limit: limitArmed.get(id) === true ? "resend" : "wait" } : {}),
                          },
                      })
                    : undefined,
        }),
        // Heard by nobody: what reacts to a turn is composition's to subscribe, not this suite's.
        events: createDomainEvents(() => {}),
        logger: unstubbed<Services["logger"]>("logger", { info: () => {}, warn: () => {}, error: () => {} }),
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        transcripts: unstubbed<Services["transcripts"]>("transcripts", {
            append: (agent: TranscriptAgent, messages: readonly TranscriptRow[]) => record.append(agent.id, messages),
            // Real record, not stubbed, so this suite reads transcripts in the same order the daemon does.
            count: (agent: TranscriptAgent) => record.count(agent.id),
        }),
    });
};

// What a settlement tells the conversation it belongs to, sent the way it sends it, and what a pass reads back.
const recordHeldTurn = (services: Services, held: HeldTurn, now?: number): void =>
    void services.conversations.send(held.input.conversationId, { kind: "turn-held", held }, now);
const clearPendingResume = (services: Services, conversationId: string): void =>
    void services.conversations.send(conversationId, { kind: "resume-superseded" });
const clearStopLadder = (services: Services, conversationId: string): void =>
    void services.conversations.send(conversationId, { kind: "turn-got-somewhere" });
const heldTurn = (services: Services, conversationId: string): HeldTurn | undefined => services.conversations.state(conversationId)?.resume.held;

const fakeWake = (prompts: string[], events: AgentEvent[] = [{ kind: "done" }]): TurnStarter["stream"] =>
    async function* (input) {
        prompts.push(input.prompt);
        yield* events;
    };

// The run a start made, for a case whose start must not be refused.
const made = (run: TurnRun | BeginRefusal): TurnRun => {
    if (typeof run === "string") {
        throw new Error(`the start was refused: ${run}`);
    }
    return run;
};

// Waits for a fire's detached run to finish; its wake lands after tick() returns, one I/O round-trip later.
const settle = async (services: Pick<Services, "conversations">, conversationId: string): Promise<void> => {
    await turnRunOf(services.conversations, conversationId)?.waitUntilFinished();
};

test("a started turn records its settled transcript, whatever provider ran it", async () => {
    const root = mkdtempSync(join(tmpdir(), "turn-resume-"));
    const record = fileTranscriptRecord(root);
    const started = made(
        await startConversationTurn(fakeServices(root), fakeWake([], [{ kind: "delta", text: "shipped" }, { kind: "done" }]), {
            prompt: "ship it",
            messageId: "m-ship",
            conversationId: "tr-record",
            agent: "codex",
            harness: "native",
        }),
    );
    await waitFor(async () => expect(await record.read("tr-record")).toHaveLength(2), SETTLES);
    // The run each row came from is part of the record: within its retention window that run is still attachable, and
    // a window redrawing from here has to recognise its rows when the head arrives.
    expect(await record.read("tr-record")).toEqual([
        { role: "user", text: "ship it", sentAt: expect.any(Number), messageId: "m-ship", run: started.id },
        { role: "assistant", text: "shipped", run: started.id },
    ]);
});

// `connected` names which providers are reachable, ordered (first entry is the head of the list); `routed` is the
// cheapest fake behind the readiness sweep.
const routed = (provider: string, connected: readonly string[]): { name: string; label: string }[] =>
    connected.includes(provider) ? [{ name: "acct", label: "Account" }] : [];

// The real readiness sweep over the real modules, asking these stores, as the daemon composes it.
const withProviders = (services: Services, connected: readonly string[]): Services => {
    const wired: Services = {
        ...services,
        providerModules: PROVIDER_MODULES,
        providerReadiness: () => providerReadiness(wired),
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
    };
    return wired;
};

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
        async function* (input) {
            seen.push(input);
            yield { kind: "done" };
        },
        turn,
    );
    await settle(services, turn.conversationId);
    return seen[0]!;
};

test("a turn carrying a run role takes that role's model, provider and effort", async () => {
    const ran = await ranWith(
        { modelRoles: { [ROLE]: [{ provider: "codex", model: "gpt-5.6", effort: "high" }] } },
        { prompt: "fix CI", conversationId: "ar-fill", runRole: ROLE },
    );
    expect(ran).toMatchObject({ agent: "codex", model: "gpt-5.6", effort: "high" });
});

test("every knob the pin carries rides onto the turn, and the ones it doesn't stay absent", async () => {
    const ran = await ranWith(
        { modelRoles: { [ROLE]: [{ provider: "codex", model: "gpt-5.6", effort: "xhigh", thinking: true, harness: "claude-code" }] } },
        { prompt: "fix CI", conversationId: "ar-knobs", runRole: ROLE },
    );
    expect(ran).toMatchObject({ agent: "codex", model: "gpt-5.6", effort: "xhigh", thinking: true, harness: "claude-code" });
    expect(ran.fast).toBeUndefined();
});

test("a knob the turn already carries is not overwritten by the pin's", async () => {
    const ran = await ranWith(
        { modelRoles: { [ROLE]: [{ provider: "codex", model: "gpt-5.6", effort: "low" }] } },
        { prompt: "fix CI", conversationId: "ar-knob-kept", runRole: ROLE, effort: "max" },
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
        { prompt: "fix CI", conversationId: "ar-head", runRole: ROLE },
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
        { prompt: "fix CI", conversationId: "ar-fallback", runRole: ROLE },
        ["claude"],
    );
    expect(ran).toMatchObject({ agent: "claude", model: "claude-opus-4-5", effort: "max" });
});

test("a list with nothing reachable left leaves the turn unset: it does not reach for a connected account", async () => {
    const ran = await ranWith(
        { modelRoles: { [ROLE]: [{ provider: "codex", model: "gpt-5.6" }] } },
        { prompt: "fix CI", conversationId: "ar-none", runRole: ROLE },
        ["claude", "gemini"],
    );
    expect(ran.model).toBeUndefined();
    // Nothing chose a provider, so the turn runs on the wire's default, named once where it came in.
    expect(ran.agent).toBe("claude");
});

test("a turn that names its own model keeps it", async () => {
    const ran = await ranWith(
        { modelRoles: { [ROLE]: [{ provider: "codex", model: "gpt-5.6" }] } },
        { prompt: "walk the story", conversationId: "ar-explicit", runRole: ROLE, agent: "claude", model: "claude-opus-4-5" },
    );
    expect(ran).toMatchObject({ agent: "claude", model: "claude-opus-4-5" });
});

// Injects a persona store the base fixture lacks; a turn that names no persona never reaches it.
const withPersonas = (services: Services, cards: readonly Persona[]): Services => ({
    ...services,
    personas: unstubbed<Services["personas"]>("personas", { get: async (id) => cards.find((card) => card.id === id) }),
});

const ranAs = async (
    cards: readonly Persona[],
    settings: Partial<SandboxSettings>,
    turn: AgentTurn & { conversationId: string },
): Promise<AgentTurn> => {
    const services = withPersonas(withProviders(fakeServices(mkdtempSync(join(tmpdir(), "agent-run-model-"))), ["claude", "codex", "gemini"]), cards);
    await services.sandboxSettings.set({ ...SandboxSettingsSchema.parse({}), ...settings });
    const seen: AgentTurn[] = [];
    await startConversationTurn(
        services,
        async function* (input) {
            seen.push(input);
            yield { kind: "done" };
        },
        turn,
    );
    await settle(services, turn.conversationId);
    return seen[0]!;
};

test("the persona's own ladder outranks the role's list, and brings its knobs", async () => {
    const ran = await ranAs(
        [{ id: "backend", capabilities: [], models: [{ provider: "claude", model: "claude-opus-4-5", effort: "max" }] }],
        { modelRoles: { [ROLE]: [{ provider: "codex", model: "gpt-5.6", effort: "low" }] } },
        { prompt: "fix CI", conversationId: "ar-persona", runRole: ROLE, actsAs: "backend" },
    );
    expect(ran).toMatchObject({ agent: "claude", model: "claude-opus-4-5", effort: "max" });
});

test("a persona with no ladder, or none reachable, leaves the question to the role", async () => {
    const roles = { modelRoles: { [ROLE]: [{ provider: "codex", model: "gpt-5.6" }] } };
    const silent = await ranAs([{ id: "quiet", capabilities: [] }], roles, {
        prompt: "fix CI",
        conversationId: "ar-persona-silent",
        runRole: ROLE,
        actsAs: "quiet",
    });
    expect(silent).toMatchObject({ agent: "codex", model: "gpt-5.6" });
    // Kimi isn't connected in this fixture.
    const unreachable = await ranAs([{ id: "far", capabilities: [], models: [{ provider: "kimi", model: "k2" }] }], roles, {
        prompt: "fix CI",
        conversationId: "ar-persona-far",
        runRole: ROLE,
        actsAs: "far",
    });
    expect(unreachable).toMatchObject({ agent: "codex", model: "gpt-5.6" });
    // A persona nobody has behaves like an empty ladder.
    const missing = await ranAs([], roles, { prompt: "fix CI", conversationId: "ar-persona-missing", runRole: ROLE, actsAs: "gone" });
    expect(missing).toMatchObject({ agent: "codex", model: "gpt-5.6" });
});

test("a turn that names its own model keeps it over the persona's ladder too", async () => {
    const ran = await ranAs(
        [{ id: "backend", capabilities: [], models: [{ provider: "claude", model: "claude-opus-4-5" }] }],
        {},
        { prompt: "fix CI", conversationId: "ar-persona-explicit", runRole: ROLE, actsAs: "backend", agent: "codex", model: "gpt-5.6" },
    );
    expect(ran).toMatchObject({ agent: "codex", model: "gpt-5.6" });
});

test("a chat naming neither role nor persona is left alone", async () => {
    // Carrying no pin source is what gates this: a chat whose catalog hadn't loaded also sends no model, and no role
    // list may answer for it.
    const ran = await ranWith({ modelRoles: { [ROLE]: [{ provider: "codex", model: "gpt-5.6" }] } }, { prompt: "hello", conversationId: "ar-chat" });
    expect(ran.model).toBeUndefined();
    // Nothing chose a provider, so the turn runs on the wire's default, named once where it came in.
    expect(ran.agent).toBe("claude");
});

// Audience and model routing are separate questions: a run somebody pressed and is watching still has nobody at a
// caret, so the flag may not change which model answers for it.
test("who is watching does not move the pin: the same role answers either way", async () => {
    const roles = { modelRoles: { [ROLE]: [{ provider: "codex", model: "gpt-5.6", effort: "high" }] } };
    const watched = await ranWith(roles, { prompt: "fix CI", conversationId: "ar-watched", runRole: ROLE });
    const unwatched = await ranWith(roles, { prompt: "fix CI", conversationId: "ar-unwatched", runRole: ROLE, unattended: true });
    expect(watched).toMatchObject({ agent: "codex", model: "gpt-5.6", effort: "high" });
    expect([unwatched.agent, unwatched.model, unwatched.effort]).toEqual([watched.agent, watched.model, watched.effort]);
});

test("an empty agent-run list leaves the turn unset rather than inventing one", async () => {
    const ran = await ranWith({ modelRoles: { [ROLE]: [] } }, { prompt: "fix CI", conversationId: "ar-unpinned", runRole: ROLE });
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

// A turn whose Claude credential the API refused mid-flight, held for its re-mint.
const authHold = (conversationId: string): HeldTurn => ({
    input: { prompt: "finish the report", conversationId, isolated: true },
    reason: "auth",
    ran: false,
    remint: { account: "acct", refusedToken: "tok-1" },
});

const authServices = (root: string, claudeStore: Services["claudeStore"], abandoned: string[] = [], takes: () => boolean = () => true): Services =>
    unstubbed<Services>("services", { ...fakeServices(root, abandoned, takes), claudeStore });

test("a turn the API refused mid-flight is re-minted and re-run on the next pass", async () => {
    const services = authServices(mkdtempSync(join(tmpdir(), "turn-resume-")), fakeStore({ accessToken: "tok-2" }));
    const prompts: string[] = [];
    recordHeldTurn(services, authHold("auth-1"));
    await createTurnResumeScheduler(drivenBy(services, fakeWake(prompts))).tick();
    await settle(services, "auth-1");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("finish the report");
    expect(prompts[0]).toMatch(/renew/i);
});

test("no resume when the credential is genuinely dead, the error frame's reconnect prompt is the real fix", async () => {
    // revokedAt marks it: rotate answers undefined for an already-revoked account.
    const abandoned: string[] = [];
    const services = authServices(mkdtempSync(join(tmpdir(), "turn-resume-")), fakeStore({ accessToken: "tok-1", revokedAt: 1 }), abandoned);
    const prompts: string[] = [];
    recordHeldTurn(services, authHold("auth-2"));
    await createTurnResumeScheduler(drivenBy(services, fakeWake(prompts))).tick();
    expect(prompts).toHaveLength(0);
    expect(abandoned).toEqual(["auth-2"]);
});

test("the next turn on the conversation supersedes a pending auth resume", async () => {
    const services = authServices(mkdtempSync(join(tmpdir(), "turn-resume-")), fakeStore({ accessToken: "tok-2" }));
    const prompts: string[] = [];
    recordHeldTurn(services, authHold("auth-4"));
    clearPendingResume(services, "auth-4");
    await createTurnResumeScheduler(drivenBy(services, fakeWake(prompts))).tick();
    expect(prompts).toHaveLength(0);
});

test("a re-mint that cannot be attempted keeps its place, then gives the card up once the minute is out", async () => {
    const abandoned: string[] = [];
    const services = authServices(mkdtempSync(join(tmpdir(), "turn-resume-")), brokenStore(), abandoned);
    const prompts: string[] = [];
    const scheduler = createTurnResumeScheduler(drivenBy(services, fakeWake(prompts)));
    recordHeldTurn(services, authHold("auth-5"), 1_000);
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
    const scheduler = createTurnResumeScheduler(drivenBy(services, fakeWake(prompts)));
    recordHeldTurn(services, authHold("auth-6"), 1_000);
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

// A turn the provider's outage stranded; the provider that served it is the breaker's key.
const outage = (conversationId: string, provider: string): HeldTurn => ({
    input: { prompt: "finish the report", conversationId, isolated: true, agent: provider },
    reason: "outage",
    ran: false,
});

// `outagePolicy` is the sandbox-wide answer; `armed` is the per-conversation override that takes precedence.
const outageServices = async (
    root: string,
    resumeAfterOutage = true,
    abandoned: string[] = [],
    armed: ReadonlyMap<string, boolean> = new Map(),
): Promise<Services> => {
    const services = fakeServices(root, abandoned, () => true, armed);
    const settings = await services.sandboxSettings.get();
    await services.sandboxSettings.set({ ...settings, outagePolicy: resumeAfterOutage ? "retry" : "wait" });
    return services;
};

test("a stranded turn resumes once the provider's wait elapses, under a note saying why", async () => {
    const services = await outageServices(mkdtempSync(join(tmpdir(), "turn-resume-")));
    const { retryAt } = recordProviderFailure("out-fire", OUT_NOW);
    recordHeldTurn(services, outage("out-1", "out-fire"), OUT_NOW);
    const prompts: string[] = [];
    const scheduler = createTurnResumeScheduler(drivenBy(services, fakeWake(prompts)));

    await scheduler.tick(retryAt - 1);
    await settle(services, "out-1");
    expect(prompts).toEqual([]);

    await scheduler.tick(retryAt);
    await settle(services, "out-1");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("finish the report");
    expect(prompts[0]).toMatch(/unavailable|outage/i);
    expect(heldTurn(services, "out-1")).toBeUndefined();
});

test("an outage costs ONE turn per window however many conversations are stranded on it", async () => {
    const services = await outageServices(mkdtempSync(join(tmpdir(), "turn-resume-")));
    const { retryAt } = recordProviderFailure("out-herd", OUT_NOW);
    for (const id of ["herd-1", "herd-2", "herd-3", "herd-4"]) {
        recordHeldTurn(services, outage(id, "out-herd"), OUT_NOW);
    }
    const prompts: string[] = [];
    await createTurnResumeScheduler(drivenBy(services, fakeWake(prompts))).tick(retryAt);
    await settle(services, "herd-1");

    // Firing moves the breaker's clock, so the other three are refused within this same pass.
    expect(prompts).toHaveLength(1);
    expect(heldTurn(services, "herd-1")).toBeUndefined();
    expect(heldTurn(services, "herd-2")).toEqual(expect.any(Object));
    expect(heldTurn(services, "herd-4")).toEqual(expect.any(Object));
    for (const id of ["herd-2", "herd-3", "herd-4"]) {
        clearPendingResume(services, id);
    }
});

test("evidence that the provider is back releases the stranded set without waiting out the backoff", async () => {
    const services = await outageServices(mkdtempSync(join(tmpdir(), "turn-resume-")));
    recordProviderFailure("out-back", OUT_NOW);
    recordHeldTurn(services, outage("back-1", "out-back"), OUT_NOW);
    const prompts: string[] = [];
    const scheduler = createTurnResumeScheduler(drivenBy(services, fakeWake(prompts)));
    await scheduler.tick(OUT_NOW);
    await settle(services, "back-1");
    expect(prompts).toEqual([]);

    recordProviderSuccess("out-back");
    await scheduler.tick(OUT_NOW + 1);
    await settle(services, "back-1");
    expect(prompts).toHaveLength(1);
});

test("with the toggle off the turn is remembered, not resumed: turning it on arms that same turn", async () => {
    const services = await outageServices(mkdtempSync(join(tmpdir(), "turn-resume-")), false);
    const { retryAt } = recordProviderFailure("out-toggle", OUT_NOW);
    recordHeldTurn(services, outage("toggle-1", "out-toggle"), OUT_NOW);
    const prompts: string[] = [];
    const scheduler = createTurnResumeScheduler(drivenBy(services, fakeWake(prompts)));
    await scheduler.tick(retryAt);
    await settle(services, "toggle-1");
    expect(prompts).toEqual([]);
    expect(heldTurn(services, "toggle-1")).toEqual(expect.any(Object));

    const settings = await services.sandboxSettings.get();
    await services.sandboxSettings.set({ ...settings, outagePolicy: "retry" });
    await scheduler.tick(retryAt);
    await settle(services, "toggle-1");
    expect(prompts).toHaveLength(1);
});

test("a conversation armed on its own resumes while the sandbox default leaves the rest alone", async () => {
    const services = await outageServices(mkdtempSync(join(tmpdir(), "turn-resume-")), false, [], new Map([["own-armed", true]]));
    const { retryAt } = recordProviderFailure("out-own", OUT_NOW);
    recordHeldTurn(services, outage("own-armed", "out-own"), OUT_NOW);
    recordHeldTurn(services, outage("own-quiet", "out-own"), OUT_NOW + 1);
    const prompts: string[] = [];
    const scheduler = createTurnResumeScheduler(drivenBy(services, fakeWake(prompts)));

    await scheduler.tick(retryAt);
    await settle(services, "own-armed");
    expect(prompts).toHaveLength(1);
    // Remembered without ever spending the breaker's window.
    expect(heldTurn(services, "own-quiet")).toEqual(expect.any(Object));
    // Process-wide map: an uncleared entry here would leak into the next test's pass.
    clearPendingResume(services, "own-quiet");
});

test("a conversation that opted out stays stopped even though the sandbox default resumes", async () => {
    const services = await outageServices(mkdtempSync(join(tmpdir(), "turn-resume-")), true, [], new Map([["own-off", false]]));
    const { retryAt } = recordProviderFailure("out-opt", OUT_NOW);
    recordHeldTurn(services, outage("own-off", "out-opt"), OUT_NOW);
    const prompts: string[] = [];
    const scheduler = createTurnResumeScheduler(drivenBy(services, fakeWake(prompts)));

    await scheduler.tick(retryAt);
    await settle(services, "own-off");
    expect(prompts).toEqual([]);
    expect(heldTurn(services, "own-off")).toEqual(expect.any(Object));
    clearPendingResume(services, "own-off");
});

test("a stranded turn nobody resumed within the hour is dropped rather than sprung back to life", async () => {
    const abandoned: string[] = [];
    const services = await outageServices(mkdtempSync(join(tmpdir(), "turn-resume-")), true, abandoned);
    recordHeldTurn(services, outage("stale-1", "out-stale"), OUT_NOW - 61 * 60_000);
    const prompts: string[] = [];
    await createTurnResumeScheduler(drivenBy(services, fakeWake(prompts))).tick(OUT_NOW);
    expect(prompts).toEqual([]);
    expect(heldTurn(services, "stale-1")).toBeUndefined();
    expect(abandoned).toEqual(["stale-1"]);
});

test("once the attempt budget is spent the failure stands: the retrying is finite by design", async () => {
    const services = await outageServices(mkdtempSync(join(tmpdir(), "turn-resume-")));
    const prompts: string[] = [];
    const scheduler = createTurnResumeScheduler(drivenBy(services, fakeWake(prompts)));
    let now = OUT_NOW;
    // Each iteration: a window releases one attempt, the attempt fails again, and the failure re-records the turn.
    for (let i = 0; i < OUTAGE_MAX_ATTEMPTS + 2; i += 1) {
        const { retryAt } = recordProviderFailure("out-spent", now);
        recordHeldTurn(services, outage("spent-1", "out-spent"), now);
        now = retryAt;
        await scheduler.tick(now);
        // Settles to avoid racing the next window's resume under the one-turn-per-conversation rule.
        await settle(services, "spent-1");
    }
    expect(prompts).toHaveLength(OUTAGE_MAX_ATTEMPTS);
    clearPendingResume(services, "spent-1");
});

test("the next turn on the conversation supersedes a pending outage resume", async () => {
    const services = await outageServices(mkdtempSync(join(tmpdir(), "turn-resume-")));
    const { retryAt } = recordProviderFailure("out-super", OUT_NOW);
    recordHeldTurn(services, outage("super-1", "out-super"), OUT_NOW);
    clearPendingResume(services, "super-1");
    const prompts: string[] = [];
    await createTurnResumeScheduler(drivenBy(services, fakeWake(prompts))).tick(retryAt);
    expect(prompts).toEqual([]);
});

test("one provider's outage never gates a conversation on another", async () => {
    const services = await outageServices(mkdtempSync(join(tmpdir(), "turn-resume-")));
    recordProviderFailure("out-claude", OUT_NOW);
    recordHeldTurn(services, outage("iso-claude", "out-claude"), OUT_NOW);
    recordHeldTurn(services, outage("iso-codex", "out-codex"), OUT_NOW);
    const prompts: string[] = [];
    await createTurnResumeScheduler(drivenBy(services, fakeWake(prompts))).tick(OUT_NOW);
    await settle(services, "iso-codex");
    expect(prompts).toHaveLength(1);
    expect(heldTurn(services, "iso-codex")).toBeUndefined();
    expect(heldTurn(services, "iso-claude")).toEqual(expect.any(Object));
    clearPendingResume(services, "iso-claude");
});

// Boot pass over the turn journal: every surviving entry is a turn or fire cut off by the daemon dying; each is
// consumed exactly once.

// The real journal on a temp dir, filing each turn after the conversation row its begin would have written first: an
// interrupted turn seeded the way a daemon that died under it left one.
const journalOver = (root: string): TurnJournal => {
    const db = openConversationsDb(conversationsDbPath(root));
    const registry = sqliteAgentsStore(db);
    const journal = sqliteTurnJournal(db);
    return {
        ...journal,
        recordTurn: async (entry) => {
            if (!registry.has(entry.turn.conversationId)) {
                registry.save([conversationEntry({ id: entry.turn.conversationId })]);
            }
            await journal.recordTurn(entry);
        },
    };
};

// autoResumeOnRestart is opt-in and off by default, so a test expecting a re-run must set it explicitly.
const journalServices = async (root: string, autoResumeOnRestart = true): Promise<Services> => {
    const services = unstubbed<Services>("services", {
        ...fakeServices(root),
        turnJournal: journalOver(root),
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
    turn: { prompt: "finish the report", messageId: "m-report", conversationId, isolated: true },
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
    const capture: TurnStarter["stream"] = async function* (input) {
        prompts.push(input.prompt);
        inputs.push(input);
        yield { kind: "done" };
    };
    await resumeInterruptedTurns(drivenBy(services, capture), BOOT_AT);

    await waitFor(() => expect(prompts).toHaveLength(1), SETTLES);
    expect(prompts[0]).toMatch(/restarted/i);
    expect(prompts[0]).toContain("finish the report");
    expect(inputs[0]?.sessionId).toBe("s-partial");
});

test("the attempt is spent on disk BEFORE the turn restarts, so a turn that kills the daemon cannot loop the boot", async () => {
    const root = mkdtempSync(join(tmpdir(), "restart-"));
    const real = journalOver(root);
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
    const wake: TurnStarter["stream"] = async function* () {
        order.push(`wake`);
        yield { kind: "done" };
    };
    await resumeInterruptedTurns(drivenBy(services, wake), BOOT_AT);
    await waitFor(() => expect(order).toContain(`wake`), SETTLES);

    expect(order[0]).toBe(`record:attempts=1`);
    expect(order.indexOf(`record:attempts=1`)).toBeLessThan(order.indexOf(`wake`));
});

test("an entry whose attempt is already spent is dropped WITHOUT running: no boot loop on a turn that kills the daemon", async () => {
    const services = await journalServices(mkdtempSync(join(tmpdir(), "restart-")));
    await services.turnJournal.recordTurn(journalled("rs-spent", { attempts: 1 }));
    const prompts: string[] = [];
    await resumeInterruptedTurns(drivenBy(services, fakeWake(prompts)), BOOT_AT);
    expect(prompts).toEqual([]);
    expect(await services.turnJournal.list()).toEqual([]);
});

test("an entry older than the staleness cap is dropped: a sandbox off for the weekend must not wake mid-thought", async () => {
    const services = await journalServices(mkdtempSync(join(tmpdir(), "restart-")));
    await services.turnJournal.recordTurn(journalled("rs-stale"));
    const prompts: string[] = [];
    await resumeInterruptedTurns(drivenBy(services, fakeWake(prompts)), 10_000 + 7 * 60 * 60_000);
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
    const driven = drivenBy(services, fakeWake(prompts));
    await resumeInterruptedTurns(driven, BOOT_AT);
    await resumeInterruptedFires(driven, BOOT_AT);
    expect(prompts).toEqual([]);
    expect(await services.turnJournal.list()).toEqual([]);
    // Written to the transcript with an explicit notice before the journal entry drains.
    expect(await fileTranscriptRecord(root).read("rs-off")).toEqual([
        { role: "user", text: "finish the report", sentAt: 10_000, messageId: "m-report" },
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
            readTail: async (_dir: string, id: string, since: number) => [
                { role: "user", text: "finish the report" },
                { role: "assistant", text: `two chapters in, on ${id} since ${since}` },
            ],
        }),
    });
    await services.turnJournal.recordTurn(journalled("rs-work", { sessionId: "s-partial" }));

    await resumeInterruptedTurns(drivenBy(services, fakeWake([])), BOOT_AT);

    expect(await fileTranscriptRecord(root).read("rs-work")).toEqual([
        // sentAt is the turn's own start time, not the provider's, and the id is its sender's, as on every other user row.
        { role: "user", text: "finish the report", sentAt: 10_000, messageId: "m-report" },
        // Reads the session the journal recorded, from the turn's own start; the registry entry may predate it.
        { role: "assistant", text: "two chapters in, on s-partial since 10000" },
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

    await resumeInterruptedTurns(drivenBy(services, fakeWake([])), BOOT_AT);

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
    await resumeInterruptedFires(drivenBy(services, fakeWake(prompts)), BOOT_AT);
    await waitFor(async () => expect((await services.automations.get("hook"))?.runs).toHaveLength(2), SETTLES);

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
    await resumeInterruptedFires(drivenBy(services, fakeWake(prompts)), BOOT_AT);
    await waitFor(() => expect(prompts).toEqual(["sweep"]), SETTLES);
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
    await resumeInterruptedFires(drivenBy(services, fakeWake(prompts)), BOOT_AT);
    expect(prompts).toEqual([]);
    expect(await services.turnJournal.list()).toEqual([]);
    expect((await services.automations.get("off"))?.runs[0]?.outcome).toBe("interrupted");
});

test("an empty journal is a no-op: a clean shutdown reads the settings for nothing", async () => {
    const services = await journalServices(mkdtempSync(join(tmpdir(), "restart-")));
    const prompts: string[] = [];
    await resumeInterruptedTurns(drivenBy(services, fakeWake(prompts)), BOOT_AT);
    expect(prompts).toEqual([]);
});

// Rehydration is not a re-run: parked cards restore verbatim under their original request ids, and nothing spends a
// token until the user answers. autoResumeOnRestart (kept off here) gates unattended re-runs only, not this.
const parkedServices = async (root: string): Promise<{ services: Services; observed: AgentEvent[]; resuming: string[] }> => {
    const observed: AgentEvent[] = [];
    const resuming: string[] = [];
    const services = unstubbed<Services>("services", {
        ...(await journalServices(root, false)),
        // The placeholder's frames are what the fleet would see; a promised resume is noted by conversation. On the
        // journal's own database file, where the placeholder re-journals the turn it rehydrates.
        ...notedFleet(
            (id, event) => {
                if (event.kind === "frame") {
                    observed.push(event.frame);
                }
                if (event.kind === "resume-promised") {
                    resuming.push(id);
                }
            },
            fleetStoreOver(openConversationsDb(conversationsDbPath(root))),
        ),
    });
    return { services, observed, resuming };
};

const planRequest = (requestId: string): ParkedRequest => ({ kind: "plan", requestId, text: "1. Ship it" });
const questionRequest = (requestId: string): ParkedRequest => ({
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
const permissionRequest = (requestId: string): ParkedRequest => ({
    kind: "permission",
    requestId,
    toolName: "Bash",
    title: "Claude wants to run pnpm deploy",
});

const parkedEntry = (conversationId: string, cards: ParkedRequest[], extra: Partial<JournalledTurn> = {}): JournalledTurn =>
    journalled(conversationId, { sessionId: "s-parked", parked: cards, ...extra });

// True once the cards' frames have folded through registry observe, the same moment the fleet and any attached window
// render them.
const cardsUp = async (observed: AgentEvent[], kind: ParkedRequest["kind"]): Promise<void> => {
    await waitFor(() => expect(observed.map((event) => event.kind)).toContain(kind), SETTLES);
};

test("a parked turn is rehydrated at boot: the cards go back up as they stood, and nothing runs until the user answers", async () => {
    const { services, observed, resuming } = await parkedServices(mkdtempSync(join(tmpdir(), "parked-")));
    await services.turnJournal.recordTurn(parkedEntry("pk-up", [planRequest("r-up")]));
    const prompts: string[] = [];
    await resumeInterruptedTurns(drivenBy(services, fakeWake(prompts)), BOOT_AT);
    await cardsUp(observed, "plan");

    // Session frame comes first, then the card verbatim: same id and text, so a saved answer draft still matches.
    expect(observed[0]).toEqual({ kind: "session", sessionId: "s-parked" });
    expect(observed[1]).toEqual(planRequest("r-up"));
    expect(prompts).toEqual([]);
    // Re-journals through the ordinary frame loop, so a second restart rehydrates it again.
    await waitFor(async () => {
        const [entry] = await services.turnJournal.list();
        expect(entry?.kind === "turn" ? (entry.parked ?? []).map((card) => card.requestId) : []).toEqual(["r-up"]);
    }, SETTLES);

    // Stopping a rehydrated park behaves like stopping a live turn: cards resolve without a reply and the journal entry
    // drains.
    expect(services.conversations.abort("pk-up")).toBe(true);
    await settle(services, "pk-up");
    expect(observed).toContainEqual({ kind: "resolved", requestId: "r-up" });
    expect(prompts).toEqual([]);
    expect(resuming).toEqual([]);
    await waitFor(async () => expect(await services.turnJournal.list()).toEqual([]), SETTLES);
});

test("approving the restored plan resumes the session in the posture a live approval grants", async () => {
    const { services, observed, resuming } = await parkedServices(mkdtempSync(join(tmpdir(), "parked-")));
    await services.turnJournal.recordTurn(parkedEntry("pk-plan", [planRequest("r-plan")]));
    const prompts: string[] = [];
    const inputs: AgentTurn[] = [];
    const capture: TurnStarter["stream"] = async function* (input) {
        prompts.push(input.prompt);
        inputs.push(input);
        yield { kind: "done" };
    };
    await resumeInterruptedTurns(drivenBy(services, capture), BOOT_AT);
    await cardsUp(observed, "plan");

    expect(services.cards.resolve({ kind: "plan", requestId: "r-plan", approve: true })).toBe("settled");
    await waitFor(() => expect(prompts).toHaveLength(1), SETTLES);
    expect(prompts[0]?.startsWith(RESUME_NOTES.answered)).toBe(true);
    expect(prompts[0]).toMatch(/approved.*plan/i);
    // bypassPermissions is POST_PLAN_MODE; a restart must not re-add per-tool prompts a live approval already spared.
    expect(inputs[0]).toMatchObject({ conversationId: "pk-plan", sessionId: "s-parked", permissionMode: "bypassPermissions" });
    expect(observed.map((event) => event.kind)).toContain("mode");
    // `resuming` holds the card out of Finished for the blink between placeholder and resumed turn.
    expect(resuming).toEqual(["pk-plan"]);
    await settle(services, "pk-plan");
});

test("rejecting the restored plan with feedback goes back into plan mode carrying it", async () => {
    const { services, observed } = await parkedServices(mkdtempSync(join(tmpdir(), "parked-")));
    await services.turnJournal.recordTurn(parkedEntry("pk-rej", [planRequest("r-rej")]));
    const prompts: string[] = [];
    const inputs: AgentTurn[] = [];
    const capture: TurnStarter["stream"] = async function* (input) {
        prompts.push(input.prompt);
        inputs.push(input);
        yield { kind: "done" };
    };
    await resumeInterruptedTurns(drivenBy(services, capture), BOOT_AT);
    await cardsUp(observed, "plan");

    const feedback = "Use pnpm, not npm.";
    expect(services.cards.resolve({ kind: "plan", requestId: "r-rej", approve: false, feedback })).toBe("settled");
    await waitFor(() => expect(prompts).toHaveLength(1), SETTLES);
    expect(prompts[0]).toContain(feedback);
    expect(inputs[0]).toMatchObject({ permissionMode: "plan" });
    await settle(services, "pk-rej");
});

test("answering the restored question resumes with the picks, worded as a live answer is", async () => {
    const { services, observed } = await parkedServices(mkdtempSync(join(tmpdir(), "parked-")));
    await services.turnJournal.recordTurn(parkedEntry("pk-q", [questionRequest("r-q")]));
    const prompts: string[] = [];
    await resumeInterruptedTurns(drivenBy(services, fakeWake(prompts)), BOOT_AT);
    await cardsUp(observed, "question");

    expect(services.cards.resolve({ kind: "question", requestId: "r-q", answers: { "Deploy now?": ["Yes"] } })).toBe("settled");
    await waitFor(() => expect(prompts).toHaveLength(1), SETTLES);
    // formatAnswers' own wording, so a restart reads identically to a live answer.
    expect(prompts[0]).toMatch(/user answered/i);
    expect(prompts[0]).toContain("Yes");
    await settle(services, "pk-q");
});

test("dismissing the restored question ends the turn quietly, exactly as a live dismissal does", async () => {
    const { services, observed, resuming } = await parkedServices(mkdtempSync(join(tmpdir(), "parked-")));
    await services.turnJournal.recordTurn(parkedEntry("pk-dis", [questionRequest("r-dis")]));
    const prompts: string[] = [];
    await resumeInterruptedTurns(drivenBy(services, fakeWake(prompts)), BOOT_AT);
    await cardsUp(observed, "question");

    expect(services.cards.resolve({ kind: "question", requestId: "r-dis", cancelled: true })).toBe("settled");
    await settle(services, "pk-dis");
    expect(prompts).toEqual([]);
    expect(resuming).toEqual([]);
    await waitFor(async () => expect(await services.turnJournal.list()).toEqual([]), SETTLES);
});

test("allowing the restored permission resumes the turn told to run the tool", async () => {
    const { services, observed } = await parkedServices(mkdtempSync(join(tmpdir(), "parked-")));
    await services.turnJournal.recordTurn(parkedEntry("pk-allow", [permissionRequest("r-allow")]));
    const prompts: string[] = [];
    await resumeInterruptedTurns(drivenBy(services, fakeWake(prompts)), BOOT_AT);
    await cardsUp(observed, "permission");

    expect(services.cards.resolve({ kind: "permission", requestId: "r-allow", decision: "once" })).toBe("settled");
    await waitFor(() => expect(prompts).toHaveLength(1), SETTLES);
    expect(prompts[0]?.startsWith(RESUME_NOTES.answered)).toBe(true);
    expect(prompts[0]).toMatch(/allowed Bash/i);
    await settle(services, "pk-allow");
});

test("denying the restored permission with feedback resumes as a redirection; a bare deny ends the turn", async () => {
    const { services, observed } = await parkedServices(mkdtempSync(join(tmpdir(), "parked-")));
    await services.turnJournal.recordTurn(parkedEntry("pk-redir", [permissionRequest("r-redir")]));
    const prompts: string[] = [];
    await resumeInterruptedTurns(drivenBy(services, fakeWake(prompts)), BOOT_AT);
    await cardsUp(observed, "permission");
    const feedback = "Read the file instead.";
    expect(services.cards.resolve({ kind: "permission", requestId: "r-redir", decision: "deny", feedback })).toBe("settled");
    await waitFor(() => expect(prompts).toHaveLength(1), SETTLES);
    expect(prompts[0]).toContain(feedback);
    await settle(services, "pk-redir");

    // A bare deny is the user pulling the plug, as live: nothing resumes.
    const bare = await parkedServices(mkdtempSync(join(tmpdir(), "parked-")));
    await bare.services.turnJournal.recordTurn(parkedEntry("pk-bare", [permissionRequest("r-bare")]));
    const barePrompts: string[] = [];
    await resumeInterruptedTurns(drivenBy(bare.services, fakeWake(barePrompts)), BOOT_AT);
    await cardsUp(bare.observed, "permission");
    expect(bare.services.cards.resolve({ kind: "permission", requestId: "r-bare", decision: "deny" })).toBe("settled");
    await settle(bare.services, "pk-bare");
    expect(barePrompts).toEqual([]);
    expect(bare.resuming).toEqual([]);
});

test("one answer resumes a turn parked on several cards: the others freeze cancelled", async () => {
    const { services, observed } = await parkedServices(mkdtempSync(join(tmpdir(), "parked-")));
    await services.turnJournal.recordTurn(parkedEntry("pk-multi", [questionRequest("r-mq"), permissionRequest("r-mp")]));
    const prompts: string[] = [];
    await resumeInterruptedTurns(drivenBy(services, fakeWake(prompts)), BOOT_AT);
    await cardsUp(observed, "permission");

    expect(services.cards.resolve({ kind: "permission", requestId: "r-mp", decision: "once" })).toBe("settled");
    await waitFor(() => expect(prompts).toHaveLength(1), SETTLES);
    expect(prompts[0]).toMatch(/allowed Bash/i);
    expect(observed).toContainEqual({ kind: "resolved", requestId: "r-mq" });
    await settle(services, "pk-multi");
});

test("rehydration answers to none of the resume gates: spent, stale and toggle-off all still restore the card", async () => {
    // Every gate that stops a re-run (stale, spent, toggle off) is set here; rehydrating a parked card answers to none
    // of them.
    const { services, observed } = await parkedServices(mkdtempSync(join(tmpdir(), "parked-")));
    await services.turnJournal.recordTurn(parkedEntry("pk-gates", [questionRequest("r-gates")], { attempts: 1, startedAt: 0 }));
    const prompts: string[] = [];
    await resumeInterruptedTurns(drivenBy(services, fakeWake(prompts)), 10_000 + 7 * 60 * 60_000);
    await cardsUp(observed, "question");
    expect(prompts).toEqual([]);

    services.conversations.abort("pk-gates");
    await settle(services, "pk-gates");
});

// A spent allowance is never auto-resumed; only a user press re-runs the held turn, and each press builds a fresh
// prompt rather than replaying provider filler messages.

// Captures whole turns, not just prompts: which session a re-run lands on is half of what these tests assert.
const heldWake = (turns: AgentTurn[]): TurnStarter["stream"] =>
    async function* (input) {
        turns.push(input);
        yield { kind: "done" } as AgentEvent;
    };

test("a turn refused before it ran is sent again in full, and NOT onto the session it left behind", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "held-")));
    const turns: AgentTurn[] = [];
    recordHeldTurn(services, {
        reason: "limit",
        input: { prompt: "ship the parser", conversationId: "lim-1", isolated: true },
        sessionId: "s-void",
        ran: false,
    });

    expect(await fireHeldResume(drivenBy(services, heldWake(turns)), "lim-1")).toEqual(expect.any(Object));
    await settle(services, "lim-1");

    expect(turns).toHaveLength(1);
    expect(turns[0]!.prompt).toContain("ship the parser");
    // The alternative notes ("continue from that point") would instruct a model to resume work that never happened.
    expect(turns[0]!.prompt).toMatch(/no part of the request below/i);
    expect(turns[0]!.prompt).not.toMatch(/continue from that point/i);
    // Dropping s-void avoids the CLI materializing a "Continue from where you left off." / "No response requested."
    // pair per press; a fresh session gets the same seeded handoff a provider switch does.
    expect(turns[0]!.sessionId).toBeUndefined();

    clearPendingResume(services, "lim-1");
});

test("a limit reached mid-flight keeps the session holding its work, and says so", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "held-")));
    const turns: AgentTurn[] = [];
    recordHeldTurn(services, {
        reason: "limit",
        input: { prompt: "ship the parser", conversationId: "lim-2", isolated: true },
        sessionId: "s-real",
        ran: true,
    });

    await fireHeldResume(drivenBy(services, heldWake(turns)), "lim-2");
    await settle(services, "lim-2");

    expect(turns[0]!.sessionId).toBe("s-real");
    expect(turns[0]!.prompt).toMatch(/allowance ran out/i);
    expect(turns[0]!.prompt).toMatch(/continue from that point/i);

    clearPendingResume(services, "lim-2");
});

test("a press on a switched account runs on it, and cannot take the old account's session with it", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "held-")));
    const turns: AgentTurn[] = [];
    recordHeldTurn(services, {
        reason: "limit",
        input: { prompt: "ship the parser", conversationId: "lim-moved", isolated: true, account: "spent-one" },
        sessionId: "s-real",
        ran: true,
    });

    await fireHeldResume(drivenBy(services, heldWake(turns)), "lim-moved", { agent: "claude", harness: "native", account: "with-room" });
    await settle(services, "lim-moved");

    expect(turns[0]!.account).toBe("with-room");
    // A session belongs to the credential that minted it: switching accounts can't reuse it, so the re-run opens a
    // fresh one seeded from the record.
    expect(turns[0]!.sessionId).toBeUndefined();
    // Not the mid-flight note: it points at a session this turn no longer has.
    expect(turns[0]!.prompt).toMatch(/sent again on a different account/i);
    expect(turns[0]!.prompt).toContain("ship the parser");

    clearPendingResume(services, "lim-moved");
});

// Same routing isn't a switch: the session survives. The held turn leaves provider/harness implicit (absent means
// claude/native); the press spells them out, and that alone must not read as a move.
test("a press that names the routing the turn already had resumes its session", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "held-")));
    const turns: AgentTurn[] = [];
    recordHeldTurn(services, {
        reason: "limit",
        input: { prompt: "ship the parser", conversationId: "lim-same", isolated: true },
        sessionId: "s-real",
        ran: true,
    });

    await fireHeldResume(drivenBy(services, heldWake(turns)), "lim-same", { agent: "claude", harness: "native", model: "claude-sonnet-4-5" });
    await settle(services, "lim-same");

    expect(turns[0]!.sessionId).toBe("s-real");
    expect(turns[0]!.prompt).toMatch(/continue from that point/i);
    // A same-provider model swap doesn't retire the session: the session outlives the model it was minted under.
    expect(turns[0]!.model).toBe("claude-sonnet-4-5");

    clearPendingResume(services, "lim-same");
});

test("a press on a switched account still says nothing ran, when nothing ran", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "held-")));
    const turns: AgentTurn[] = [];
    recordHeldTurn(services, {
        reason: "limit",
        input: { prompt: "ship the parser", conversationId: "lim-door", isolated: true, account: "spent-one", model: "claude-opus-4-1" },
        sessionId: "s-void",
        ran: false,
    });

    await fireHeldResume(drivenBy(services, heldWake(turns)), "lim-door", { agent: "claude", harness: "native", account: "with-room" });
    await settle(services, "lim-door");

    expect(turns[0]!.account).toBe("with-room");
    expect(turns[0]!.prompt).toMatch(/no part of the request below/i);
    // No model in the press (unloaded catalog) leaves the refused turn's own model standing.
    expect(turns[0]!.model).toBe("claude-opus-4-1");

    clearPendingResume(services, "lim-door");
});

// A composer that hasn't read the conversation's account sends a press naming none. That chose nothing: it used to drop
// the held account, retire the session, and tell the model it had been moved to a different account it was never on.
test("a press naming the runtime but no account keeps the held account and its session", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "held-")));
    const turns: AgentTurn[] = [];
    recordHeldTurn(services, {
        reason: "limit",
        input: { prompt: "ship the parser", conversationId: "lim-unnamed", isolated: true, account: "spent-one" },
        sessionId: "s-real",
        ran: true,
    });

    await fireHeldResume(drivenBy(services, heldWake(turns)), "lim-unnamed", { agent: "claude", harness: "native" });
    await settle(services, "lim-unnamed");

    expect(turns[0]).toMatchObject({ account: "spent-one", sessionId: "s-real" });
    expect(turns[0]!.prompt).toMatch(/continue from that point/i);
    expect(turns[0]!.prompt).not.toMatch(/different account/i);

    clearPendingResume(services, "lim-unnamed");
});

// Onto another runtime the held account belongs to the one being left, so it never rides across unnamed.
test("a press onto another runtime naming no account carries none of the old runtime's", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "held-")));
    const turns: AgentTurn[] = [];
    recordHeldTurn(services, {
        reason: "limit",
        input: { prompt: "ship the parser", conversationId: "lim-runtime", isolated: true, account: "spent-one" },
        sessionId: "s-real",
        ran: true,
    });

    await fireHeldResume(drivenBy(services, heldWake(turns)), "lim-runtime", { agent: "codex", harness: "native" });
    await settle(services, "lim-runtime");

    expect(turns[0]!.agent).toBe("codex");
    expect(turns[0]!.account).toBeUndefined();
    expect(turns[0]!.sessionId).toBeUndefined();

    clearPendingResume(services, "lim-runtime");
});

test("a press that names no routing runs the turn exactly as it was", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "held-")));
    const turns: AgentTurn[] = [];
    recordHeldTurn(services, {
        reason: "limit",
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

    await fireHeldResume(drivenBy(services, heldWake(turns)), "lim-bare");
    await settle(services, "lim-bare");

    expect(turns[0]).toMatchObject({ account: "spent-one", agent: "codex", harness: "claude-code", sessionId: "s-real" });

    clearPendingResume(services, "lim-bare");
});

test("pressing again after a re-run was refused too states the note once, not once per press", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "held-")));
    const turns: AgentTurn[] = [];
    const wake = heldWake(turns);
    recordHeldTurn(services, { reason: "limit", input: { prompt: "ship the parser", conversationId: "lim-3", isolated: true }, ran: false });

    await fireHeldResume(drivenBy(services, wake), "lim-3");
    await settle(services, "lim-3");
    // Re-held using the prompt the last fire built, simulating a second refusal.
    recordHeldTurn(services, { reason: "limit", input: { ...turns[0]!, conversationId: "lim-3" }, ran: false });
    await fireHeldResume(drivenBy(services, wake), "lim-3");
    await settle(services, "lim-3");

    expect(turns).toHaveLength(2);
    expect(turns[1]!.prompt).toBe(turns[0]!.prompt);
    expect(turns[1]!.prompt.match(/no part of the request below/gu)).toHaveLength(1);

    clearPendingResume(services, "lim-3");
});

test("a turn that ran before it was refused stops claiming nothing had been done", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "held-")));
    const turns: AgentTurn[] = [];
    const wake = heldWake(turns);
    recordHeldTurn(services, { reason: "limit", input: { prompt: "ship the parser", conversationId: "lim-4", isolated: true }, ran: false });
    await fireHeldResume(drivenBy(services, wake), "lim-4");
    await settle(services, "lim-4");

    // This retry got partway before failing again, crossing to the ran:true arm.
    recordHeldTurn(services, { reason: "limit", input: { ...turns[0]!, conversationId: "lim-4" }, sessionId: "s-partial", ran: true });
    await fireHeldResume(drivenBy(services, wake), "lim-4");
    await settle(services, "lim-4");

    // Keep resume notes idempotent so replacement reasons remain current.
    expect(turns[1]!.prompt).toMatch(/allowance ran out/i);
    expect(turns[1]!.prompt).not.toMatch(/no part of the request below/i);
    expect(turns[1]!.prompt).toContain("ship the parser");

    clearPendingResume(services, "lim-4");
});

test("nothing held answers with nothing, so the press falls back to saying carry on", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "held-")));
    expect(await fireHeldResume(drivenBy(services, heldWake([])), "lim-none")).toBeUndefined();
});

// A turn the sandbox started itself (a fix press, a peer's message, a re-run) has no composer holding its words. The
// bug this exists for: a fix press turned away for memory lost its whole prompt, and nothing offered to send it.
const TURNED_AWAY: AgentEvent[] = [{ kind: "error", code: "sandbox-memory-low", message: "Sandbox memory is low." }, { kind: "done" }];

test("a turn the sandbox started is kept when the door turns it away, its message recorded under the refusal", async () => {
    const root = mkdtempSync(join(tmpdir(), "door-"));
    const record = fileTranscriptRecord(root);
    const services = fakeServices(root);
    const started = made(
        await startConversationTurn(services, fakeWake([], TURNED_AWAY), {
            prompt: "fix the pipeline",
            messageId: "m-fix",
            conversationId: "door-kept",
            isolated: true,
        }),
    );
    await settle(services, "door-kept");

    expect(heldTurn(services, "door-kept")).toMatchObject({
        reason: "door",
        ran: false,
        run: started.id,
        input: { prompt: "fix the pipeline", isolated: true },
    });
    await waitFor(async () => expect(await record.read("door-kept")).toHaveLength(2), SETTLES);
    expect(await record.read("door-kept")).toEqual([
        { role: "user", text: "fix the pipeline", sentAt: expect.any(Number), messageId: "m-fix", run: started.id },
        expect.objectContaining({ role: "notice", noticeAction: "sendAnyway", sandboxHeld: true, run: started.id }),
    ]);

    // A person's words go back to the conversation's queue: a second copy kept here would be sent twice.
    await startConversationTurn(
        services,
        fakeWake([], TURNED_AWAY),
        { prompt: "fix the pipeline", conversationId: "door-sent" },
        { senderKeeps: true },
    );
    await settle(services, "door-sent");
    expect(heldTurn(services, "door-sent")).toBeUndefined();
    expect(await record.read("door-sent")).toEqual([]);

    clearPendingResume(services, "door-kept");
});

// Whether to go past a memory hold, a dead credential or a missing model is a person's call, never a clock's: the
// resume pass leaves the turn alone however long it waits, and only the press sends it.
test("a turn the door turned away waits for a press, which sends it whole, on the session it already had", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "door-")));
    const turns: AgentTurn[] = [];
    recordHeldTurn(services, {
        reason: "door",
        input: { prompt: "fix the pipeline", conversationId: "door-press", isolated: true, sessionId: "s-live", runRole: "pipeline-fix" },
        ran: false,
        run: "run-refused",
    });

    await createTurnResumeScheduler(drivenBy(services, heldWake(turns))).tick(Date.now() + 24 * 60 * 60_000);
    expect(turns).toEqual([]);

    await fireHeldResume(drivenBy(services, heldWake(turns)), "door-press");
    await settle(services, "door-press");

    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ isolated: true, sessionId: "s-live", runRole: "pipeline-fix" });
    expect(turns[0]!.prompt).toBe(withResumeNote("fix the pipeline", RESUME_NOTES.door));
    // The refused run recorded these same words; a session seeded from the record must not read them twice.
    expect(turns[0]).toMatchObject({ unseenRuns: ["run-refused"] });

    clearPendingResume(services, "door-press");
});

// Pressed before its cause was fixed, the re-run is turned away too: every refused copy of the words stays unseen.
test("a turn turned away again names every refused run before it, not only the last", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "door-")));
    const turns: AgentTurn[] = [];
    recordHeldTurn(services, {
        reason: "door",
        input: { prompt: withResumeNote("fix the pipeline", RESUME_NOTES.door), conversationId: "door-again", unseenRuns: ["run-first"] },
        ran: false,
        run: "run-second",
    });

    await fireHeldResume(drivenBy(services, heldWake(turns)), "door-again");
    await settle(services, "door-again");

    expect(turns[0]).toMatchObject({ unseenRuns: ["run-first", "run-second"] });
    // One note however many presses it took.
    expect(turns[0]!.prompt).toBe(withResumeNote("fix the pipeline", RESUME_NOTES.door));

    clearPendingResume(services, "door-again");
});

test("a turn a dead runtime cut short is sent again on its own session, with no allowance in the note", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "held-")));
    const turns: AgentTurn[] = [];
    recordHeldTurn(services, {
        reason: "stopped",
        input: { prompt: "ship the parser", conversationId: "stop-1", isolated: true },
        sessionId: "s-real",
        ran: true,
    });

    await fireHeldResume(drivenBy(services, heldWake(turns)), "stop-1");
    await settle(services, "stop-1");

    expect(turns).toHaveLength(1);
    expect(turns[0]!.sessionId).toBe("s-real");
    expect(turns[0]!.prompt).toContain("ship the parser");
    expect(turns[0]!.prompt).toMatch(/stopped before it finished/i);
    expect(turns[0]!.prompt).toMatch(/continue from that point/i);
    // The word itself is what this whole path exists to keep out of the record.
    expect(turns[0]!.prompt).not.toMatch(/allowance/i);

    clearPendingResume(services, "stop-1");
});

test("a stopped turn whose provider never answered opens fresh, since its session holds nothing", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "held-")));
    const turns: AgentTurn[] = [];
    recordHeldTurn(services, {
        reason: "stopped",
        input: { prompt: "ship the parser", conversationId: "stop-2", isolated: true },
        sessionId: "s-void",
        ran: false,
    });

    await fireHeldResume(drivenBy(services, heldWake(turns)), "stop-2");
    await settle(services, "stop-2");

    expect(turns[0]!.sessionId).toBeUndefined();
    expect(turns[0]!.prompt).toMatch(/stopped before it finished/i);

    clearPendingResume(services, "stop-2");
});

// The session that overflowed is the one thing that cannot be resumed: however much ran, the re-run opens fresh, seeded
// from the record, and its note replaces whatever note the overflowing attempt carried.
test("a turn whose session outgrew the model's window is sent again in a fresh session, under a note saying so", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "held-")));
    const turns: AgentTurn[] = [];
    recordHeldTurn(services, {
        reason: "overflow",
        input: { prompt: withResumeNote("ship the parser", RESUME_NOTES.stopped), conversationId: "over-1", isolated: true },
        sessionId: "s-full",
        ran: true,
    });

    await fireHeldResume(drivenBy(services, heldWake(turns)), "over-1");
    await settle(services, "over-1");

    expect(turns).toHaveLength(1);
    expect(turns[0]!.sessionId).toBeUndefined();
    expect(turns[0]!.prompt).toBe(withResumeNote("ship the parser", RESUME_NOTES.overflow));

    clearPendingResume(services, "over-1");
});

// The daemon's own remedy, not a wall the reader answers for: it fires on the next pass whatever the stop policy says,
// and once, since a fresh session that overflows too is held no longer.
test("an overflow is re-run fresh on the next pass, on no policy, and only once", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "held-")));
    const settings = await services.sandboxSettings.get();
    await services.sandboxSettings.set({ ...settings, stopPolicy: "wait" });
    const turns: AgentTurn[] = [];
    const scheduler = createTurnResumeScheduler(drivenBy(services, heldWake(turns)));
    recordHeldTurn(
        services,
        { reason: "overflow", input: { prompt: "ship the parser", conversationId: "over-2", isolated: true }, sessionId: "s-full", ran: true },
        RECORDED,
    );

    await scheduler.tick(RECORDED + 5_000);
    await settle(services, "over-2");
    await scheduler.tick(RECORDED + 10_000);
    await settle(services, "over-2");

    expect(turns).toHaveLength(1);
    expect(turns[0]!.sessionId).toBeUndefined();
    expect(turns[0]!.prompt).toBe(withResumeNote("ship the parser", RESUME_NOTES.overflow));
    clearPendingResume(services, "over-2");
});

// Only a person reopens an archived conversation: the pass spends the hold's one dispatch and runs nothing, the card stays
// filed away, and a press, being a person's, still sends it.
test("the resume pass runs nothing on an archived conversation and leaves it archived, where a press, reopening it, still sends it", async () => {
    const fleet = memoryFleet();
    const services: Services = { ...fakeServices(mkdtempSync(join(tmpdir(), "held-"))), conversations: fleet.conversations, cards: parkedCards(fleet.conversations) };
    await beginTurn(fleet.conversations, { conversationId: "over-filed", isolated: true, prompt: "ship the parser", profile: {} }, 1_000);
    await fleet.conversations.send("over-filed", { kind: "settle" }, 2_000).settled;
    await fleet.agents.setArchived(["over-filed"], 3_000);
    const sent: TurnInput[] = [];
    const body: TurnStarter["stream"] = async function* (input) {
        sent.push(input);
        yield { kind: "done" };
    };
    recordHeldTurn(
        services,
        { reason: "overflow", input: { prompt: "ship the parser", conversationId: "over-filed", isolated: true }, sessionId: "s-full", ran: true },
        RECORDED,
    );

    await createTurnResumeScheduler(drivenBy(services, body)).tick(RECORDED + 5_000);
    expect(sent).toEqual([]);
    expect(turnRunOf(fleet.conversations, "over-filed")).toBeUndefined();
    expect(fleet.agents.entry("over-filed")?.archivedAt).toBe(3_000);

    // A press refuses nothing on its own: the archived conversation is still refused until its door reopens it.
    expect(await fireHeldResume(drivenBy(services, body), "over-filed")).toBeUndefined();
    expect(sent).toEqual([]);
    await fleet.agents.clearArchived(["over-filed"]);
    await fireHeldResume(drivenBy(services, body), "over-filed");
    await settle(services, "over-filed");
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ conversationId: "over-filed" });
    clearPendingResume(services, "over-filed");
});

test("the next turn on the conversation supersedes the held one, whatever started it", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "held-")));
    recordHeldTurn(services, { reason: "limit", input: { prompt: "ship the parser", conversationId: "lim-5", isolated: true }, ran: false });
    // Simulates the user typing instead of pressing: the pending hold must not survive their new message.
    clearPendingResume(services, "lim-5");

    expect(await fireHeldResume(drivenBy(services, heldWake([])), "lim-5")).toBeUndefined();
});

// RECORDED is when the refusal happened; REOPENS is the window it named. Every test below pins some gate around that
// pair.
const RECORDED = 1_700_000_000_000;
const REOPENS = Math.round((RECORDED + 4 * 60 * 60 * 1000) / 1000);

test("an armed conversation sends the held turn again once the window reopens, and not before", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "limit-")), [], () => true, new Map(), new Map([["lim-auto-1", true]]));
    const turns: AgentTurn[] = [];
    const scheduler = createTurnResumeScheduler(drivenBy(services, heldWake(turns)));
    recordHeldTurn(
        services,
        { reason: "limit", input: { prompt: "ship the parser", conversationId: "lim-auto-1", isolated: true }, ran: false, reopensAt: REOPENS },
        RECORDED,
    );

    // An hour into a four-hour window: still shut, so firing here would repeat the same refusal.
    await scheduler.tick(RECORDED + 60 * 60 * 1000);
    expect(turns).toHaveLength(0);

    await scheduler.tick(REOPENS * 1000 + 1);
    await settle(services, "lim-auto-1");
    expect(turns).toHaveLength(1);
    expect(turns[0]!.prompt).toContain("ship the parser");
    clearPendingResume(services, "lim-auto-1");
});

// The entry survives its own fire, unlike the outage pass's delete-then-fire, so a press still works after the
// automatic one.
test("an armed conversation fires exactly once per hold", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "limit-")), [], () => true, new Map(), new Map([["lim-auto-2", true]]));
    const turns: AgentTurn[] = [];
    const scheduler = createTurnResumeScheduler(drivenBy(services, heldWake(turns)));
    recordHeldTurn(
        services,
        { reason: "limit", input: { prompt: "ship the parser", conversationId: "lim-auto-2", isolated: true }, ran: false, reopensAt: REOPENS },
        RECORDED,
    );

    await scheduler.tick(REOPENS * 1000 + 1);
    await settle(services, "lim-auto-2");
    await scheduler.tick(REOPENS * 1000 + 5_000);
    await scheduler.tick(REOPENS * 1000 + 10_000);
    await settle(services, "lim-auto-2");

    expect(turns).toHaveLength(1);
    clearPendingResume(services, "lim-auto-2");
});

// Unarmed waits indefinitely; the turn stays held, so a press still works.
test("an unarmed conversation is never fired for, however long the window has been open", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "limit-")));
    const turns: AgentTurn[] = [];
    const scheduler = createTurnResumeScheduler(drivenBy(services, heldWake(turns)));
    recordHeldTurn(
        services,
        { reason: "limit", input: { prompt: "ship the parser", conversationId: "lim-auto-3", isolated: true }, ran: false, reopensAt: REOPENS },
        RECORDED,
    );

    await scheduler.tick(REOPENS * 1000 + 24 * 60 * 60 * 1000);
    expect(turns).toHaveLength(0);
    expect(await fireHeldResume(drivenBy(services, heldWake(turns)), "lim-auto-3")).toEqual(expect.any(Object));
    await settle(services, "lim-auto-3");
    clearPendingResume(services, "lim-auto-3");
});

test("the sandbox setting arms a conversation that has said nothing itself", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "limit-")));
    const settings = await services.sandboxSettings.get();
    await services.sandboxSettings.set({ ...settings, limitPolicy: "resend" });
    const turns: AgentTurn[] = [];
    recordHeldTurn(
        services,
        { reason: "limit", input: { prompt: "ship the parser", conversationId: "lim-auto-4", isolated: true }, ran: false, reopensAt: REOPENS },
        RECORDED,
    );

    await createTurnResumeScheduler(drivenBy(services, heldWake(turns))).tick(REOPENS * 1000 + 1);
    await settle(services, "lim-auto-4");
    expect(turns).toHaveLength(1);
    clearPendingResume(services, "lim-auto-4");
});

// Grok and Cursor publish no readable quota reset, so their refusals carry no instant to schedule against; armed or
// not, only the press remains.
test("a limit that named no reset instant is never fired for, armed or not", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "limit-")), [], () => true, new Map(), new Map([["lim-auto-5", true]]));
    const turns: AgentTurn[] = [];
    recordHeldTurn(
        services,
        { reason: "limit", input: { prompt: "ship the parser", conversationId: "lim-auto-5", isolated: true }, ran: false },
        RECORDED,
    );

    await createTurnResumeScheduler(drivenBy(services, heldWake(turns))).tick(RECORDED + 24 * 60 * 60 * 1000);
    expect(turns).toHaveLength(0);
    clearPendingResume(services, "lim-auto-5");
});

// A stale reset instant must not read as "open now": firing on it would re-refuse, re-record the same instant, and loop
// forever.
test("a reset instant that had already passed when the refusal happened is never fired for", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "limit-")), [], () => true, new Map(), new Map([["lim-auto-6", true]]));
    const turns: AgentTurn[] = [];
    const stale = Math.round((RECORDED - 60 * 60 * 1000) / 1000);
    recordHeldTurn(
        services,
        { reason: "limit", input: { prompt: "ship the parser", conversationId: "lim-auto-6", isolated: true }, ran: false, reopensAt: stale },
        RECORDED,
    );

    await createTurnResumeScheduler(drivenBy(services, heldWake(turns))).tick(RECORDED + 5_000);
    expect(turns).toHaveLength(0);
    clearPendingResume(services, "lim-auto-6");
});

// A session is a file the daemon keeps; a credential is per-turn env. `carry` keeps the session across an account
// change; the model isn't told its context is read on another allowance.
test("a press that carries keeps the session across the account change, and says so", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "held-")));
    const turns: AgentTurn[] = [];
    recordHeldTurn(services, {
        reason: "limit",
        input: { prompt: "ship the parser", conversationId: "lim-carry", isolated: true, account: "spent-one" },
        sessionId: "s-real",
        ran: true,
    });

    await fireHeldResume(drivenBy(services, heldWake(turns)), "lim-carry", { agent: "claude", harness: "native", account: "with-room", carry: true });
    await settle(services, "lim-carry");

    expect(turns[0]!.account).toBe("with-room");
    expect(turns[0]!.sessionId).toBe("s-real");
    expect(turns[0]!.prompt).toMatch(/in this same session/i);
    expect(turns[0]!.prompt).toContain("ship the parser");

    clearPendingResume(services, "lim-carry");
});

// A refused carry is tried once, then falls back fresh via `carryRefused` and a move to the account the turn's already
// on.
// Only the owner's `move` answer books a move (bookLimitMove), and the pass asks it again before firing one.
const answerLimitsWithMove = async (services: ReturnType<typeof fakeServices>): Promise<void> => {
    await services.sandboxSettings.set({ ...(await services.sandboxSettings.get()), limitPolicy: "move" });
};

test("a carry the other account refused re-runs fresh on that account, once", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "limit-")));
    await answerLimitsWithMove(services);
    const turns: AgentTurn[] = [];
    const scheduler = createTurnResumeScheduler(drivenBy(services, heldWake(turns)));
    recordHeldTurn(
        services,
        {
            reason: "limit",
            input: { prompt: "ship the parser", conversationId: "lim-refused-carry", isolated: true, account: "with-room" },
            sessionId: "s-real",
            ran: true,
            carryRefused: true,
            move: { account: "with-room", carry: false },
        },
        RECORDED,
    );

    await scheduler.tick(RECORDED + 5_000);
    await settle(services, "lim-refused-carry");
    await scheduler.tick(RECORDED + 10_000);
    await settle(services, "lim-refused-carry");

    expect(turns).toHaveLength(1);
    expect(turns[0]!.account).toBe("with-room");
    expect(turns[0]!.sessionId).toBeUndefined();
    expect(turns[0]!.prompt).toMatch(/sent again on a different account/i);
    clearPendingResume(services, "lim-refused-carry");
});

// A booked move (LimitFailure.move) fires on the very next pass, no instant needed, and only once: the entry keeps a
// `fired` stamp like the appointment does.
test("a booked move fires on the next pass, with the session the policy said to carry, and only once", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "limit-")));
    await answerLimitsWithMove(services);
    const turns: AgentTurn[] = [];
    const scheduler = createTurnResumeScheduler(drivenBy(services, heldWake(turns)));
    recordHeldTurn(
        services,
        {
            reason: "limit",
            input: { prompt: "ship the parser", conversationId: "lim-move", isolated: true, account: "spent-one" },
            sessionId: "s-real",
            ran: true,
            reopensAt: REOPENS,
            move: { account: "with-room", carry: true },
        },
        RECORDED,
    );

    await scheduler.tick(RECORDED + 5_000);
    await settle(services, "lim-move");
    expect(turns).toHaveLength(1);
    expect(turns[0]!.account).toBe("with-room");
    expect(turns[0]!.sessionId).toBe("s-real");
    expect(turns[0]!.prompt).toMatch(/in this same session/i);

    // One hold, one fire: neither the next pass nor the reset fires it again.
    await scheduler.tick(RECORDED + 10_000);
    await scheduler.tick(REOPENS * 1000 + 1);
    await settle(services, "lim-move");
    expect(turns).toHaveLength(1);
    clearPendingResume(services, "lim-move");
});

// The move was booked at the failure, but the owner answered the card with `wait` before the pass came round: moving the
// conversation to another account anyway would be a switch they had just said no to.
test("a booked move the owner took back before the pass stays held on its own account", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "limit-")));
    const turns: AgentTurn[] = [];
    const scheduler = createTurnResumeScheduler(drivenBy(services, heldWake(turns)));
    recordHeldTurn(
        services,
        {
            reason: "limit",
            input: { prompt: "ship the parser", conversationId: "lim-withdrawn", isolated: true, account: "spent-one" },
            sessionId: "s-real",
            ran: true,
            reopensAt: REOPENS,
            move: { account: "with-room", carry: true },
        },
        RECORDED,
    );

    await scheduler.tick(RECORDED + 5_000);
    await scheduler.tick(REOPENS * 1000 + 1);
    await settle(services, "lim-withdrawn");

    expect(turns).toEqual([]);
    clearPendingResume(services, "lim-withdrawn");
});

test("a held turn with no booked move and no arming stays held", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "limit-")));
    const turns: AgentTurn[] = [];
    const scheduler = createTurnResumeScheduler(drivenBy(services, heldWake(turns)));
    recordHeldTurn(
        services,
        { reason: "limit", input: { prompt: "ship the parser", conversationId: "lim-unbooked", isolated: true }, ran: false, reopensAt: REOPENS },
        RECORDED,
    );

    await scheduler.tick(RECORDED + 5_000);
    await scheduler.tick(REOPENS * 1000 + 1);
    expect(turns).toHaveLength(0);
    clearPendingResume(services, "lim-unbooked");
});

// A turn that stopped short with nothing to repair: the ladder that re-runs it used to live in a browser tab, where it
// could not fire with the tab closed and read as a second, differently-named automation beside the daemon's own. Its
// rungs, its cap and its stand-down are the daemon's now.

// `stopArmed` is the sandbox-wide answer for this ending, since a stopped turn's entry carries no per-conversation
// override in these fixtures.
const stopServices = async (root: string, retry: boolean, abandoned: string[] = [], takes: () => boolean = () => true): Promise<Services> => {
    const services = fakeServices(root, abandoned, takes);
    const settings = await services.sandboxSettings.get();
    await services.sandboxSettings.set({ ...settings, stopPolicy: retry ? "retry" : "wait" });
    return services;
};

const stopHeld = (services: Services, conversationId: string, at: number): void => {
    recordHeldTurn(services, { reason: "stopped", input: { prompt: "ship the parser", conversationId, isolated: true }, ran: true }, at);
};

test("a stopped turn waits for a press unless this sandbox says otherwise", async () => {
    const services = await stopServices(mkdtempSync(join(tmpdir(), "stop-")), false);
    const turns: AgentTurn[] = [];
    stopHeld(services, "stop-1", RECORDED);

    await createTurnResumeScheduler(drivenBy(services, heldWake(turns))).tick(RECORDED + 60_000);
    expect(turns).toHaveLength(0);
    clearPendingResume(services, "stop-1");
    clearStopLadder(services, "stop-1");
});

test("an armed stop climbs its ladder rung by rung, and re-runs the held turn rather than saying anything", async () => {
    const services = await stopServices(mkdtempSync(join(tmpdir(), "stop-")), true);
    const turns: AgentTurn[] = [];
    const scheduler = createTurnResumeScheduler(drivenBy(services, heldWake(turns)));

    // RETRY_LADDER_MS, read from the contract rather than transcribed, so a change to the rungs moves this with it.
    for (const [rung, delay] of RETRY_LADDER_MS.entries()) {
        const recordedAt = RECORDED + rung * 60_000;
        stopHeld(services, "stop-2", recordedAt);
        // A second short of the rung: nothing fires, so the wait is the ladder's and not the poll interval's.
        await scheduler.tick(recordedAt + delay - 1);
        expect(turns, `rung ${rung}`).toHaveLength(rung);
        await scheduler.tick(recordedAt + delay);
        await settle(services, "stop-2");
        expect(turns, `rung ${rung}`).toHaveLength(rung + 1);
        // The fire's own turn start would clear the entry; these fixtures never reach it.
        clearPendingResume(services, "stop-2");
    }
    expect(turns).toHaveLength(RETRY_LADDER_TRIES);
    expect(turns[0]!.prompt).toContain("ship the parser");
    clearStopLadder(services, "stop-2");
});

test("a spent ladder stands down and says so, rather than leaving the card promising a return", async () => {
    const abandoned: string[] = [];
    const services = await stopServices(mkdtempSync(join(tmpdir(), "stop-")), true, abandoned);
    const turns: AgentTurn[] = [];
    const scheduler = createTurnResumeScheduler(drivenBy(services, heldWake(turns)));

    for (const [rung, delay] of RETRY_LADDER_MS.entries()) {
        const recordedAt = RECORDED + rung * 60_000;
        stopHeld(services, "stop-3", recordedAt);
        await scheduler.tick(recordedAt + delay);
        await settle(services, "stop-3");
        clearPendingResume(services, "stop-3");
    }
    expect(turns).toHaveLength(RETRY_LADDER_TRIES);

    // One more hold, with the ladder spent: nothing fires, and the conversation is told why, once.
    const lastAt = RECORDED + RETRY_LADDER_TRIES * 60_000;
    stopHeld(services, "stop-3", lastAt);
    await scheduler.tick(lastAt + 24 * 60 * 60 * 1000);
    await scheduler.tick(lastAt + 25 * 60 * 60 * 1000);
    expect(turns).toHaveLength(RETRY_LADDER_TRIES);
    expect(abandoned).toEqual(["stop-3"]);

    // The hold outlives the stand-down: a press re-runs the turn itself, where a dropped hold left it only a
    // "Continue" message to send.
    expect(heldTurn(services, "stop-3")?.input.prompt).toBe("ship the parser");
    await fireHeldResume(drivenBy(services, heldWake(turns)), "stop-3");
    await settle(services, "stop-3");
    expect(turns).toHaveLength(RETRY_LADDER_TRIES + 1);
    expect(turns.at(-1)!.prompt).toContain("ship the parser");
    clearPendingResume(services, "stop-3");
    clearStopLadder(services, "stop-3");
});

// The one proof the run is getting somewhere. Without it a run that keeps dying would climb forever, and with too
// broad a reset it would never reach the cap.
test("a turn that settles with nothing held puts the ladder back at its first rung", async () => {
    const services = await stopServices(mkdtempSync(join(tmpdir(), "stop-")), true);
    const turns: AgentTurn[] = [];
    const scheduler = createTurnResumeScheduler(drivenBy(services, heldWake(turns)));

    stopHeld(services, "stop-4", RECORDED);
    await scheduler.tick(RECORDED + RETRY_LADDER_MS[0]!);
    await settle(services, "stop-4");
    clearPendingResume(services, "stop-4");
    expect(turns).toHaveLength(1);

    // Second rung next, had nothing intervened.
    const afterProgress = RECORDED + 60_000;
    clearStopLadder(services, "stop-4");
    stopHeld(services, "stop-4", afterProgress);
    await scheduler.tick(afterProgress + RETRY_LADDER_MS[0]! - 1);
    expect(turns).toHaveLength(1);
    await scheduler.tick(afterProgress + RETRY_LADDER_MS[0]!);
    await settle(services, "stop-4");
    expect(turns).toHaveLength(2);
    clearPendingResume(services, "stop-4");
    clearStopLadder(services, "stop-4");
});
