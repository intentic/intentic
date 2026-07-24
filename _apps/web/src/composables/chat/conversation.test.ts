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
    sandboxRequestMock.mock.calls.filter(([path]) => path === `/agent`).map(([, init]) => JSON.parse(init!.body as string) as Record<string, unknown>);

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

    it(`stores a rate_limit_info frame against its account, stamped so staleness is comparable`, async () => {
        usageStatusByAccount.value = {};
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(
            sseResponse([
                { kind: `rate_limit_info`, account: `acct-1`, status: `allowed_warning`, utilization: 87, rateLimitType: `seven_day`, resetsAt: 1_800_000 },
                { kind: `done` },
            ]),
        );
        await conversation.send(`hello`, settings);

        // Keyed by the serving account (not the conversation) and carrying measuredAt, so the next /accounts
        // load can tell this live reading from the daemon's persisted one.
        const stored = usageStatusByAccount.value[`acct-1`]!;
        expect(stored).toMatchObject({ status: `allowed_warning`, utilization: 87, rateLimitType: `seven_day`, resetsAt: 1_800_000 });
        expect(stored.measuredAt).toBeGreaterThan(0);
        // The frame's envelope fields are not part of the snapshot.
        expect(stored).not.toHaveProperty(`kind`);
        expect(stored).not.toHaveProperty(`account`);
    });

    it(`ignores a rate_limit_info frame the daemon could not attribute to an account`, async () => {
        usageStatusByAccount.value = {};
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `rate_limit_info`, status: `allowed`, utilization: 5 }, { kind: `done` }]));
        await conversation.send(`hello`, settings);

        // An env-token turn has no account to key the snapshot by — better unknown than misattributed.
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
        const body = turnBodies()[2]!;
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
        const body = turnBodies()[1]!;
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

        const body = turnBodies()[1]!;
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
        const body = turnBodies()[1]!;
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
        // One send = one start + one attach; the guarded edits added neither.
        expect(sandboxRequestMock).toHaveBeenCalledTimes(2);

        // Mid-stream the rewind is refused outright.
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `delta`, text: `x` }], { stayOpen: true }));
        const turn = conversation.send(`busy`, settings);
        await vi.waitFor(() => expect(conversation.streaming.value).toBe(true));
        await conversation.editAndResend(before[0]!.id, `nope`, settings);
        expect(conversation.messages.value.filter((message) => message.role === `user`).map((m) => m.text)).toEqual([`hello`, `busy`]);
        conversation.stop();
        await turn;
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
});
