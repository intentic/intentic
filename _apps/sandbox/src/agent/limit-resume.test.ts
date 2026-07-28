import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AccountUsage, AgentEvent } from "@intentic/sandbox-contract";
import { expect, test, vi } from "vitest";
import type { WakeFn } from "../automations/scheduler.js";
import type { Services } from "../composition.js";
import { fileSandboxSettingsStore } from "../settings/settings-store.js";
import {
    accountLimitReset,
    clearLimitHit,
    createLimitResumeScheduler,
    type LimitHit,
    pendingLimitHit,
    recordLimitHit,
    RESUME_DELAY_MS,
    resumeTurnOf,
} from "./limit-resume.js";

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
    const turn = resumeTurnOf(hit("lr-shape", { sessionId: "s-latest", input: { prompt: "finish the report", conversationId: "lr-shape", sessionId: "s-old", history: [{ role: "user", text: "hi" }] } }));
    expect(turn.prompt).toContain("usage limit");
    expect(turn.prompt).toContain("finish the report");
    // The stream's latest session wins over the one the client sent, and a resumed session needs no history seed.
    expect(turn.sessionId).toBe("s-latest");
    expect(turn.history).toBeUndefined();

    // Re-wrapping a resume that ALSO died on the limit must not stack a second note.
    const again = resumeTurnOf(hit("lr-shape", { input: { prompt: turn.prompt, conversationId: "lr-shape" } }));
    expect(again.prompt).toBe(turn.prompt);
});

test("with no session anywhere, the history seed rides the resume unchanged", () => {
    const turn = resumeTurnOf(hit("lr-hist", { input: { prompt: "p", conversationId: "lr-hist", history: [{ role: "user", text: "hi" }] } }));
    expect(turn.sessionId).toBeUndefined();
    expect(turn.history).toEqual([{ role: "user", text: "hi" }]);
});

test("a due resume fires only once the toggle is on, and firing consumes the pending entry", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "limit-resume-")));
    recordLimitHit(hit("lr-fire"), DUE_AT - 1);
    const prompts: string[] = [];
    const scheduler = createLimitResumeScheduler(services, fakeWake(prompts));

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
    const services = fakeServices(mkdtempSync(join(tmpdir(), "limit-resume-")));
    const settings = await services.sandboxSettings.get();
    await services.sandboxSettings.set({ ...settings, autoResumeOnLimit: true });
    recordLimitHit(hit("lr-early"), DUE_AT - RESUME_DELAY_MS);
    const prompts: string[] = [];
    const scheduler = createLimitResumeScheduler(services, fakeWake(prompts));
    await scheduler.tick(DUE_AT - 1);
    expect(prompts).toEqual([]);
    expect(pendingLimitHit("lr-early")).toBeDefined();
    clearLimitHit("lr-early");
});

test("clearLimitHit supersedes a pending resume — the next turn on the conversation owns it now", () => {
    recordLimitHit(hit("lr-clear"));
    clearLimitHit("lr-clear");
    expect(pendingLimitHit("lr-clear")).toBeUndefined();
});

test("an offer nobody enabled goes stale after a day and is dropped", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "limit-resume-")));
    recordLimitHit(hit("lr-stale"), DUE_AT - 25 * 60 * 60_000);
    const prompts: string[] = [];
    const scheduler = createLimitResumeScheduler(services, fakeWake(prompts));
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
    const services = fakeServices(mkdtempSync(join(tmpdir(), "limit-resume-")), usage);
    expect(await accountLimitReset(services, "acct-1")).toBe(9_000);
    expect(await accountLimitReset(services, "acct-unknown")).toBeUndefined();
    expect(await accountLimitReset(services, undefined)).toBeUndefined();
});
