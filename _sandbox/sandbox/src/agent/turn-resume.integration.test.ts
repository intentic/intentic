import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    type AgentEvent,
    type AgentTurn,
    type ParkedCard,
    type RestoredMessage,
    RESUME_NOTES,
    type SandboxSettings,
    SandboxSettingsSchema,
} from "@intentic/sandbox-contract";
import { expect, test, vi } from "vitest";
import { fileApprovalsStore } from "../automations/approvals-store.js";
import { fileAutomationsStore } from "../automations/automations-store.js";
import type { WakeFn } from "../automations/scheduler.js";
import type { Services } from "../composition.js";
import { unstubbed } from "@intentic/testing";
import type { TranscriptAgent } from "../sessions/agent-transcript.js";
import { fileTranscriptRecord } from "../sessions/transcript-record.js";
import { fileSandboxSettingsStore } from "../settings/settings-store.js";
import { resolveRequest } from "./agent-requests.js";
import { stopTurn } from "./agent-steering.js";
import { OUTAGE_MAX_ATTEMPTS, recordProviderFailure, recordProviderSuccess } from "./provider-health.js";
import { fileTurnJournal, type JournalledTurn } from "./turn-journal.js";
import { turnRunOf } from "./turn-runs.js";
import {
    clearPendingResume,
    createTurnResumeScheduler,
    pendingOutageFailure,
    recordAuthFailure,
    recordOutageFailure,
    resumeInterruptedTurns,
    startConversationTurn,
} from "./turn-resume.js";

// The scheduler touches settings/push/logger; the fake stays that small, plus the transcript record every
// started turn writes its settled frames to (startConversationTurn).
//
// `abandoned` collects the cards the pass gave up on — the fleet's half of a resume that never fires. It is
// worth a parameter rather than a stub each test writes, because the property it pins is the one nobody sees
// happen: a card holds itself out of the Finished lane from the moment its turn dies, so a pass that decides
// nothing is coming back and says nothing to the registry leaves a "Resuming…" spinner turning forever.
//
// `takes` is the registry's answer to each attempt: false means a turn was still unwinding and the abandon was
// not applied, which the pass has to come back from rather than treat as done (see abandonResume). Read per
// call so a test can flip it between passes, which is the whole shape of that race.
const fakeServices = (root: string, abandoned: string[] = [], takes: () => boolean = () => true): Services => {
    const record = fileTranscriptRecord(join(root, "transcripts"));
    return unstubbed<Services>("services", {
        sandboxSettings: fileSandboxSettingsStore(join(root, "settings.json")),
        agents: unstubbed<Services["agents"]>("agents", {
            abandonResume: async (id: string) => {
                abandoned.push(id);
                return takes();
            },
        }),
        // No device subscribed, which is what a workspace that has never granted push reports.
        pushSender: unstubbed<Services["pushSender"]>("pushSender", { notifyIfAway: async () => ({ delivered: 0, failed: 0 }) }),
        logger: unstubbed<Services["logger"]>("logger", { info: () => {}, warn: () => {}, error: () => {} }),
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        transcripts: unstubbed<Services["transcripts"]>("transcripts", {
            open: (agent: TranscriptAgent) => record.open(agent.id, async () => []),
            append: (agent: TranscriptAgent, messages: readonly RestoredMessage[]) => record.append(agent.id, messages),
        }),
    });
};

const fakeWake = (prompts: string[], events: AgentEvent[] = [{ kind: "done" }]): WakeFn =>
    async function* (_services, input) {
        prompts.push(input.prompt);
        yield* events;
    };

/* A fire starts a DETACHED run, and startConversationTurn opens the conversation's transcript record before it
 * lets the provider start (turn-runs' `before`), so the wake is reached one I/O round-trip after tick() returns
 * and the run stays live until the turn unwinds. Settling on it is what the minutes between real outage windows
 * do, and it makes every assertion below exact in both directions: a fire that happened is counted, and one that
 * should never have happened is caught here rather than raced past and mistaken for a later window's. */
const settle = async (conversationId: string): Promise<void> => {
    await turnRunOf(conversationId)?.waitUntilFinished();
};

