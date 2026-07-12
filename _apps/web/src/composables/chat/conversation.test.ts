import type { AgentEvent } from "@intentic/sandbox-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ChatMessage, Conversation, transcriptOf, turnDefaults } from "./conversation";

vi.mock("../sandboxClient", () => ({ sandboxRequest: vi.fn() }));
const { sandboxRequest } = await import("../sandboxClient");
const sandboxRequestMock = vi.mocked(sandboxRequest);

// The grok-model-invalid self-heal dynamically imports useChat to reload the live catalog; stub it so the test
// doesn't pull in the whole useChat module (router/sandbox side effects) — the reload itself isn't under test here.
vi.mock("./useChat", () => ({ loadGrokModels: async () => {} }));

// The typewriter drains via requestAnimationFrame; run frames synchronously so deltas land immediately.
beforeEach(() => {
    vi.stubGlobal(`requestAnimationFrame`, (callback: FrameRequestCallback): number => {
        callback(0);
        return 0;
    });
    vi.stubGlobal(`cancelAnimationFrame`, () => {});
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    // turnDefaults is a module singleton; reset the per-provider memory so tests stay order-independent.
    // Grok's default is loaded live (empty until then); a fresh test env has no loaded catalog.
    turnDefaults.models.value = { claude: `opus`, codex: ``, grok: `` };
    turnDefaults.provider.value = `claude`;
});

// An SSE body streaming one `data:` frame per event, closed at the end (as the daemon's /agent responds).
// Aborting the request errors the stream, mirroring fetch cancellation.
const sseResponse = (events: AgentEvent[], options?: { stayOpen?: boolean }): ((path: string, init?: RequestInit) => Promise<Response>) => {
    return (path, init) => {
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                const encoder = new TextEncoder();
                for (const event of events) {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
                }
                if (!options?.stayOpen) {
                    controller.close();
                    return;
                }
                init?.signal?.addEventListener(`abort`, () => {
                    controller.error(new DOMException(`aborted`, `AbortError`));
                });
            },
        });
        return Promise.resolve({ ok: true, body } as Response);
    };
};

const settings = { agent: `claude`, account: undefined, model: `opus`, effort: `high`, thinking: false } as const;

