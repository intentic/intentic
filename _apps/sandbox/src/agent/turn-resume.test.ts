import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountUsage, AgentEvent } from "@intentic/sandbox-contract";
import { expect, test, vi } from "vitest";
import type { WakeFn } from "../automations/scheduler.js";
import type { Services } from "../composition.js";
import { fileSandboxSettingsStore } from "../settings/settings-store.js";
import { OUTAGE_MAX_ATTEMPTS, recordProviderFailure, recordProviderSuccess } from "./provider-health.js";
import {
    accountLimitReset,
    clearPendingResume,
    createTurnResumeScheduler,
    type LimitHit,
    pendingLimitHit,
    pendingOutageFailure,
    recordAuthFailure,
    recordLimitHit,
    recordOutageFailure,
    RESUME_DELAY_MS,
    resumeTurnOf,
} from "./turn-resume.js";

// The scheduler touches settings/push/logger (and accountLimitReset reads claudeUsage); the fake stays that small.
const fakeServices = (root: string, usage: Record<string, AccountUsage> = {}): Services =>
    ({
        sandboxSettings: fileSandboxSettingsStore(join(root, "settings.json")),
        claudeUsage: { read: async () => usage },
        pushSender: { notifyIfAway: async () => {} },
        logger: { info: () => {}, warn: () => {}, error: () => {} },
    }) as unknown as Services;

const fakeWake = (prompts: string[], events: AgentEvent[] = [{ kind: "done" }]): WakeFn =>
    async function* (_services, input) {
        prompts.push(input.prompt);
        yield* events;
    };

const hit = (conversationId: string, extra: Partial<LimitHit> = {}): LimitHit => ({
    input: { prompt: "finish the report", conversationId, isolated: true },
    resetsAt: 1_000,
    ...extra,
});

// The instant the scheduler's gate opens for a resetsAt of 1_000 (epoch seconds → ms, plus the fire delay).
const DUE_AT = 1_000 * 1000 + RESUME_DELAY_MS;

test("resumeTurnOf repeats the original request under the resume note and returns to the failed turn's session", () => {
    const turn = resumeTurnOf(
        hit("lr-shape", {
            sessionId: "s-latest",
            input: { prompt: "finish the report", conversationId: "lr-shape", sessionId: "s-old", history: [{ role: "user", text: "hi" }] },
        }),
    );
    expect(turn.prompt).toContain("usage limit");
    expect(turn.prompt).toContain("finish the report");
    // The stream's latest session wins over the one the client sent, and a resumed session needs no history seed.
    expect(turn.sessionId).toBe("s-latest");
    expect(turn.history).toBeUndefined();

    // Re-wrapping a resume that ALSO died on the limit must not stack a second note.
    const again = resumeTurnOf(hit("lr-shape", { input: { prompt: turn.prompt, conversationId: "lr-shape" } }));
    expect(again.prompt).toBe(turn.prompt);
});

test("an account override points the resume at the other allowance, under its own note, session intact", () => {
    const turn = resumeTurnOf(
        hit("lr-switch", { sessionId: "s-live", input: { prompt: "finish the report", conversationId: "lr-switch", account: "acct-spent" } }),
        "acct-b",
    );
    // The switch wording, not the reset wording — the model should know it is riding a fresh allowance.
    expect(turn.prompt).toContain("different account");
    expect(turn.prompt).toContain("finish the report");
    expect(turn.account).toBe("acct-b");
    // Sessions live in the sandbox's store, not the account: the partial work continues under the new credential.
    expect(turn.sessionId).toBe("s-live");

    // Cross-note dedup: a switched resume that ALSO dies on the limit and then resumes by reset (or vice
    // versa) must not stack the other road's note on top.
    const again = resumeTurnOf(hit("lr-switch", { input: { prompt: turn.prompt, conversationId: "lr-switch" } }));
    expect(again.prompt).toBe(turn.prompt);
});

