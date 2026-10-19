import type { TranscriptRow } from "@intentic/sandbox-contract/events/transcript";
import { STATE_DIR } from "@intentic/constants";
import { waitFor, SETTLES } from "@intentic/testing/bun";
import { createApp } from "../../app.js";
import { clientFor, collect, errorCode } from "../../harness/route-client.testing.js";
import { services } from "../../harness/route-services.testing.js";
import { attachedRows, startedRun } from "../../harness/route-turns.testing.js";
import { createTurnResumeScheduler } from "../run/turn/turn-resume.js";

// Claude's own plan gate raises its card without a conversation id. Its reply used to reach the runtime while the
// route's conversation lookup found no run to record the feedback on, leaving the words only in input recall.
test.each([false, true])("keeps plan feedback through auth recovery and a usage limit (card bound: %p)", async (bound) => {
    const conversationId = `plan-feedback-${bound}`;
    const attachment = `${STATE_DIR}/records/artifacts/attachments/a1/shot.png`;
    const feedback = `Plan is decent, but evaluate the approach yourself.\n@${attachment}`;
    let raised!: (id: string) => void;
    const card = new Promise<string>((resolve) => (raised = resolve));
    let answered!: () => void;
    const delivered = new Promise<void>((resolve) => (answered = resolve));
    let release!: () => void;
    const failing = new Promise<void>((resolve) => (release = resolve));
    let attempt = 0;
    let token = "before-renewal";
    const saved: TranscriptRow[] = [];
    const daemon = services({
        claudeStore: { read: async (id) => ({ id, label: "Claude", connectedAt: 0, accessToken: token }) },
        async *agent(request) {
            attempt += 1;
            if (attempt === 1) {
                yield { kind: "session", sessionId: "plan-session" };
                yield { kind: "delta", text: "Here is the plan." };
                const { id, wait } = request.hooks.cards.create(
                    "plan",
                    { kind: "plan", requestId: "", approve: false },
                    bound ? request.spec.conversationId : undefined,
                );
                yield { kind: "plan", requestId: id, text: "1. Ship the fix" };
                raised(id);
                const { reply, resolved } = await wait(request.signal);
                expect(reply).toEqual({ kind: "plan", requestId: id, approve: false, feedback });
                yield resolved;
                answered();
                await failing;
                yield { kind: "error", code: "claude-token-refused", message: "OAuth token revoked." };
            } else {
                yield { kind: "error", code: "rate_limit", message: "Claude usage limit reached." };
            }
            yield { kind: "done" };
        },
    });
    jest.spyOn(daemon.transcripts, "append").mockImplementation(async (_agent, rows) => {
        saved.push(...structuredClone(rows));
    });
    jest.spyOn(daemon.transcripts, "read").mockImplementation(async () => structuredClone(saved));
    const client = clientFor(createApp(daemon));
    const run = await startedRun(client, { prompt: "plan the fix", conversationId });
    const requestId = await card;
    const following = collect(await client.agent.attach({ conversationId, run }));

    try {
        expect(await client.agent.reply({ kind: "plan", requestId, approve: false, feedback })).toEqual({ ok: true });
        await delivered;
        // A second window opening the live turn sees the words before the provider has answered or failed.
        const live = await client.agent.attach({ conversationId, run });
        try {
            const head = await live.next();
            expect(head.value).toMatchObject({
                kind: "attached",
                rows: expect.arrayContaining([
                    {
                        role: "user",
                        text: feedback,
                        sentAt: expect.any(Number),
                        attachments: [attachment],
                        run,
                    },
                ]),
            });
        } finally {
            await live.return();
        }
    } finally {
        release();
        await following;
    }

    const rows = attachedRows(await following);
    expect(rows.map(({ role, text }) => ({ role, text }))).toEqual([
        { role: "user", text: "plan the fix" },
        { role: "assistant", text: "Here is the plan." },
        { role: "notice", text: "Kept planning." },
        { role: "user", text: feedback },
        { role: "notice", text: "OAuth token revoked. The credential is being renewed and this turn continues automatically." },
    ]);
    await waitFor(() => expect(saved).toEqual(rows), SETTLES);
    expect(await errorCode(client.agent.reply({ kind: "plan", requestId, approve: false, feedback }))).toBe("NOT_FOUND");

    // The same recovery the resume pass performs after another process renewed the refused credential.
    token = "after-renewal";
    await createTurnResumeScheduler(daemon).tick();
    await waitFor(() => expect(attempt).toBe(2), SETTLES);
    const retry = attachedRows(await collect(await client.agent.attach({ conversationId })));
    expect(retry.map(({ role, text }) => ({ role, text }))).toEqual([
        { role: "notice", text: "Claude sign-in renewed, this turn picked up where it left off." },
        { role: "notice", text: "Claude usage limit reached." },
    ]);
    await waitFor(() => expect(saved.at(-1)?.text).toBe("Claude usage limit reached."), SETTLES);
    expect(saved.filter((row) => row.text === feedback)).toEqual(rows.slice(3, 4));
    expect(saved.filter((row) => row.role === "user").map((row) => row.text)).toEqual(["plan the fix", feedback]);
});
