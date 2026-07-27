import type { AgentEvent } from "@intentic/sandbox-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ChatMessage, Conversation, transcriptOf, turnDefaults } from "./conversation";
import { usageStatusByAccount } from "./usageStatus";

vi.mock("../sandbox/sandboxClient", () => ({ sandboxRequest: vi.fn() }));
const { sandboxRequest } = await import("../sandbox/sandboxClient");
const sandboxRequestMock = vi.mocked(sandboxRequest);

// A model-invalid error dynamically imports useChat to reload the provider's live catalog; stub it (and spy) so
// the test doesn't pull in the whole useChat module (router/sandbox side effects). vi.hoisted so the spy exists
// when the hoisted vi.mock factory runs.
const { loadProviderModelsMock } = vi.hoisted(() => ({ loadProviderModelsMock: vi.fn(async () => {}) }));
vi.mock("./useChat", () => ({ loadProviderModels: loadProviderModelsMock }));

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

// One `data:` SSE frame, as the daemon's attach stream emits envelopes.
const encoder = new TextEncoder();
const sseFrame = (payload: unknown): Uint8Array => encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);

// The attach head for a run — tests that don't care about the identity fields use the defaults.
const head = (overrides?: Partial<{ run: string; prompt: string; startedAt: number; seq: number }>): Record<string, unknown> => ({
    kind: `attached`,
    run: `r1`,
    prompt: `hi`,
    startedAt: 0,
    seq: 0,
    ...overrides,
});

// Serve the detached-run protocol: POST /agent acks `{ run }` (the turn executes daemon-side), POST
// /agent/attach streams the head, the given events as seq-stamped frames, then `end`; control posts ack ok.
// stayOpen leaves the attach stream open after the frames; aborting the request then errors it, mirroring
// fetch cancellation.
const sseResponse = (events: AgentEvent[], options?: { stayOpen?: boolean }): ((path: string, init?: RequestInit) => Promise<Response>) => {
    return (path, init) => {
        if (path !== `/agent/attach`) {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ run: `r1` }) } as Response);
        }
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(sseFrame(head()));
                events.forEach((event, index) => controller.enqueue(sseFrame({ kind: `frame`, seq: index + 1, event })));
                if (!options?.stayOpen) {
                    controller.enqueue(sseFrame({ kind: `end` }));
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

// A body delivering one chunk per pull, then closing — or erroring, which models a connection that drops
// AFTER the chunks arrived (controller.error inside start() would discard still-queued chunks instead).
const chunkStream = (chunks: unknown[], end: `close` | `error`): ReadableStream<Uint8Array> => {
    let next = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            if (next < chunks.length) {
                controller.enqueue(sseFrame(chunks[next]));
                next += 1;
                return;
            }
            if (end === `close`) {
                controller.close();
            } else {
                controller.error(new TypeError(`network error`));
            }
        },
    });
};

// The parsed bodies of the turn STARTS among the mock's calls — attach/control posts interleave, so tests
// assert on turn inputs through this instead of raw call indexes.
const turnBodies = (): Record<string, unknown>[] =>
    sandboxRequestMock.mock.calls
        .filter(([path]) => path === `/agent`)
        .map(([, init]) => JSON.parse(init!.body as string) as Record<string, unknown>);