/* startConversationTurn is THE one way a conversation's turn starts, which is why the transcript hangs off it:
 * every provider goes through here, so every provider's conversation is readable afterwards. Run on codex/native
 * on purpose — the pair with no Claude Code session store behind it, whose chats opened blank for exactly as
 * long as the transcript was something the daemon read back out of a provider instead of writing down. */
test("a started turn records its settled transcript, whatever provider ran it", async () => {
    const root = mkdtempSync(join(tmpdir(), "turn-resume-"));
    const record = fileTranscriptRecord(join(root, "transcripts"));
    const started = await startConversationTurn(fakeServices(root), fakeWake([], [{ kind: "delta", text: "shipped" }, { kind: "done" }]), {
        prompt: "ship it",
        conversationId: "tr-record",
        agent: "codex",
        harness: "native",
    });
    expect(started).toBeDefined();
    await vi.waitFor(async () => expect(await record.read("tr-record")).toHaveLength(2));
    // The user row is stamped with when it was sent; this suite is about which rows a settled turn records, so
    // it asserts the shape and lets the clock be a number.
    expect(await record.read("tr-record")).toEqual([
        { role: "user", text: "ship it", sentAt: expect.any(Number) },
        { role: "assistant", text: "shipped" },
    ]);
});

/* WHAT AN UNATTENDED TURN RUNS ON. Every surface that starts an agent for the user — Fix with agent, a
 * Maintenance chore, a Documentation or Acceptance run — comes through here naming no model, because there was
 * no picker in front of anybody when it started. These four cases are the whole rule, and the reason it lives at
 * this boundary rather than at each of those five call sites. */
const ranWith = async (settings: Partial<SandboxSettings>, turn: AgentTurn & { conversationId: string }): Promise<AgentTurn> => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "agent-run-model-")));
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
        { agentRunModel: "codex:gpt-5.6", agentRunEffort: "high" },
        { prompt: "fix CI", conversationId: "ar-fill", unattended: true },
    );
    // The provider rides along with the id and has to: a model id is only meaningful to the provider that vends
    // it, so honouring one without the other would send a Codex id to Claude.
    expect(ran).toMatchObject({ agent: "codex", model: "gpt-5.6", effort: "high" });
});

test("an unattended turn that names its own model keeps it", async () => {
    // Acceptance's per-run picker: a choice the user made a second ago outranks the standing setting.
    const ran = await ranWith(
        { agentRunModel: "codex:gpt-5.6" },
        { prompt: "walk the story", conversationId: "ar-explicit", unattended: true, agent: "claude", model: "claude-opus-4-5" },
    );
    expect(ran).toMatchObject({ agent: "claude", model: "claude-opus-4-5" });
});

test("a turn nobody flagged unattended is left alone", async () => {
    // The chat sends no model whenever its live catalog has not loaded yet. That must still resolve to the
    // PROVIDER's catalog default, not to the agent-run pin — the two look identical on the wire without the flag,
    // which is exactly why the flag exists rather than being inferred from a missing model.
    const ran = await ranWith({ agentRunModel: "codex:gpt-5.6" }, { prompt: "hello", conversationId: "ar-chat" });
    expect(ran.model).toBeUndefined();
    expect(ran.agent).toBeUndefined();
});

test("an unpinned agent-run model leaves the turn unset rather than inventing one", async () => {
    const ran = await ranWith({ agentRunModel: "" }, { prompt: "fix CI", conversationId: "ar-unpinned", unattended: true });
    expect(ran.model).toBeUndefined();
});

/* THE AUTH RESUME — the failure a rotation causes and the recovery the user should never have to perform.
 * A rotation retires the token every in-flight turn snapshotted at spawn, so they all die at once with
 * "401 OAuth access token has been revoked"; the fix is to re-mint and re-run, not to wait for a human. */

/* The store as it stands AFTER the rotation that refused the turn: it already holds the successor token, so
 * the resume adopts it without a second refresh. That is the shape of the real failure — the proactive timer
 * rotates, the store moves on, and the in-flight turns are left holding the retired token. */