describe(`Conversation`, () => {
    it(`streams deltas into the assistant bubble and captures session, model, and title`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(
            sseResponse([
                { kind: `session`, sessionId: `s-1` },
                { kind: `init`, model: `claude-opus` },
                { kind: `delta`, text: `Hello ` },
                { kind: `delta`, text: `world` },
                { kind: `done` },
            ]),
        );

        await conversation.send(`Hi there`, settings);

        expect(conversation.messages.value).toHaveLength(2);
        expect(conversation.messages.value[0]).toMatchObject({ role: `user`, text: `Hi there` });
        expect(conversation.messages.value[1]).toMatchObject({ role: `assistant`, text: `Hello world` });
        expect(conversation.session.value).toEqual({ id: `s-1`, provider: `claude`, account: undefined });
        expect(conversation.activeModel.value).toBe(`claude-opus`);
        expect(conversation.title.value).toBe(`Hi there`);
        expect(conversation.streaming.value).toBe(false);
    });

    it(`replays the captured session id on the next turn and omits it on the first`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `session`, sessionId: `s-1` }]));
        await conversation.send(`first`, settings);
        await conversation.send(`second`, settings);

        const firstBody = JSON.parse(sandboxRequestMock.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
        const secondBody = JSON.parse(sandboxRequestMock.mock.calls[1]![1]!.body as string) as Record<string, unknown>;
        expect(`sessionId` in firstBody).toBe(false);
        expect(secondBody[`sessionId`]).toBe(`s-1`);
    });

    it(`switches provider mid-conversation: retires the session and seeds the new runtime with the transcript`, async () => {
        const conversation = new Conversation(`c1`);
        // The selection and the turn settings move together (useChat builds settings from the selection).
        conversation.selectProvider(`codex`);
        sandboxRequestMock.mockImplementation(
            sseResponse([
                { kind: `session`, sessionId: `thr-1` },
                { kind: `delta`, text: `sure` },
            ]),
        );
        await conversation.send(`first`, { ...settings, agent: `codex`, model: `` });
        const firstBody = JSON.parse(sandboxRequestMock.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
        expect(firstBody[`agent`]).toBe(`codex`);
        // Codex's ChatGPT-account auth rejects a named model — an empty selection is omitted from the wire.
        expect(`model` in firstBody).toBe(false);

        conversation.selectProvider(`claude`);
        expect(conversation.messages.value.at(-1)!.role).toBe(`notice`);

        // A Codex thread must not resume as a Claude session: the switched turn drops the session id and
        // carries the transcript instead (empty bubbles and the switch notice excluded).
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `session`, sessionId: `s-1` }]));
        await conversation.send(`second`, settings);
        const secondBody = JSON.parse(sandboxRequestMock.mock.calls[1]![1]!.body as string) as Record<string, unknown>;
        expect(secondBody[`agent`]).toBe(`claude`);
        expect(`sessionId` in secondBody).toBe(false);
        expect(secondBody[`history`]).toEqual([
            { role: `user`, text: `first` },
            { role: `assistant`, text: `sure` },
        ]);

        // The new runtime's session is captured with its own provider; the next turn resumes it, history-free.
        expect(conversation.session.value).toMatchObject({ id: `s-1`, provider: `claude` });
        await conversation.send(`third`, settings);
        const thirdBody = JSON.parse(sandboxRequestMock.mock.calls[2]![1]!.body as string) as Record<string, unknown>;
        expect(thirdBody[`sessionId`]).toBe(`s-1`);
        expect(`history` in thirdBody).toBe(false);
    });

    it(`switching away and back before sending keeps the session and removes the notice`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `session`, sessionId: `s-1` }]));
        await conversation.send(`first`, settings);

        conversation.selectProvider(`grok`);
        expect(conversation.messages.value.at(-1)!.role).toBe(`notice`);
        conversation.selectProvider(`claude`);
        expect(conversation.messages.value.every((message) => message.role !== `notice`)).toBe(true);

        // Browsing the picker never destroyed the session — the next send still resumes it.
        await conversation.send(`second`, settings);
        const secondBody = JSON.parse(sandboxRequestMock.mock.calls[1]![1]!.body as string) as Record<string, unknown>;
        expect(secondBody[`sessionId`]).toBe(`s-1`);
        expect(`history` in secondBody).toBe(false);
    });

    it(`ignores a provider switch while a turn is streaming`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `delta`, text: `x` }], { stayOpen: true }));
        const turn = conversation.send(`go`, settings);
        await vi.waitFor(() => expect(conversation.streaming.value).toBe(true));
        conversation.selectProvider(`grok`);
        expect(conversation.provider.value).toBe(`claude`);
        conversation.stop();
        await turn;
    });

    it(`transcriptOf keeps user/assistant text, folds plan markdown, and drops notices and empty bubbles`, () => {
        const messages: ChatMessage[] = [
            { id: 1, role: `user`, text: `hi` },
            { id: 2, role: `assistant`, text: ``, thinking: `` },
            { id: 3, role: `notice`, text: `Stopped.` },
            { id: 4, role: `assistant`, text: `intro`, plan: { decisionId: `d`, text: `# Plan`, status: `approved` } },
        ];
        expect(transcriptOf(messages)).toEqual([
            { role: `user`, text: `hi` },
            { role: `assistant`, text: `intro\n\n# Plan` },
        ]);
    });

    it(`selectProvider re-scopes model + effort and prevents a Claude alias reaching Codex`, async () => {
        const conversation = new Conversation(`c1`);
        // Seeded from the Claude defaults.
        expect(conversation.provider.value).toBe(`claude`);
        expect(conversation.model.value).toBe(`opus`);

        // Pick a Claude alias + a Claude-only effort, then switch to Codex: the alias clears to the account
        // default ('') and 'max' is clamped — so no Claude model can ride a Codex turn.
        conversation.model.value = `haiku`;
        conversation.effort.value = `max`;
        conversation.selectProvider(`codex`);
        expect(conversation.provider.value).toBe(`codex`);
        expect(conversation.model.value).toBe(``);
        expect(conversation.effort.value).toBe(`xhigh`);

        // The turn sends Codex with no model (empty = the account default).
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `session`, sessionId: `thr-1` }]));
        await conversation.send(`hi`, {
            agent: conversation.provider.value,
            account: conversation.account.value,
            model: conversation.model.value,
            effort: conversation.effort.value,
            thinking: false,
        });
        const body = JSON.parse(sandboxRequestMock.mock.calls[0]![1]!.body as string) as Record<string, unknown>;
        expect(body[`agent`]).toBe(`codex`);
        expect(`model` in body).toBe(false);

        // A mid-chat pick switches the selection (no lock) and marks the pending cut with a notice.
        conversation.selectProvider(`claude`);
        expect(conversation.provider.value).toBe(`claude`);
        expect(conversation.messages.value.at(-1)!.role).toBe(`notice`);
    });

    it(`restores the per-provider model when switching provider away and back`, () => {
        // The user picked Haiku for Claude (the composer's model facade persists this per provider).
        turnDefaults.models.value = { ...turnDefaults.models.value, claude: `haiku` };
        const conversation = new Conversation(`c1`);
        conversation.selectProvider(`claude`);
        expect(conversation.model.value).toBe(`haiku`);
        // Codex has no remembered pick → its account default (empty).
        conversation.selectProvider(`codex`);
        expect(conversation.model.value).toBe(``);
        // Back to Claude: the remembered Haiku returns, not the hardcoded Opus.
        conversation.selectProvider(`claude`);
        expect(conversation.model.value).toBe(`haiku`);
    });

    it(`attaches tool output to the matching tool by id and drops results with no match`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(
            sseResponse([
                { kind: `tool`, id: `t1`, name: `Bash`, target: `ls` },
                { kind: `tool_result`, id: `t1`, output: `file.txt`, isError: false },
                { kind: `tool_result`, id: `missing`, output: `dropped` },
            ]),
        );

        await conversation.send(`run it`, settings);

        const assistant = conversation.messages.value[1]!;
        expect(assistant.tools).toEqual([{ id: `t1`, name: `Bash`, target: `ls`, output: `file.txt`, isError: false }]);
    });

    it(`surfaces thinking, todos, and end-of-turn usage on the assistant bubble`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(
            sseResponse([
                { kind: `thinking`, text: `pondering` },
                { kind: `todos`, items: [{ content: `step 1`, status: `in_progress`, activeForm: `Stepping` }] },
                { kind: `delta`, text: `answer` },
                { kind: `usage`, costUsd: 0.5, numTurns: 1 },
            ]),
        );

        await conversation.send(`plan it`, settings);

        const assistant = conversation.messages.value[1]!;
        expect(assistant.thinking).toBe(`pondering`);
        expect(assistant.todos).toEqual([{ content: `step 1`, status: `in_progress`, activeForm: `Stepping` }]);
        expect(assistant.usage).toMatchObject({ costUsd: 0.5, numTurns: 1 });
    });

    it(`parks the turn on a plan card and streams the continuation into a fresh bubble`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(
            sseResponse([
                { kind: `delta`, text: `intro` },
                { kind: `plan`, decisionId: `d1`, text: `the plan` },
                { kind: `delta`, text: `after approval` },
            ]),
        );

        await conversation.send(`make a plan`, settings);

        const [, planMessage, continuation] = conversation.messages.value;
        expect(planMessage).toMatchObject({ text: `intro`, plan: { decisionId: `d1`, text: `the plan`, status: `pending` } });
        expect(continuation).toMatchObject({ role: `assistant`, text: `after approval` });
        expect(conversation.awaitingDecision.value).toBe(true);

        sandboxRequestMock.mockResolvedValue({ ok: true } as Response);
        await conversation.decidePlan(planMessage!, true);
        expect(sandboxRequestMock).toHaveBeenLastCalledWith(`/agent/decision`, expect.objectContaining({ method: `POST` }));
        expect(conversation.messages.value[1]!.plan!.status).toBe(`approved`);
        expect(conversation.messages.value.at(-1)).toMatchObject({ role: `notice`, text: `Plan approved.` });
    });

    it(`parks the turn on a question card and submits answers over the side channel`, async () => {
        const conversation = new Conversation(`c1`);
        const questions = [{ question: `Which?`, header: `Pick`, multiSelect: false, options: [{ label: `A`, description: `a` }] }];
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `question`, requestId: `q1`, questions }]));

        await conversation.send(`ask me`, settings);

        const questionMessage = conversation.messages.value[1]!;
        expect(questionMessage.question).toMatchObject({ requestId: `q1`, status: `pending` });

        sandboxRequestMock.mockResolvedValue({ ok: true } as Response);
        await conversation.answerQuestion(questionMessage, { "Which?": [`A`] });
        expect(sandboxRequestMock).toHaveBeenLastCalledWith(`/agent/answer`, expect.objectContaining({ method: `POST` }));
        expect(conversation.messages.value[1]!.question).toMatchObject({ status: `answered`, answers: { "Which?": [`A`] } });
    });

    it(`surfaces daemon error frames and ignores unfamiliar kinds`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(
            sseResponse([{ kind: `future-thing`, payload: 1 } as unknown as AgentEvent, { kind: `error`, message: `boom` }]),
        );

        await conversation.send(`hi`, settings);

        expect(conversation.error.value).toBe(`boom`);
        expect(conversation.status.value).toBe(`error`);
        // The unknown frame left no trace: just the user message and the (empty) assistant bubble.
        expect(conversation.messages.value).toHaveLength(2);
    });

    it(`self-heals a dead session id: drops it on a session-not-found error and notices instead of erroring`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `session`, sessionId: `s-1` }]));
        await conversation.send(`first`, settings);

        // The sandbox lost the transcript (rebuild before the store persisted, or the session was deleted).
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `error`, code: `session-not-found`, message: `gone` }, { kind: `done` }]));
        await conversation.send(`second`, settings);

        expect(conversation.session.value).toBeUndefined();
        expect(conversation.messages.value.at(-1)!.role).toBe(`notice`);
        expect(conversation.error.value).toBeNull();
        expect(conversation.status.value).not.toBe(`error`);

        // The next send starts fresh — no dead id on the wire, and the replacement session is seeded from the
        // client transcript (empty assistant bubbles and the notice excluded).
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `session`, sessionId: `s-2` }]));
        await conversation.send(`third`, settings);
        const thirdBody = JSON.parse(sandboxRequestMock.mock.calls[2]![1]!.body as string) as Record<string, unknown>;
        expect(`sessionId` in thirdBody).toBe(false);
        expect(thirdBody[`history`]).toEqual([
            { role: `user`, text: `first` },
            { role: `user`, text: `second` },
        ]);
        expect(conversation.session.value).toMatchObject({ id: `s-2`, provider: `claude` });
    });

    it(`self-heals a grok-model-invalid error: clears the pinned model and notices instead of erroring`, async () => {
        const conversation = new Conversation(`c1`);
        conversation.provider.value = `grok`;
        conversation.model.value = `grok-code-fast-1`;
        // xAI rejected the (retired) pinned model id mid-turn.
        sandboxRequestMock.mockImplementation(
            sseResponse([{ kind: `error`, code: `grok-model-invalid`, message: `Model not found: xai/grok-code-fast-1` }, { kind: `done` }]),
        );
        await conversation.send(`hi`, { ...settings, agent: `grok`, model: `grok-code-fast-1` });

        // Self-healed: the pinned model is cleared (so the next send lets the daemon pick a live-valid default),
        // a muted notice, no red error ref, no error status.
        expect(conversation.model.value).toBe(``);
        expect(conversation.messages.value.at(-1)!.role).toBe(`notice`);
        expect(conversation.error.value).toBeNull();
        expect(conversation.status.value).not.toBe(`error`);
    });

    it(`renders a rate_limit error as a muted notice, not the red error ref`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(
            sseResponse([{ kind: `error`, code: `rate_limit`, message: `Claude usage limit reached — try again shortly.` }, { kind: `done` }]),
        );
        await conversation.send(`hello`, settings);

        // The subscription's usage cap is not a crash: a notice, no error ref, no error status.
        expect(conversation.messages.value.at(-1)!.role).toBe(`notice`);
        expect(conversation.messages.value.at(-1)!.text).toContain(`usage limit`);
        expect(conversation.error.value).toBeNull();
        expect(conversation.status.value).not.toBe(`error`);
    });

    it(`stop() records a notice and aborts without surfacing the abort as an error`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `delta`, text: `partial` }], { stayOpen: true }));

        const turn = conversation.send(`long task`, settings);
        await vi.waitFor(() => expect(conversation.messages.value[1]?.text).toBe(`partial`));
        conversation.stop();
        await turn;

        expect(conversation.error.value).toBeNull();
        expect(conversation.streaming.value).toBe(false);
        expect(conversation.messages.value.at(-1)).toMatchObject({ role: `notice`, text: `Stopped.` });
    });

    it(`editAndResend truncates at the edited message, retires the session, and seeds the re-run from the earlier transcript`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(
            sseResponse([
                { kind: `session`, sessionId: `s-1` },
                { kind: `delta`, text: `one` },
                { kind: `context_usage`, tokens: 500, contextWindow: 1000 },
            ]),
        );
        await conversation.send(`first`, settings);
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `delta`, text: `two` }]));
        await conversation.send(`second`, settings);
        const target = conversation.messages.value[2]!; // the second user turn

        sandboxRequestMock.mockImplementation(
            sseResponse([
                { kind: `session`, sessionId: `s-2` },
                { kind: `delta`, text: `redone` },
            ]),
        );
        await conversation.editAndResend(target.id, `second, revised`, settings);

        // Everything from the edited message onward is gone; the edited text is the new turn.
        expect(conversation.messages.value.map((message) => message.text)).toEqual([`first`, `one`, `second, revised`, `redone`]);
        // The retired session never rides the wire — the fresh session is seeded from the pre-cut transcript.
        const body = JSON.parse(sandboxRequestMock.mock.calls[2]![1]!.body as string) as Record<string, unknown>;
        expect(`sessionId` in body).toBe(false);
        expect(body[`history`]).toEqual([
            { role: `user`, text: `first` },
            { role: `assistant`, text: `one` },
        ]);
        expect(conversation.session.value).toMatchObject({ id: `s-2`, provider: `claude` });
        // The retired session's context meter was dropped at the cut (this stream reported none).
        expect(conversation.contextUsage.value).toBeUndefined();
        // The title still names the untouched first turn.
        expect(conversation.title.value).toBe(`first`);
    });

    it(`editAndResend on the first user message clears the transcript and re-derives the title`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(
            sseResponse([
                { kind: `session`, sessionId: `s-1` },
                { kind: `delta`, text: `hi!` },
            ]),
        );
        await conversation.send(`original topic`, settings);
        expect(conversation.title.value).toBe(`original topic`);

        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `session`, sessionId: `s-2` }]));
        await conversation.editAndResend(conversation.messages.value[0]!.id, `new topic`, settings);

        expect(conversation.title.value).toBe(`new topic`);
        // Nothing preceded the cut, so the fresh session starts with neither a session id nor a history seed.
        const body = JSON.parse(sandboxRequestMock.mock.calls[1]![1]!.body as string) as Record<string, unknown>;
        expect(`sessionId` in body).toBe(false);
        expect(`history` in body).toBe(false);
    });

    it(`editAndResend re-sends the original turn's attachments`, async () => {
        const conversation = new Conversation(`c1`);
        const attachments = [{ name: `spec.md`, path: `.intentic/attachments/u1/spec.md` }];
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `session`, sessionId: `s-1` }]));
        await conversation.send(`look at this`, settings, attachments);

        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `session`, sessionId: `s-2` }]));
        await conversation.editAndResend(conversation.messages.value[0]!.id, `look again`, settings);

        const body = JSON.parse(sandboxRequestMock.mock.calls[1]![1]!.body as string) as Record<string, unknown>;
        expect(body[`attachments`]).toEqual([`.intentic/attachments/u1/spec.md`]);
        expect(conversation.messages.value[0]).toMatchObject({ role: `user`, text: `look again`, attachments });
    });

    it(`editAndResend removes a pending switch notice with the discarded tail`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(
            sseResponse([
                { kind: `session`, sessionId: `s-1` },
                { kind: `delta`, text: `sure` },
            ]),
        );
        await conversation.send(`first`, settings);
        conversation.selectProvider(`codex`);
        expect(conversation.messages.value.at(-1)!.role).toBe(`notice`);

        // The edit lands under the switched selection (useChat builds settings from the current picks).
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `session`, sessionId: `thr-1` }]));
        await conversation.editAndResend(conversation.messages.value[0]!.id, `first, revised`, { ...settings, agent: `codex`, model: `` });

        expect(conversation.messages.value.every((message) => message.role !== `notice`)).toBe(true);
        const body = JSON.parse(sandboxRequestMock.mock.calls[1]![1]!.body as string) as Record<string, unknown>;
        expect(body[`agent`]).toBe(`codex`);
        expect(`sessionId` in body).toBe(false);
    });

    it(`editAndResend guards: unknown id, non-user target, empty replacement, and mid-stream are no-ops`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `delta`, text: `answer` }]));
        await conversation.send(`hello`, settings);
        const before = conversation.messages.value;

        await conversation.editAndResend(999, `x`, settings); // unknown id
        await conversation.editAndResend(before[1]!.id, `x`, settings); // assistant bubble, not a user turn
        await conversation.editAndResend(before[0]!.id, `   `, settings); // empty edit, no attachments — must NOT truncate
        expect(conversation.messages.value).toEqual(before);
        expect(sandboxRequestMock).toHaveBeenCalledTimes(1);

        // Mid-stream the rewind is refused outright.
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `delta`, text: `x` }], { stayOpen: true }));
        const turn = conversation.send(`busy`, settings);
        await vi.waitFor(() => expect(conversation.streaming.value).toBe(true));
        await conversation.editAndResend(before[0]!.id, `nope`, settings);
        expect(conversation.messages.value.filter((message) => message.role === `user`).map((m) => m.text)).toEqual([`hello`, `busy`]);
        conversation.stop();
        await turn;
    });

    it(`ignores empty prompts and re-entrant sends while streaming`, async () => {
        const conversation = new Conversation(`c1`);
        await conversation.send(`   `, settings);
        expect(conversation.messages.value).toHaveLength(0);
        expect(sandboxRequestMock).not.toHaveBeenCalled();

        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `delta`, text: `x` }], { stayOpen: true }));
        const turn = conversation.send(`real`, settings);
        await vi.waitFor(() => expect(conversation.streaming.value).toBe(true));
        await conversation.send(`while busy`, settings);
        expect(conversation.messages.value.filter((message) => message.role === `user`)).toHaveLength(1);
        conversation.stop();
        await turn;
    });
});