test("with no session anywhere, the history seed rides the resume unchanged", () => {
    const turn = resumeTurnOf(hit("lr-hist", { input: { prompt: "p", conversationId: "lr-hist", history: [{ role: "user", text: "hi" }] } }));
    expect(turn.sessionId).toBeUndefined();
    expect(turn.history).toEqual([{ role: "user", text: "hi" }]);
});

test("a due resume fires only once the toggle is on, and firing consumes the pending entry", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "turn-resume-")));
    recordLimitHit(hit("lr-fire"), DUE_AT - 1);
    const prompts: string[] = [];
    const scheduler = createTurnResumeScheduler(services, fakeWake(prompts));

    // Toggle off: the reset has passed, but nothing may run — the entry WAITS for the toggle (that is what
    // lets the chat's offer banner arm the very resume that just bounced).
    await scheduler.tick(DUE_AT);
    expect(prompts).toEqual([]);
    expect(pendingLimitHit("lr-fire")).toBeDefined();

    const settings = await services.sandboxSettings.get();
    await services.sandboxSettings.set({ ...settings, autoResumeOnLimit: true });
    await scheduler.tick(DUE_AT);
    await vi.waitFor(() => expect(prompts).toHaveLength(1));
    expect(prompts[0]).toContain("finish the report");
    expect(pendingLimitHit("lr-fire")).toBeUndefined();
});

test("a resume whose window has not reopened yet stays put even with the toggle on", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "turn-resume-")));
    const settings = await services.sandboxSettings.get();
    await services.sandboxSettings.set({ ...settings, autoResumeOnLimit: true });
    recordLimitHit(hit("lr-early"), DUE_AT - RESUME_DELAY_MS);
    const prompts: string[] = [];
    const scheduler = createTurnResumeScheduler(services, fakeWake(prompts));
    await scheduler.tick(DUE_AT - 1);
    expect(prompts).toEqual([]);
    expect(pendingLimitHit("lr-early")).toBeDefined();
    clearPendingResume("lr-early");
});

test("clearPendingResume supersedes a pending resume — the next turn on the conversation owns it now", () => {
    recordLimitHit(hit("lr-clear"));
    clearPendingResume("lr-clear");
    expect(pendingLimitHit("lr-clear")).toBeUndefined();
});

test("an offer nobody enabled goes stale after a day and is dropped", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "turn-resume-")));
    recordLimitHit(hit("lr-stale"), DUE_AT - 25 * 60 * 60_000);
    const prompts: string[] = [];
    const scheduler = createTurnResumeScheduler(services, fakeWake(prompts));
    await scheduler.tick(DUE_AT);
    expect(prompts).toEqual([]);
    expect(pendingLimitHit("lr-stale")).toBeUndefined();
});

test("accountLimitReset answers with the fullest pool's reset — the one that refused the turn", async () => {
    const usage: Record<string, AccountUsage> = {
        "acct-1": {
            measuredAt: 1,
            windows: [
                { kind: "five_hour", utilization: 40, resetsAt: 2_000 },
                { kind: "seven_day", utilization: 98, resetsAt: 9_000 },
            ],
        },
    };
    const services = fakeServices(mkdtempSync(join(tmpdir(), "turn-resume-")), usage);
    expect(await accountLimitReset(services, "acct-1")).toBe(9_000);
    expect(await accountLimitReset(services, "acct-unknown")).toBeUndefined();
    expect(await accountLimitReset(services, undefined)).toBeUndefined();
});

/* THE AUTH RESUME — the failure a rotation causes and the recovery the user should never have to perform.
 * A rotation retires the token every in-flight turn snapshotted at spawn, so they all die at once with
 * "401 OAuth access token has been revoked"; the fix is to re-mint and re-run, not to wait for a human. */

/* The store as it stands AFTER the rotation that refused the turn: it already holds the successor token, so
 * the resume adopts it without a second refresh. That is the shape of the real failure — the proactive timer
 * rotates, the store moves on, and the in-flight turns are left holding the retired token. */
const fakeStore = (stored: { accessToken: string; revokedAt?: number }) =>
    ({
        read: async () => ({ id: "acct", label: "Claude", connectedAt: 0, refreshToken: "rt", ...stored }),
        write: async () => {},
        clear: async () => {},
        list: async () => [],
        withRefreshLock: async <T>(_id: string, act: () => Promise<T>) => act(),
        logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    }) as unknown as Services["claudeStore"];