const fakeStore = (stored: { accessToken: string; revokedAt?: number }): Services["claudeStore"] =>
    unstubbed<Services["claudeStore"]>("claudeStore", {
        read: async () => ({ id: "acct", label: "Claude", connectedAt: 0, refreshToken: "rt", ...stored }),
        write: async () => {},
        clear: async () => {},
        list: async () => [],
        withRefreshLock: async (_id, act) => act(),
        logger: unstubbed<Services["logger"]>("logger", { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
    });

/* A store that cannot answer at all — the token endpoint unreachable, the request timing out, the disk refusing
 * the write. Distinct from the revoked account above and the distinction is the point: that one is an ANSWER
 * ("this credential is dead"), and this one is the question never being asked. */
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
    // The original request rides again in full, behind a note saying why — a bare "continue" would lose it.
    expect(prompts[0]).toContain("finish the report");
    expect(prompts[0]).toContain("has been renewed");
});

test("no resume when the credential is genuinely dead — the error frame's reconnect prompt is the real fix", async () => {
    // An account already marked revoked (its refresh token was rejected): rotate answers undefined.
    const abandoned: string[] = [];
    const services = authServices(mkdtempSync(join(tmpdir(), "turn-resume-")), fakeStore({ accessToken: "tok-1", revokedAt: 1 }), abandoned);
    const prompts: string[] = [];
    recordAuthFailure({ input: { prompt: "finish the report", conversationId: "auth-2", isolated: true }, account: "acct", refusedToken: "tok-1" });
    await createTurnResumeScheduler(services, fakeWake(prompts)).tick();
    expect(prompts).toHaveLength(0);
    // And the card is told, because it has been saying "coming back" since the turn died. This is the one auth
    // failure a person really does have to act on, so it has to end up in front of them.
    expect(abandoned).toEqual(["auth-2"]);
});

test("a resume that is itself refused is not resumed again — a dead credential must not respawn forever", async () => {
    const services = authServices(mkdtempSync(join(tmpdir(), "turn-resume-")), fakeStore({ accessToken: "tok-2" }));
    const prompts: string[] = [];
    // The prompt a fired resume carries. Recording it again is the loop this refuses to start.
    recordAuthFailure({
        input: {
            prompt: "The Claude credential that interrupted this conversation has been renewed, and this turn resumed automatically. …",
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

/* THE PROMISE HAS A DEADLINE ON IT, and this is the case that says why it needs one. A re-mint that cannot even
 * be attempted is not an answer about the credential, so it buys another pass rather than a reconnect notice
 * the user cannot act on. What it must not buy is silence: the card has been showing a spinner and an elapsed
 * counter since the turn died, and nothing but this pass can ever end that. Two live sessions sat like that for
 * hours because one attempt consumed its pending entry and then quietly achieved nothing. */
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
    // Neither resumed nor given up on: the store said nothing about the credential, so nothing is decided yet.
    expect(prompts).toHaveLength(0);
    expect(abandoned).toEqual([]);
    // And the entry is still here, which is the whole repair — the pass comes back to it.
    await scheduler.tick(30_000);
    expect(abandoned).toEqual([]);
    // Past the minute the promise is withdrawn rather than left hanging: the card settles into Attention.
    await scheduler.tick(61_002);
    expect(abandoned).toEqual(["auth-5"]);
    // Once, not on every pass for the life of the daemon.
    await scheduler.tick(90_000);
    expect(abandoned).toEqual(["auth-5"]);
    expect(prompts).toHaveLength(0);
});

/* The narrow race that produced the same spinner: the pass fires within a few seconds of the refusal, which can
 * be before the failed turn has finished unwinding — and a card written in that window is overwritten by the
 * finish that follows. The registry says so, and the entry stays until the answer changes. */
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
    // Landed, so consumed — the pass stops asking.
    await scheduler.tick(3_000);
    expect(abandoned).toEqual(["auth-6", "auth-6"]);
    expect(prompts).toHaveLength(0);
});

/* THE OUTAGE RESUME — the one whose whole job is restraint. The provider is failing intermittently, so the
 * question is never "can we retry" (always yes) but "how little can we spend finding out", and the answers live
 * across two modules: the wait is the breaker's (provider-health.ts), the choice of which stranded turn spends it
 * is this one's. Each test invents its own provider name, because the breaker is process-wide state. */

const OUT_NOW = 5_000_000;

const outage = (conversationId: string, provider: string, extra: Record<string, unknown> = {}) => ({
    input: { prompt: "finish the report", conversationId, isolated: true },
    provider,
    ...extra,
});

const outageServices = async (root: string, resumeAfterOutage = true, abandoned: string[] = []): Promise<Services> => {
    const services = fakeServices(root, abandoned);
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

    // Nothing while the wait runs — this is the anti-spam contract, and it is the default state of an outage.
    await scheduler.tick(retryAt - 1);
    await settle("out-1");
    expect(prompts).toEqual([]);

    await scheduler.tick(retryAt);
    await settle("out-1");
    expect(prompts).toHaveLength(1);
    // The original request rides again IN FULL behind the note: a bare "continue" would lose it, and the note is
    // what stops the model from starting over on work its session already holds.
    expect(prompts[0]).toContain("finish the report");
    expect(prompts[0]).toContain("model provider was briefly unavailable");
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

    // Firing moves the breaker's clock, so the other three are refused inside this same pass. Four stranded
    // agents cost exactly what one costs — the whole reason the wait lives per provider and not per conversation.
    expect(prompts).toHaveLength(1);
    expect(pendingOutageFailure("herd-1")).toBeUndefined();
    // And the ones that did not go are still remembered, in order, for the windows after this.
    expect(pendingOutageFailure("herd-2")).toBeDefined();
    expect(pendingOutageFailure("herd-4")).toBeDefined();
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

    // Any turn's first content clears the outage (agent.routes.ts calls this) — a user's own message going
    // through, an automation waking, another agent entirely. The stranded turn goes on the very next pass rather
    // than sitting out a wait the provider has already disproved.
    recordProviderSuccess("out-back");
    await scheduler.tick(OUT_NOW + 1);
    await settle("back-1");
    expect(prompts).toHaveLength(1);
});