const settings = { agent: `claude`, harness: `native`, account: undefined, model: `opus`, effort: `high`, thinking: false } as const;

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
        expect(conversation.session.value).toEqual({ id: `s-1`, provider: `claude`, account: undefined, harness: `native` });
        expect(conversation.activeModel.value).toBe(`claude-opus`);
        expect(conversation.title.value).toBe(`Hi there`);
        expect(conversation.streaming.value).toBe(false);
    });

    it(`replays the captured session id on the next turn and omits it on the first`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `session`, sessionId: `s-1` }]));
        await conversation.send(`first`, settings);
        await conversation.send(`second`, settings);

        const [firstBody, secondBody] = turnBodies();
        expect(`sessionId` in firstBody!).toBe(false);
        expect(secondBody![`sessionId`]).toBe(`s-1`);
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
        const firstBody = turnBodies()[0]!;
        expect(firstBody[`agent`]).toBe(`codex`);
        // Codex's ChatGPT-account auth rejects a named model — an empty selection is omitted from the wire.
        expect(`model` in firstBody).toBe(false);

        conversation.selectProvider(`claude`);
        expect(conversation.messages.value.at(-1)!.role).toBe(`notice`);

        // A Codex thread must not resume as a Claude session: the switched turn drops the session id and
        // carries the transcript instead (empty bubbles and the switch notice excluded).
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `session`, sessionId: `s-1` }]));
        await conversation.send(`second`, settings);
        const secondBody = turnBodies()[1]!;
        expect(secondBody[`agent`]).toBe(`claude`);
        expect(`sessionId` in secondBody).toBe(false);
        expect(secondBody[`history`]).toEqual([
            { role: `user`, text: `first` },
            { role: `assistant`, text: `sure` },
        ]);

        // The new runtime's session is captured with its own provider; the next turn resumes it, history-free.
        expect(conversation.session.value).toMatchObject({ id: `s-1`, provider: `claude` });
        await conversation.send(`third`, settings);
        const thirdBody = turnBodies()[2]!;
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
        const secondBody = turnBodies()[1]!;
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
            { id: 4, role: `assistant`, text: `intro`, plan: { requestId: `d`, text: `# Plan`, status: `approved` } },
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
            harness: conversation.harness.value,
            account: conversation.account.value,
            model: conversation.model.value,
            effort: conversation.effort.value,
            thinking: false,
        });
        const body = turnBodies()[0]!;
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

    it(`merges updates into the matching tool by id and drops updates with no match`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(
            sseResponse([
                { kind: `tool_call`, id: `t1`, name: `Bash`, category: `execute`, status: `in_progress`, target: `ls` },
                // Interim snapshot (live output), then the terminal status — content replaces each time.
                { kind: `tool_call_update`, id: `t1`, content: [{ type: `text`, text: `fi` }] },
                { kind: `tool_call_update`, id: `t1`, status: `completed`, content: [{ type: `text`, text: `file.txt` }] },
                { kind: `tool_call_update`, id: `missing`, status: `completed`, content: [{ type: `text`, text: `dropped` }] },
            ]),
        );

        await conversation.send(`run it`, settings);

        const assistant = conversation.messages.value[1]!;
        expect(assistant.tools).toEqual([
            {
                id: `t1`,
                name: `Bash`,
                category: `execute`,
                status: `completed`,
                target: `ls`,
                content: [{ type: `text`, text: `file.txt` }],
            },
        ]);
    });

    it(`nests a sub-agent's calls and thinking under its Agent card, keeping its prose out of the parent bubble`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(
            sseResponse([
                { kind: `tool_call`, id: `agent1`, name: `Agent`, category: `other`, status: `in_progress`, target: `explore` },
                // Frames produced INSIDE the sub-agent carry the Agent tool's id as their parent.
                { kind: `thinking`, text: `sub-thinking`, parentToolUseId: `agent1` },
                { kind: `delta`, text: `sub prose`, parentToolUseId: `agent1` },
                { kind: `tool_call`, id: `t1`, name: `Read`, category: `read`, status: `in_progress`, parentToolUseId: `agent1` },
                { kind: `tool_call_update`, id: `t1`, status: `completed`, content: [{ type: `text`, text: `contents` }] },
                { kind: `tool_call_update`, id: `agent1`, status: `completed`, content: [{ type: `text`, text: `done` }] },
                { kind: `delta`, text: `main answer` },
            ]),
        );

        await conversation.send(`explore it`, settings);

        const assistant = conversation.messages.value[1]!;
        // The sub-agent's own prose never leaks into the parent bubble — only the main agent's own delta types in.
        expect(assistant.text).toBe(`main answer`);
        expect(assistant.tools).toEqual([
            {
                id: `agent1`,
                name: `Agent`,
                category: `other`,
                status: `completed`,
                target: `explore`,
                thinking: `sub-thinking`,
                children: [{ id: `t1`, name: `Read`, category: `read`, status: `completed`, content: [{ type: `text`, text: `contents` }] }],
                content: [{ type: `text`, text: `done` }],
            },
        ]);
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

    it(`splits a turn's prose at each text_end, so tool cards sit under the block that introduced them`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(
            sseResponse([
                { kind: `delta`, text: `Reading the router.` },
                { kind: `text_end` },
                { kind: `tool_call`, id: `b1`, name: `Bash`, category: `execute`, status: `in_progress`, target: `ls` },
                { kind: `delta`, text: `Found it — fixing.` },
                { kind: `text_end` },
                { kind: `tool_call`, id: `e1`, name: `Edit`, category: `edit`, status: `in_progress`, target: `src/app.ts` },
                { kind: `delta`, text: `Done.` },
                { kind: `text_end` },
                { kind: `usage`, costUsd: 0.3 },
            ]),
        );

        await conversation.send(`fix the router`, settings);

        // One bubble per prose block, each carrying the tools that ran after it — the transcript reads
        // narration → cards → narration instead of every card hoisted above one glued-together paragraph.
        const [, first, second, third] = conversation.messages.value;
        expect(conversation.messages.value).toHaveLength(4);
        expect(first).toMatchObject({ role: `assistant`, text: `Reading the router.` });
        expect(first!.tools).toBeUndefined();
        expect(second).toMatchObject({ role: `assistant`, text: `Found it — fixing.` });
        expect(second!.tools?.map((tool) => tool.id)).toEqual([`b1`]);
        expect(third).toMatchObject({ role: `assistant`, text: `Done.`, usage: { costUsd: 0.3 } });
        expect(third!.tools?.map((tool) => tool.id)).toEqual([`e1`]);
    });

    it(`ignores a text_end that closed no prose, so an empty block leaves no stranded bubble`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(
            sseResponse([
                // An empty text block opened and closed before the model went straight to its first tool.
                { kind: `text_end` },
                { kind: `tool_call`, id: `b1`, name: `Bash`, category: `execute`, status: `in_progress`, target: `ls` },
                { kind: `delta`, text: `Listed them.` },
                { kind: `text_end` },
            ]),
        );

        await conversation.send(`list them`, settings);

        expect(conversation.messages.value).toHaveLength(2);
        expect(conversation.messages.value[1]).toMatchObject({ role: `assistant`, text: `Listed them.` });
        expect(conversation.messages.value[1]!.tools?.map((tool) => tool.id)).toEqual([`b1`]);
    });

    it(`ignores a sub-agent's text_end: its blocks never split the parent turn's bubble`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(
            sseResponse([
                { kind: `tool_call`, id: `agent1`, name: `Agent`, category: `other`, status: `in_progress`, target: `explore` },
                { kind: `delta`, text: `sub prose`, parentToolUseId: `agent1` },
                { kind: `text_end`, parentToolUseId: `agent1` },
                { kind: `delta`, text: `main answer` },
            ]),
        );

        await conversation.send(`explore it`, settings);

        expect(conversation.messages.value).toHaveLength(2);
        expect(conversation.messages.value[1]).toMatchObject({ role: `assistant`, text: `main answer` });
    });

    it(`opens a fresh bubble per turn: a stream carrying several turns splits at each usage boundary`, async () => {
        const conversation = new Conversation(`c1`);
        // A steered conversation's stream carries one turn per queued message; usage is each turn's boundary.
        sandboxRequestMock.mockImplementation(
            sseResponse([
                { kind: `delta`, text: `first answer` },
                { kind: `usage`, costUsd: 0.1 },
                { kind: `thinking`, text: `next` },
                { kind: `delta`, text: `second answer` },
                { kind: `usage`, costUsd: 0.2 },
                { kind: `done` },
            ]),
        );

        await conversation.send(`two things`, settings);

        expect(conversation.messages.value).toHaveLength(3);
        const [, first, second] = conversation.messages.value;
        expect(first).toMatchObject({ role: `assistant`, text: `first answer`, usage: { costUsd: 0.1 } });
        expect(second).toMatchObject({ role: `assistant`, text: `second answer`, thinking: `next`, usage: { costUsd: 0.2 } });
    });

    it(`steers mid-turn: the running answer stays in its bubble above the steered message, the follow-up turn opens below`, async () => {
        const conversation = new Conversation(`c1`);
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({
            start(c) {
                controller = c;
                controller.enqueue(sseFrame(head()));
            },
        });
        sandboxRequestMock.mockImplementation((path: string) => {
            if (path === `/agent`) {
                return Promise.resolve({ ok: true, json: () => Promise.resolve({ run: `r1` }) } as Response);
            }
            return Promise.resolve(path === `/agent/attach` ? ({ ok: true, body } as Response) : ({ ok: true } as Response));
        });
        let seq = 0;
        const emit = (event: AgentEvent): void => controller.enqueue(sseFrame({ kind: `frame`, seq: (seq += 1), event }));

        const turn = conversation.send(`2+3?`, settings);
        await conversation.steer(`2+6?`);

        // The first answer streams AFTER the steer landed — still into the bubble ABOVE the steered message.
        emit({ kind: `delta`, text: `5` });
        await vi.waitFor(() => expect(conversation.messages.value[1]?.text).toBe(`5`));
        // Its end-of-turn usage retires that bubble; the queued message's own turn opens a fresh one below.
        emit({ kind: `usage`, costUsd: 0.1 });
        emit({ kind: `delta`, text: `8` });
        await vi.waitFor(() => expect(conversation.messages.value[3]?.text).toBe(`8`));
        emit({ kind: `done` });
        controller.enqueue(sseFrame({ kind: `end` }));
        controller.close();
        await turn;

        expect(conversation.messages.value.map(({ role, text }) => ({ role, text }))).toEqual([
            { role: `user`, text: `2+3?` },
            { role: `assistant`, text: `5` },
            { role: `user`, text: `2+6?` },
            { role: `assistant`, text: `8` },
        ]);
        expect(conversation.messages.value[1]!.usage).toMatchObject({ costUsd: 0.1 });
    });

    it(`parks the turn on a plan card and streams the continuation into a fresh bubble`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(
            sseResponse([
                { kind: `delta`, text: `intro` },
                { kind: `plan`, requestId: `d1`, text: `the plan` },
                { kind: `delta`, text: `after approval` },
            ]),
        );

        await conversation.send(`make a plan`, settings);

        const [, planMessage, continuation] = conversation.messages.value;
        expect(planMessage).toMatchObject({ text: `intro`, plan: { requestId: `d1`, text: `the plan`, status: `pending` } });
        expect(continuation).toMatchObject({ role: `assistant`, text: `after approval` });
        expect(conversation.awaitingDecision.value).toBe(true);

        sandboxRequestMock.mockResolvedValue({ ok: true } as Response);
        await conversation.decidePlan(planMessage!, true, `acceptEdits`);
        expect(sandboxRequestMock).toHaveBeenLastCalledWith(`/agent/reply`, expect.objectContaining({ method: `POST` }));
        expect(conversation.messages.value[1]!.plan!.status).toBe(`approved`);
        expect(conversation.messages.value.at(-1)).toMatchObject({ role: `notice`, text: `Plan approved.` });
    });

    it(`keeps the user's posture when the AGENT enters plan mode mid-turn`, async () => {
        const conversation = new Conversation(`c1`);
        // An isolated conversation (its own worktree in the sandbox container) runs unattended by default.
        expect(conversation.mode.value).toBe(`bypassPermissions`);
        sandboxRequestMock.mockImplementation(
            sseResponse([
                { kind: `mode`, mode: `plan` },
                { kind: `delta`, text: `planning` },
            ]),
        );

        await conversation.send(`something big`, settings);

        // The composer follows the running turn, but the pick the NEXT turn starts from is untouched — an agent
        // that decides to plan must not cost the user the permissions they gave it.
        expect(conversation.liveMode.value).toBe(`plan`);
        expect(conversation.mode.value).toBe(`bypassPermissions`);

        await conversation.send(`carry on`, settings);
        const [first, second] = turnBodies();
        expect(first![`permissionMode`]).toBe(`bypassPermissions`);
        expect(second![`permissionMode`]).toBe(`bypassPermissions`);
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
        expect(sandboxRequestMock).toHaveBeenLastCalledWith(`/agent/reply`, expect.objectContaining({ method: `POST` }));
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
        const thirdBody = turnBodies()[2]!;
        expect(`sessionId` in thirdBody).toBe(false);
        expect(thirdBody[`history`]).toEqual([
            { role: `user`, text: `first` },
            { role: `user`, text: `second` },
        ]);
        expect(conversation.session.value).toMatchObject({ id: `s-2`, provider: `claude` });
    });

    it(`surfaces an unrecoverable grok-model-invalid error and reloads the catalog`, async () => {
        loadProviderModelsMock.mockClear();
        const conversation = new Conversation(`c1`);
        conversation.provider.value = `grok`;
        conversation.model.value = `grok-code-fast-1`;
        // The daemon self-heals a stale model in-turn (re-prompting with one xAI named), so this code now reaches
        // the client only when that failed — xAI rejected the model AND named no alternative: a genuine error.
        sandboxRequestMock.mockImplementation(
            sseResponse([
                { kind: `error`, code: `grok-model-invalid`, message: `xAI returned no available models for your account.` },
                { kind: `done` },
            ]),
        );
        await conversation.send(`hi`, { ...settings, agent: `grok`, model: `grok-code-fast-1` });
        // The catalog reload is a fire-and-forget dynamic import; let its microtasks drain before asserting it.
        await new Promise((resolve) => setTimeout(resolve, 0));

        // The server message surfaces as the red error ref (not a muted notice), and the catalog is reloaded so
        // the picker reflects whatever the daemon last recorded.
        expect(conversation.error.value).toBe(`xAI returned no available models for your account.`);
        expect(conversation.messages.value.at(-1)!.role).not.toBe(`notice`);
        expect(loadProviderModelsMock).toHaveBeenCalledWith(`grok`);
    });

    it(`surfaces a codex-model-invalid error and reloads the Codex catalog`, async () => {
        loadProviderModelsMock.mockClear();
        const conversation = new Conversation(`c1`);
        conversation.provider.value = `codex`;
        conversation.model.value = `gpt-5-codex`;
        // Codex has no in-turn self-heal (OpenAI names no alternative), so the rejection always lands here; the
        // reload repoints the picker — and this conversation's dead pinned id — to the daemon's live default.
        sandboxRequestMock.mockImplementation(
            sseResponse([
                {
                    kind: `error`,
                    code: `codex-model-invalid`,
                    message: `The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account.`,
                },
                { kind: `done` },
            ]),
        );
        await conversation.send(`hi`, { ...settings, agent: `codex`, model: `gpt-5-codex` });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(conversation.error.value).toContain(`not supported`);
        expect(loadProviderModelsMock).toHaveBeenCalledWith(`codex`);
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

    it(`stores an account_usage frame against its account, stamped so staleness is comparable`, async () => {
        usageStatusByAccount.value = {};
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(
            sseResponse([
                {
                    kind: `account_usage`,
                    account: `acct-1`,
                    windows: [
                        { kind: `five_hour`, utilization: 12, resetsAt: 1_800_000 },
                        { kind: `seven_day`, utilization: 87, resetsAt: 2_000_000 },
                    ],
                },
                { kind: `done` },
            ]),
        );
        await conversation.send(`hello`, settings);

        // Keyed by the serving account (not the conversation) and carrying measuredAt, so the next /accounts
        // load can tell this live reading from the daemon's persisted one.
        const stored = usageStatusByAccount.value[`acct-1`]!;
        expect(stored.windows).toEqual([
            { kind: `five_hour`, utilization: 12, resetsAt: 1_800_000 },
            { kind: `seven_day`, utilization: 87, resetsAt: 2_000_000 },
        ]);
        expect(stored.measuredAt).toBeGreaterThan(0);
        // The frame's envelope fields are not part of the snapshot.
        expect(stored).not.toHaveProperty(`kind`);
        expect(stored).not.toHaveProperty(`account`);
    });

    it(`ignores an account_usage frame the daemon could not attribute to an account`, async () => {
        usageStatusByAccount.value = {};
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(
            sseResponse([{ kind: `account_usage`, windows: [{ kind: `seven_day`, utilization: 5 }] }, { kind: `done` }]),
        );
        await conversation.send(`hello`, settings);

        // An env-token turn has no account to key the snapshot by — better unknown than misattributed.
        expect(usageStatusByAccount.value).toEqual({});
    });

    it(`does not let a rate_limit_info frame stand in for the account's headroom`, async () => {
        usageStatusByAccount.value = {};
        const conversation = new Conversation(`c1`);
        // The gate signal names ONE window — whichever the provider treated as binding for that request. Writing
        // it into the headroom map is how a weekly pool at 1% came to speak for an account at 98% on another.
        sandboxRequestMock.mockImplementation(
            sseResponse([
                { kind: `rate_limit_info`, account: `acct-1`, status: `allowed`, utilization: 1, rateLimitType: `seven_day` },
                { kind: `done` },
            ]),
        );
        await conversation.send(`hello`, settings);

        expect(usageStatusByAccount.value).toEqual({});
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

    it(`stop() cancels the cards a parked turn was waiting on, so the composer isn't wedged on a dead run`, async () => {
        const conversation = new Conversation(`c1`);
        const questions = [{ question: `Which?`, header: `Pick`, multiSelect: false, options: [{ label: `A`, description: `a` }] }];
        sandboxRequestMock.mockImplementation(
            sseResponse(
                [
                    { kind: `plan`, requestId: `d1`, text: `the plan` },
                    { kind: `question`, requestId: `q1`, questions },
                    { kind: `permission`, requestId: `p1`, toolName: `Bash` },
                ],
                { stayOpen: true },
            ),
        );

        const turn = conversation.send(`go`, settings);
        await vi.waitFor(() => expect(conversation.awaitingDecision.value).toBe(true));
        conversation.stop();
        await turn;

        expect(conversation.awaitingDecision.value).toBe(false);
        expect(conversation.pendingPlanMessage.value).toBeUndefined();
        expect(conversation.status.value).toBe(`idle`);
        const cards = conversation.messages.value.flatMap((message) =>
            [message.plan?.status, message.question?.status, message.permission?.status].filter((status) => status !== undefined),
        );
        expect(cards).toEqual([`cancelled`, `cancelled`, `cancelled`]);
    });

    it(`branchFrom copies the turns before the edit and seeds a fresh session from them`, async () => {
        const source = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(
            sseResponse([
                { kind: `session`, sessionId: `s-1` },
                { kind: `delta`, text: `one` },
                { kind: `context_usage`, tokens: 500, contextWindow: 1000 },
            ]),
        );
        await source.send(`first`, settings);
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `delta`, text: `two` }]));
        await source.send(`second`, settings);
        const index = source.messages.value.findIndex((message) => message.text === `second`);

        const branch = new Conversation(`c2`);
        branch.branchFrom(source, index);
        sandboxRequestMock.mockImplementation(
            sseResponse([
                { kind: `session`, sessionId: `s-2` },
                { kind: `delta`, text: `redone` },
            ]),
        );
        await branch.send(`second, revised`, settings);

        // The branch carries the turns before the edit, then the edited turn and its answer.
        expect(branch.messages.value.map((message) => message.text)).toEqual([`first`, `one`, `second, revised`, `redone`]);
        // The branch is a new conversation daemon-side: no session id rides, and the copied transcript seeds it.
        const body = turnBodies()[2]!;
        expect(`sessionId` in body).toBe(false);
        expect(body[`history`]).toEqual([
            { role: `user`, text: `first` },
            { role: `assistant`, text: `one` },
        ]);
        expect(branch.session.value).toMatchObject({ id: `s-2`, provider: `claude` });
        expect(branch.conversationId).not.toBe(source.conversationId);
        // The point of branching: the source keeps its own transcript and session, untouched.
        expect(source.messages.value.map((message) => message.text)).toEqual([`first`, `one`, `second`, `two`]);
        expect(source.session.value).toMatchObject({ id: `s-1` });
        expect(source.contextUsage.value).toMatchObject({ tokens: 500, contextWindow: 1000 });
    });

    it(`a branch taken at the first message starts empty and names itself from the edited text`, async () => {
        const source = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(
            sseResponse([
                { kind: `session`, sessionId: `s-1` },
                { kind: `delta`, text: `hi!` },
            ]),
        );
        await source.send(`original topic`, settings);
        expect(source.title.value).toBe(`original topic`);

        const branch = new Conversation(`c2`);
        branch.branchFrom(source, 0);
        expect(branch.messages.value).toEqual([]);
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `session`, sessionId: `s-2` }]));
        await branch.send(`new topic`, settings);

        // Each tab is findable by its own name rather than two tabs sharing one.
        expect(branch.title.value).toBe(`new topic`);
        expect(source.title.value).toBe(`original topic`);
        // Nothing preceded the branch point, so the fresh session gets neither a session id nor a history seed.
        const body = turnBodies()[1]!;
        expect(`sessionId` in body).toBe(false);
        expect(`history` in body).toBe(false);
    });

    it(`a branch carries the source's provider selection and drops its pending switch notice`, async () => {
        const source = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(
            sseResponse([
                { kind: `session`, sessionId: `s-1` },
                { kind: `delta`, text: `sure` },
            ]),
        );
        await source.send(`first`, settings);
        source.selectProvider(`codex`);
        expect(source.messages.value.at(-1)!.role).toBe(`notice`);

        // Branching before the notice leaves it behind — it belongs to the source's segment cut, not the branch.
        const branch = new Conversation(`c2`);
        branch.branchFrom(source, 0);
        expect(branch.provider.value).toBe(`codex`);
        expect(branch.messages.value.every((message) => message.role !== `notice`)).toBe(true);

        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `session`, sessionId: `thr-1` }]));
        await branch.send(`first, revised`, { ...settings, agent: `codex`, model: `` });
        const body = turnBodies()[1]!;
        expect(body[`agent`]).toBe(`codex`);
        expect(`sessionId` in body).toBe(false);
    });
    it(`re-attaches from the seq cursor when the stream drops mid-turn and loses nothing`, async () => {
        const conversation = new Conversation(`c1`);
        const attachBodies: Record<string, unknown>[] = [];
        sandboxRequestMock.mockImplementation((path: string, init?: RequestInit) => {
            if (path === `/agent`) {
                return Promise.resolve({ ok: true, json: () => Promise.resolve({ run: `r1` }) } as Response);
            }
            attachBodies.push(JSON.parse(init!.body as string) as Record<string, unknown>);
            const body =
                attachBodies.length === 1
                    ? // Two frames, then the connection breaks mid-run (no `end`).
                      chunkStream(
                          [
                              head(),
                              { kind: `frame`, seq: 1, event: { kind: `delta`, text: `Hello ` } },
                              { kind: `frame`, seq: 2, event: { kind: `delta`, text: `wor` } },
                          ],
                          `error`,
                      )
                    : // The resumed attach replays only what the client missed.
                      chunkStream([head({ seq: 3 }), { kind: `frame`, seq: 3, event: { kind: `delta`, text: `ld` } }, { kind: `end` }], `close`);
            return Promise.resolve({ ok: true, body } as Response);
        });

        await conversation.send(`Hi`, settings);

        expect(attachBodies).toEqual([
            { conversationId: conversation.conversationId, run: `r1`, after: 0 },
            { conversationId: conversation.conversationId, run: `r1`, after: 2 },
        ]);
        expect(conversation.messages.value[1]).toMatchObject({ role: `assistant`, text: `Hello world` });
        expect(conversation.error.value).toBeNull();
    });

    it(`settles instead of misrendering when the resumed attach reports a different run`, async () => {
        const conversation = new Conversation(`c1`);
        let attaches = 0;
        sandboxRequestMock.mockImplementation((path: string) => {
            if (path === `/agent`) {
                return Promise.resolve({ ok: true, json: () => Promise.resolve({ run: `r1` }) } as Response);
            }
            attaches += 1;
            const body =
                attaches === 1
                    ? chunkStream([head(), { kind: `frame`, seq: 1, event: { kind: `delta`, text: `partial` } }], `error`)
                    : // A NEWER turn is live by the time the tab reconnects — its frames must not land here.
                      chunkStream(
                          [
                              head({ run: `r2`, prompt: `someone else's turn` }),
                              { kind: `frame`, seq: 1, event: { kind: `delta`, text: `other` } },
                              { kind: `end` },
                          ],
                          `close`,
                      );
            return Promise.resolve({ ok: true, body } as Response);
        });

        await conversation.send(`Hi`, settings);

        expect(conversation.messages.value[1]).toMatchObject({ role: `assistant`, text: `partial` });
        expect(conversation.streaming.value).toBe(false);
    });

    it(`reattach renders a daemon-side run it never initiated: prompt bubble from the head, frames replayed`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation((path: string, init?: RequestInit) => {
            expect(path).toBe(`/agent/attach`);
            const request = JSON.parse(init!.body as string) as Record<string, unknown>;
            expect(request).toEqual({ conversationId: conversation.conversationId, after: 0 });
            const body = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(sseFrame(head({ prompt: `refactor the parser`, startedAt: 1234, seq: 2 })));
                    controller.enqueue(sseFrame({ kind: `frame`, seq: 1, event: { kind: `session`, sessionId: `s-9` } }));
                    controller.enqueue(sseFrame({ kind: `frame`, seq: 2, event: { kind: `delta`, text: `On it.` } }));
                    controller.enqueue(sseFrame({ kind: `end` }));
                    controller.close();
                },
            });
            return Promise.resolve({ ok: true, body } as Response);
        });

        await expect(conversation.reattach()).resolves.toBe(true);

        expect(conversation.messages.value.map(({ role, text }) => ({ role, text }))).toEqual([
            { role: `user`, text: `refactor the parser` },
            { role: `assistant`, text: `On it.` },
        ]);
        // The run's frames armed the session exactly as they would have for the initiating window.
        expect(conversation.session.value).toMatchObject({ id: `s-9` });
        expect(conversation.streaming.value).toBe(false);
    });

    it(`reattach reports false when nothing is running, leaving the transcript untouched`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockResolvedValue({ ok: false, status: 404 } as Response);

        await expect(conversation.reattach()).resolves.toBe(false);

        expect(conversation.messages.value).toHaveLength(0);
        expect(conversation.streaming.value).toBe(false);
        expect(conversation.error.value).toBeNull();
    });

    it(`surfaces a 409 start (another window mid-turn) as an error without corrupting local state`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockResolvedValue({ ok: false, status: 409 } as Response);

        await conversation.send(`Hi`, settings);

        expect(conversation.error.value).toContain(`already running`);
        expect(conversation.streaming.value).toBe(false);
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

    it(`redraws a restored transcript with its thinking and tool cards`, () => {
        const conversation = new Conversation(`c1`);

        conversation.restoreMessages([
            { role: `user`, text: `fix it` },
            { role: `assistant`, text: `Reading.`, thinking: `hmm`, tools: [{ id: `t1`, name: `Read`, category: `read`, status: `completed` }] },
        ]);

        expect(conversation.messages.value).toHaveLength(2);
        expect(conversation.messages.value[1]).toMatchObject({
            role: `assistant`,
            text: `Reading.`,
            thinking: `hmm`,
            tools: [{ name: `Read`, status: `completed` }],
        });
        // Ids are minted locally and must stay unique, so a later streamed bubble can't collide with a restored one.
        expect(new Set(conversation.messages.value.map((message) => message.id)).size).toBe(2);
    });

    // A restored tab already carries its own posture from the tab snapshot. loadTranscript's history-menu
    // defaults would move an isolated agent's next turn onto the main tree — the worktree it has been working
    // in for the whole conversation.
    it(`leaves an isolated conversation's posture alone when its transcript is restored`, () => {
        const conversation = new Conversation(`c1`);
        conversation.isolated.value = true;
        conversation.provider.value = `codex`;

        conversation.restoreMessages([{ role: `user`, text: `hi` }]);

        expect(conversation.isolated.value).toBe(true);
        expect(conversation.provider.value).toBe(`codex`);
    });
});