const authServices = (root: string, claudeStore: Services["claudeStore"]): Services =>
    ({ ...fakeServices(root), claudeStore }) as unknown as Services;

test("a turn the API refused mid-flight is re-minted and re-run on the next pass", async () => {
    const services = authServices(mkdtempSync(join(tmpdir(), "turn-resume-")), fakeStore({ accessToken: "tok-2" }));
    const prompts: string[] = [];
    recordAuthFailure({ input: { prompt: "finish the report", conversationId: "auth-1", isolated: true }, account: "acct", refusedToken: "tok-1" });
    await createTurnResumeScheduler(services, fakeWake(prompts)).tick();
    expect(prompts).toHaveLength(1);
    // The original request rides again in full, behind a note saying why — a bare "continue" would lose it.
    expect(prompts[0]).toContain("finish the report");
    expect(prompts[0]).toContain("has been renewed");
});

test("no resume when the credential is genuinely dead — the error frame's reconnect prompt is the real fix", async () => {
    // An account already marked revoked (its refresh token was rejected): rotate answers undefined.
    const services = authServices(mkdtempSync(join(tmpdir(), "turn-resume-")), fakeStore({ accessToken: "tok-1", revokedAt: 1 }));
    const prompts: string[] = [];
    recordAuthFailure({ input: { prompt: "finish the report", conversationId: "auth-2", isolated: true }, account: "acct", refusedToken: "tok-1" });
    await createTurnResumeScheduler(services, fakeWake(prompts)).tick();
    expect(prompts).toHaveLength(0);
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

const outageServices = async (root: string, resumeAfterOutage = true): Promise<Services> => {
    const services = fakeServices(root);
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
    expect(prompts).toEqual([]);

    await scheduler.tick(retryAt);
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
    expect(prompts).toEqual([]);

    // Any turn's first content clears the outage (agent.routes.ts calls this) — a user's own message going
    // through, an automation waking, another agent entirely. The stranded turn goes on the very next pass rather
    // than sitting out a wait the provider has already disproved.
    recordProviderSuccess("out-back");
    await scheduler.tick(OUT_NOW + 1);
    expect(prompts).toHaveLength(1);
});

test("with the toggle off the turn is remembered, not resumed — turning it on arms that same turn", async () => {
    const services = await outageServices(mkdtempSync(join(tmpdir(), "turn-resume-")), false);
    const { retryAt } = recordProviderFailure("out-toggle", OUT_NOW);
    recordOutageFailure(outage("toggle-1", "out-toggle"), OUT_NOW);
    const prompts: string[] = [];
    const scheduler = createTurnResumeScheduler(services, fakeWake(prompts));
    await scheduler.tick(retryAt);
    expect(prompts).toEqual([]);
    expect(pendingOutageFailure("toggle-1")).toBeDefined();

    const settings = await services.sandboxSettings.get();
    await services.sandboxSettings.set({ ...settings, resumeAfterOutage: true });
    await scheduler.tick(retryAt);
    expect(prompts).toHaveLength(1);
});

test("a stranded turn nobody resumed within the hour is dropped rather than sprung back to life", async () => {
    const services = await outageServices(mkdtempSync(join(tmpdir(), "turn-resume-")));
    recordOutageFailure(outage("stale-1", "out-stale"), OUT_NOW - 61 * 60_000);
    const prompts: string[] = [];
    await createTurnResumeScheduler(services, fakeWake(prompts)).tick(OUT_NOW);
    expect(prompts).toEqual([]);
    expect(pendingOutageFailure("stale-1")).toBeUndefined();
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
    // The Codex conversation has nothing to wait for: its provider never failed.
    expect(prompts).toHaveLength(1);
    expect(pendingOutageFailure("iso-codex")).toBeUndefined();
    expect(pendingOutageFailure("iso-claude")).toBeDefined();
    clearPendingResume("iso-claude");
});