test("with the toggle off the turn is remembered, not resumed — turning it on arms that same turn", async () => {
    const services = await outageServices(mkdtempSync(join(tmpdir(), "turn-resume-")), false);
    const { retryAt } = recordProviderFailure("out-toggle", OUT_NOW);
    recordOutageFailure(outage("toggle-1", "out-toggle"), OUT_NOW);
    const prompts: string[] = [];
    const scheduler = createTurnResumeScheduler(services, fakeWake(prompts));
    await scheduler.tick(retryAt);
    await settle("toggle-1");
    expect(prompts).toEqual([]);
    expect(pendingOutageFailure("toggle-1")).toBeDefined();

    const settings = await services.sandboxSettings.get();
    await services.sandboxSettings.set({ ...settings, resumeAfterOutage: true });
    await scheduler.tick(retryAt);
    await settle("toggle-1");
    expect(prompts).toHaveLength(1);
});

test("a stranded turn nobody resumed within the hour is dropped rather than sprung back to life", async () => {
    const abandoned: string[] = [];
    const services = await outageServices(mkdtempSync(join(tmpdir(), "turn-resume-")), true, abandoned);
    recordOutageFailure(outage("stale-1", "out-stale"), OUT_NOW - 61 * 60_000);
    const prompts: string[] = [];
    await createTurnResumeScheduler(services, fakeWake(prompts)).tick(OUT_NOW);
    expect(prompts).toEqual([]);
    expect(pendingOutageFailure("stale-1")).toBeUndefined();
    // Dropped from the board's point of view too: the card stops promising a turn that is no longer coming.
    expect(abandoned).toEqual(["stale-1"]);
});

