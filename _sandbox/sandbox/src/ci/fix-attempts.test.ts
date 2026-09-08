import { type AgentSummary, type AgentTurn, ciFixConversationId, fixAttemptId } from "@intentic/sandbox-contract";
import { expect, test, vi } from "vitest";
import { type FixAttemptDeps, startFixAttempt } from "./fix-attempts.js";

const NO_ATTENTION = { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false };
const BASE = ciFixConversationId("web", 41);

const agent = (id: string, over: Partial<AgentSummary> = {}): AgentSummary => ({
    id,
    status: "running",
    provider: "claude",
    harness: "native",
    attention: { ...NO_ATTENTION },
    updatedAt: 1_000,
    ...over,
});

// The doors, faked in order: every call is logged so a case can assert not just what happened but in what sequence.
// `taken` is a conversation a live turn already owns, which `start` reports as undefined.
const fakes = (roster: AgentSummary[] = [], archived: string[] = [], options: { readonly taken?: boolean } = {}) => {
    const calls: string[] = [];
    const started: (AgentTurn & { conversationId: string })[] = [];
    const deps: FixAttemptDeps = {
        roster: () => roster,
        archivedIds: () => archived,
        stop: vi.fn(async (id: string) => void calls.push(`stop ${id}`)),
        archive: vi.fn(async (id: string) => void calls.push(`archive ${id}`)),
        start: vi.fn(async (turn: AgentTurn & { conversationId: string }) => {
            calls.push(`start ${turn.conversationId}`);
            started.push(turn);
            return options.taken === true ? undefined : { run: true };
        }),
    };
    return { deps, calls, started };
};

const ASK = {
    base: BASE,
    prompt: "The CI pipeline failed. Investigate and fix it.",
    nudge: "Carry on from where you left off.",
    title: "Fix CI: build broke",
    turn: { isolated: true as const, unattended: true as const, runRole: "pipeline-fix" as const },
};

test("with nobody on the failure, the press opens attempt 1 with the opening prompt and its title", async () => {
    const { deps, started } = fakes();
    const outcome = await startFixAttempt(deps, ASK);
    expect(outcome).toEqual({ kind: "started", conversationId: BASE, attempt: 1, continued: false });
    expect(started[0]).toMatchObject({
        conversationId: BASE,
        prompt: ASK.prompt,
        title: ASK.title,
        isolated: true,
        runRole: "pipeline-fix" as const,
    });
});

// The complaint this exists for: a second press used to re-send the opening prompt into the same session.
test("an attempt that ended is continued with the nudge, keeping its title", async () => {
    const { deps, started, calls } = fakes([agent(BASE, { status: "error", failure: "no capacity" })]);
    const outcome = await startFixAttempt(deps, ASK);
    expect(outcome).toEqual({ kind: "started", conversationId: BASE, attempt: 1, continued: true });
    expect(started[0]).toMatchObject({ conversationId: BASE, prompt: ASK.nudge });
    expect(started[0]).not.toHaveProperty("title");
    expect(calls).toEqual([`start ${BASE}`]);
});

// Stop before archive, since the archive refuses a running conversation; then the next number, past the archive.
test("start over stops the running attempt, files it away, and opens the next under its number", async () => {
    const { deps, started, calls } = fakes([agent(BASE, { status: "running" })]);
    const outcome = await startFixAttempt(deps, { ...ASK, resume: "start-over" });
    const second = fixAttemptId(BASE, 2);
    expect(outcome).toEqual({ kind: "started", conversationId: second, attempt: 2, continued: false });
    expect(calls).toEqual([`stop ${BASE}`, `archive ${BASE}`, `start ${second}`]);
    expect(started[0]).toMatchObject({ prompt: ASK.prompt, title: `${ASK.title} (attempt 2)` });
});

test("an attempt already archived is skipped over rather than resurrected", async () => {
    const { deps } = fakes([], [BASE, fixAttemptId(BASE, 2)]);
    const outcome = await startFixAttempt(deps, ASK);
    expect(outcome).toMatchObject({ conversationId: fixAttemptId(BASE, 3), attempt: 3 });
});

test("a landed attempt is history: the same run red again gets a fresh attempt", async () => {
    const { deps } = fakes([agent(BASE, { status: "landed" })]);
    expect(await startFixAttempt(deps, ASK)).toMatchObject({ kind: "started", conversationId: fixAttemptId(BASE, 2), continued: false });
});

test("an attempt still in play is busy, in the stance's own words, and nothing is started", async () => {
    const { deps, calls } = fakes([agent(BASE, { status: "awaiting", attention: { ...NO_ATTENTION, question: true } })]);
    const outcome = await startFixAttempt(deps, ASK);
    expect(outcome).toMatchObject({ kind: "busy", conversationId: BASE, reason: expect.stringContaining("asked you something") });
    expect(calls).toEqual([]);
});

// The plan can be beaten to the conversation by a turn that began between the roster read and the start.
test("a start that finds a live turn already on the conversation reports busy", async () => {
    const { deps } = fakes([], [], { taken: true });
    expect(await startFixAttempt(deps, ASK)).toMatchObject({ kind: "busy", conversationId: BASE });
});

test("a title that would overrun the registry's cap is cut, number and all", async () => {
    const { deps, started } = fakes([agent(BASE, { status: "stopped" })]);
    await startFixAttempt(deps, { ...ASK, title: `Fix CI: ${"x".repeat(90)}`, resume: "start-over" });
    expect((started[0]?.title ?? "").length).toBeLessThanOrEqual(80);
});