test("once the attempt budget is spent the failure stands — the retrying is finite by design", async () => {
    const services = await outageServices(mkdtempSync(join(tmpdir(), "turn-resume-")));
    const prompts: string[] = [];
    const scheduler = createTurnResumeScheduler(services, fakeWake(prompts));
    let now = OUT_NOW;
    // Walk the whole outage: each window releases one attempt, that attempt dies on the provider too, and its
    // turn is re-recorded by its own failure — which is what a resume that fails again really does.
    for (let i = 0; i < OUTAGE_MAX_ATTEMPTS + 2; i += 1) {
        const { retryAt } = recordProviderFailure("out-spent", now);
        recordOutageFailure(outage("spent-1", "out-spent"), now);
        now = retryAt;
        await scheduler.tick(now);
        // The windows are half an hour apart in the world this simulates, so the probe they released is long
        // over by the next one. Settling here says that; without it the loop would race its own last resume and
        // lose a window to turn-runs' one-live-turn-per-conversation rule, which is not what is being measured.
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
    // The Codex conversation has nothing to wait for: its provider never failed.
    expect(prompts).toHaveLength(1);
    expect(pendingOutageFailure("iso-codex")).toBeUndefined();
    expect(pendingOutageFailure("iso-claude")).toBeDefined();
    clearPendingResume("iso-claude");
});

/* THE RESTART RESUME — the boot pass over the turn journal. Every entry that survived to boot is a turn or a
 * fire the daemon stopped existing under, so the whole condition is "there is an entry"; what the tests below
 * pin down is what it takes to be re-run, and that each entry is consumed exactly once whatever happens. */

/* The journal is a real one on a temp dir: what the pass leaves on disk is half of what these assert. The
 * setting is written explicitly, like the outage helper above, because the restart resume is opt-in — a fresh
 * sandbox re-runs nothing, so every test that expects a re-run has to say it turned this on. */
const journalServices = async (root: string, autoResumeOnRestart = true): Promise<Services> => {
    const services = unstubbed<Services>("services", {
        ...fakeServices(root),
        turnJournal: fileTurnJournal(join(root, "turns")),
        automations: fileAutomationsStore(join(root, "automations.json"), join(root, "automation-runs.json")),
        approvals: fileApprovalsStore(join(root, "approvals")),
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

// Just inside the six-hour staleness cap, measured from the entry's own startedAt.
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

    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    expect(prompts[0]).toContain("The sandbox restarted");
    // The request rides again IN FULL — a bare "continue" would lose it.
    expect(prompts[0]).toContain("finish the report");
    // On the session the dying turn last reported, which is what makes this a continuation and not a restart.
    expect(inputs[0]?.sessionId).toBe("s-partial");
});

test("the attempt is spent on disk BEFORE the turn restarts, so a turn that kills the daemon cannot loop the boot", async () => {
    const root = mkdtempSync(join(tmpdir(), "restart-"));
    const real = fileTurnJournal(join(root, "turns"));
    await real.recordTurn(journalled("rs-spend"));
    // The order log is the assertion: this is a happens-before, and a test that read the file from inside the
    // wake would be racing the resumed run's own (deliberately fire-and-forget) write of a fresh entry.
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
    await vi.waitFor(() => expect(order).toContain(`wake`));

    // The spent attempt lands first; the resumed run's own entry (carrying the same spent count) follows.
    expect(order[0]).toBe(`record:attempts=1`);
    expect(order.indexOf(`record:attempts=1`)).toBeLessThan(order.indexOf(`wake`));
});

test("an entry whose attempt is already spent is dropped WITHOUT running — no boot loop on a turn that kills the daemon", async () => {
    const services = await journalServices(mkdtempSync(join(tmpdir(), "restart-")));
    await services.turnJournal.recordTurn(journalled("rs-spent", { attempts: 1 }));
    const prompts: string[] = [];
    await resumeInterruptedTurns(services, fakeWake(prompts), BOOT_AT);
    expect(prompts).toEqual([]);
    expect(await services.turnJournal.list()).toEqual([]);
});

test("an entry older than the staleness cap is dropped — a sandbox off for the weekend must not wake mid-thought", async () => {
    const services = await journalServices(mkdtempSync(join(tmpdir(), "restart-")));
    await services.turnJournal.recordTurn(journalled("rs-stale"));
    const prompts: string[] = [];
    await resumeInterruptedTurns(services, fakeWake(prompts), 10_000 + 7 * 60 * 60_000);
    expect(prompts).toEqual([]);
    expect(await services.turnJournal.list()).toEqual([]);
});

test("autoResumeOnRestart off records the interruption and re-runs nothing", async () => {
    // Off is the shipped default (SandboxSettingsSchema), so this is what an owner who never opened the setting
    // gets: the journal is drained and the interruption stands on the record, but nothing spends a turn.
    const services = await journalServices(mkdtempSync(join(tmpdir(), "restart-")), false);

    await services.turnJournal.recordTurn(journalled("rs-off"));
    await services.automations.upsert({ id: "nightly", trigger: { kind: "schedule", cron: "* * * * *" }, prompt: "sweep", enabled: true });
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
    // Nothing re-ran, but nothing is silently lost either: the row still says the fire was cut off.
    expect((await services.automations.get("nightly"))?.runs[0]).toMatchObject({ outcome: "interrupted" });
});

test("an interrupted fire records `interrupted`, then re-fires with its snapshotted payload through the guard", async () => {
    const services = await journalServices(mkdtempSync(join(tmpdir(), "restart-")));
    // The guard passes only because the payload reached it — proof the re-fire runs the real gate, not around it.
    await services.automations.upsert({
        id: "hook",
        trigger: { kind: "event", token: "t" },
        guard: `test "$AUTOMATION_PAYLOAD" = "ping"`,
        prompt: "handle it",
        enabled: true,
    });
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
    await vi.waitFor(async () => expect((await services.automations.get("hook"))?.runs).toHaveLength(2));

    const runs = (await services.automations.get("hook"))?.runs ?? [];
    // Newest first: the completed re-fire sits above the interrupted record of the fire it replaced.
    expect(runs[0]?.outcome).toBe("completed");
    expect(runs[1]?.outcome).toBe("interrupted");
    expect(runs.map((run) => run.conversationId)).toEqual(["a-hook-1", "a-hook-1"]);
    // The re-fire re-reads the automation's own prompt and carries the payload the entry snapshotted.
    expect(prompts).toEqual(["handle it\n\n--- Event payload ---\nping"]);
});

test("a re-fire skips the approval gate — the wake was already past it when the daemon died", async () => {
    const services = await journalServices(mkdtempSync(join(tmpdir(), "restart-")));
    await services.automations.upsert({
        id: "gated",
        trigger: { kind: "schedule", cron: "* * * * *" },
        prompt: "sweep",
        requireApproval: true,
        enabled: true,
    });
    await services.turnJournal.recordFire({ kind: "automation", automationId: "gated", conversationId: "a-gated-1", startedAt: 10_000, attempts: 0 });

    const prompts: string[] = [];
    await resumeInterruptedTurns(services, fakeWake(prompts), BOOT_AT);
    await vi.waitFor(() => expect(prompts).toEqual(["sweep"]));
    // Re-holding it would ask a question the owner has already answered.
    expect(await services.approvals.list()).toEqual([]);
});

test("an entry for an automation since deleted or disabled is consumed, not left to invent a run on every boot", async () => {
    const services = await journalServices(mkdtempSync(join(tmpdir(), "restart-")));
    await services.automations.upsert({ id: "off", trigger: { kind: "schedule", cron: "* * * * *" }, prompt: "sweep", enabled: false });
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

test("an empty journal is a no-op — a clean shutdown reads the settings for nothing", async () => {
    const services = await journalServices(mkdtempSync(join(tmpdir(), "restart-")));
    const prompts: string[] = [];
    await resumeInterruptedTurns(services, fakeWake(prompts), BOOT_AT);
    expect(prompts).toEqual([]);
});

/* THE REHYDRATION — a turn that was PARKED ON THE USER when the daemon died. Nothing about it is a re-run:
 * the cards go back up as they stood, under their original request ids, and the first token spent after the
 * boot is the user's answer starting the real resumed turn. The registry stub is the placeholder's whole
 * surface area — begin/observe/finish — so what these tests read from `observed` is exactly what the fleet
 * and every attached window would have been shown. autoResumeOnRestart stays OFF here on purpose: it gates
 * unattended re-runs that spend tokens, and rehydration must not answer to it. */
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

// The rehydrated cards are up once their frames have folded through registry observe — the same moment the
// fleet lights `awaiting` and an attached window renders them live.
const cardsUp = async (observed: AgentEvent[], kind: ParkedCard["kind"]): Promise<void> => {
    await vi.waitFor(() => expect(observed.map((event) => event.kind)).toContain(kind));
};

test("a parked turn is rehydrated at boot — the cards go back up as they stood, and nothing runs until the user answers", async () => {
    const { services, observed, resuming } = await parkedServices(mkdtempSync(join(tmpdir(), "parked-")));
    await services.turnJournal.recordTurn(parkedEntry("pk-up", [planCard("r-up")]));
    const prompts: string[] = [];
    await resumeInterruptedTurns(services, fakeWake(prompts), BOOT_AT);
    await cardsUp(observed, "plan");

    // The session first — it re-binds the conversation to the partial work the answer will continue — then the
    // card VERBATIM: same request id, same text, so a replayed frame and a saved answer draft still match.
    expect(observed[0]).toEqual({ kind: "session", sessionId: "s-parked" });
    expect(observed[1]).toEqual(planCard("r-up"));
    // No provider ran and nothing was spent: the boot's whole cost is the frames above.
    expect(prompts).toEqual([]);
    // And the park re-journals through the ordinary frame loop, so a SECOND restart rehydrates it again.
    await vi.waitFor(async () => {
        const [entry] = await services.turnJournal.list();
        expect(entry?.kind === "turn" ? (entry.parked ?? []).map((card) => card.requestId) : []).toEqual(["r-up"]);
    });

    // Stop works on the rehydrated park like on any live turn: the cards freeze cancelled — resolved WITHOUT a
    // reply — and nothing resumes. The journal entry drains with the settled turn, as any settled turn's does.
    expect(stopTurn("pk-up")).toBe(true);
    await settle("pk-up");
    expect(observed).toContainEqual({ kind: "resolved", requestId: "r-up" });
    expect(prompts).toEqual([]);
    expect(resuming).toEqual([]);
    await vi.waitFor(async () => expect(await services.turnJournal.list()).toEqual([]));
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

    expect(resolveRequest({ kind: "plan", requestId: "r-plan", approve: true })).toBe(true);
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    // The answer is the prompt, behind the note that says the words are the user's response — not a repeat of
    // the original request, which the session already holds.
    expect(prompts[0]?.startsWith(RESUME_NOTES.answered)).toBe(true);
    expect(prompts[0]).toContain("approved the plan");
    // On the journalled session, in POST_PLAN_MODE — "the sandbox restarted in between" must not cost the user
    // a permission prompt per tool that a live approval would have spared them.
    expect(inputs[0]).toMatchObject({ conversationId: "pk-plan", sessionId: "s-parked", permissionMode: "bypassPermissions" });
    // The mode frame moved any attached window's chip out of planning, as the live gate does...
    expect(observed.map((event) => event.kind)).toContain("mode");
    // ...and `resuming` held the card out of Finished for the blink between placeholder and resumed turn.
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

    expect(resolveRequest({ kind: "plan", requestId: "r-rej", approve: false, feedback: "Use pnpm, not npm." })).toBe(true);
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    expect(prompts[0]).toContain("Use pnpm, not npm.");
    expect(inputs[0]).toMatchObject({ permissionMode: "plan" });
    await settle("pk-rej");
});

test("answering the restored question resumes with the picks, worded as a live answer is", async () => {
    const { services, observed } = await parkedServices(mkdtempSync(join(tmpdir(), "parked-")));
    await services.turnJournal.recordTurn(parkedEntry("pk-q", [questionCard("r-q")]));
    const prompts: string[] = [];
    await resumeInterruptedTurns(services, fakeWake(prompts), BOOT_AT);
    await cardsUp(observed, "question");

    expect(resolveRequest({ kind: "question", requestId: "r-q", answers: { "Deploy now?": ["Yes"] } })).toBe(true);
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    // formatAnswers' own wording — the model reads ONE shape of answer whichever side of a restart it lands on.
    expect(prompts[0]).toContain("The user answered:");
    expect(prompts[0]).toContain("Deploy: Yes");
    await settle("pk-q");
});

test("dismissing the restored question ends the turn quietly, exactly as a live dismissal does", async () => {
    const { services, observed, resuming } = await parkedServices(mkdtempSync(join(tmpdir(), "parked-")));
    await services.turnJournal.recordTurn(parkedEntry("pk-dis", [questionCard("r-dis")]));
    const prompts: string[] = [];
    await resumeInterruptedTurns(services, fakeWake(prompts), BOOT_AT);
    await cardsUp(observed, "question");

    expect(resolveRequest({ kind: "question", requestId: "r-dis", cancelled: true })).toBe(true);
    await settle("pk-dis");
    expect(prompts).toEqual([]);
    expect(resuming).toEqual([]);
    await vi.waitFor(async () => expect(await services.turnJournal.list()).toEqual([]));
});

test("allowing the restored permission resumes the turn told to run the tool", async () => {
    const { services, observed } = await parkedServices(mkdtempSync(join(tmpdir(), "parked-")));
    await services.turnJournal.recordTurn(parkedEntry("pk-allow", [permissionCard("r-allow")]));
    const prompts: string[] = [];
    await resumeInterruptedTurns(services, fakeWake(prompts), BOOT_AT);
    await cardsUp(observed, "permission");

    expect(resolveRequest({ kind: "permission", requestId: "r-allow", decision: "once" })).toBe(true);
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    expect(prompts[0]?.startsWith(RESUME_NOTES.answered)).toBe(true);
    expect(prompts[0]).toContain("The user allowed Bash");
    await settle("pk-allow");
});

test("denying the restored permission with feedback resumes as a redirection; a bare deny ends the turn", async () => {
    const { services, observed } = await parkedServices(mkdtempSync(join(tmpdir(), "parked-")));
    await services.turnJournal.recordTurn(parkedEntry("pk-redir", [permissionCard("r-redir")]));
    const prompts: string[] = [];
    await resumeInterruptedTurns(services, fakeWake(prompts), BOOT_AT);
    await cardsUp(observed, "permission");
    expect(resolveRequest({ kind: "permission", requestId: "r-redir", decision: "deny", feedback: "Read the file instead." })).toBe(true);
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    expect(prompts[0]).toContain("Read the file instead.");
    await settle("pk-redir");

    // The bare deny is the user pulling the plug (the client stops the turn on it, as live): nothing resumes.
    const bare = await parkedServices(mkdtempSync(join(tmpdir(), "parked-")));
    await bare.services.turnJournal.recordTurn(parkedEntry("pk-bare", [permissionCard("r-bare")]));
    const barePrompts: string[] = [];
    await resumeInterruptedTurns(bare.services, fakeWake(barePrompts), BOOT_AT);
    await cardsUp(bare.observed, "permission");
    expect(resolveRequest({ kind: "permission", requestId: "r-bare", decision: "deny" })).toBe(true);
    await settle("pk-bare");
    expect(barePrompts).toEqual([]);
    expect(bare.resuming).toEqual([]);
});

test("one answer resumes a turn parked on several cards — the others freeze cancelled", async () => {
    const { services, observed } = await parkedServices(mkdtempSync(join(tmpdir(), "parked-")));
    await services.turnJournal.recordTurn(parkedEntry("pk-multi", [questionCard("r-mq"), permissionCard("r-mp")]));
    const prompts: string[] = [];
    await resumeInterruptedTurns(services, fakeWake(prompts), BOOT_AT);
    await cardsUp(observed, "permission");

    expect(resolveRequest({ kind: "permission", requestId: "r-mp", decision: "once" })).toBe(true);
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    expect(prompts[0]).toContain("The user allowed Bash");
    // The question the user did not answer froze cancelled — no reply on its resolved frame — and the resumed
    // turn re-asks what it still needs.
    expect(observed).toContainEqual({ kind: "resolved", requestId: "r-mq" });
    await settle("pk-multi");
});

test("rehydration answers to none of the resume gates — spent, stale and toggle-off all still restore the card", async () => {
    // The entry is far past the staleness cap AND its attempt budget is spent AND autoResumeOnRestart is off
    // (parkedServices' default): every gate that stops a re-RUN. An unanswered question does not go stale, and
    // restoring it spends nothing — the card comes back anyway.
    const { services, observed } = await parkedServices(mkdtempSync(join(tmpdir(), "parked-")));
    await services.turnJournal.recordTurn(parkedEntry("pk-gates", [questionCard("r-gates")], { attempts: 1, startedAt: 0 }));
    const prompts: string[] = [];
    await resumeInterruptedTurns(services, fakeWake(prompts), 10_000 + 7 * 60 * 60_000);
    await cardsUp(observed, "question");
    expect(prompts).toEqual([]);

    stopTurn("pk-gates");
    await settle("pk-gates");
});
