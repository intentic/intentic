import type { AgentEvent } from "@intentic/sandbox-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Conversation, turnDefaults } from "./conversation";
import { acksOf, type ChatMessage, isAcknowledgment, transcriptOf, turnsOf } from "./transcript";
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

    it(`turnsOf opens a group at each prompt and keeps pre-prompt frames in one ahead of it`, () => {
        const messages: ChatMessage[] = [
            { id: 1, role: `notice`, text: `Resumed.` },
            { id: 2, role: `assistant`, text: `restored` },
            { id: 3, role: `user`, text: `hi` },
            { id: 4, role: `assistant`, text: `hello` },
            { id: 5, role: `notice`, text: `Stopped.` },
            { id: 6, role: `user`, text: `again` },
        ];
        expect(turnsOf(messages).map((turn) => ({ id: turn.id, ids: turn.messages.map((message) => message.id) }))).toEqual([
            { id: 1, ids: [1, 2] },
            { id: 3, ids: [3, 4, 5] },
            { id: 6, ids: [6] },
        ]);
        expect(turnsOf([])).toEqual([]);
    });

    it(`turnsOf folds a bare acknowledgment into the turn it nudges instead of opening one`, () => {
        const messages: ChatMessage[] = [
            { id: 1, role: `user`, text: `refactor the parser` },
            { id: 2, role: `assistant`, text: `on it` },
            { id: 3, role: `user`, text: `Continue.` },
            { id: 4, role: `assistant`, text: `done` },
            // An ack with trailing content is a fresh instruction, not a nudge.
            { id: 5, role: `user`, text: `continue, but skip the tests` },
        ];
        const turns = turnsOf(messages);
        expect(turns.map((turn) => ({ id: turn.id, ids: turn.messages.map((message) => message.id) }))).toEqual([
            { id: 1, ids: [1, 2, 3, 4] },
            { id: 5, ids: [5] },
        ]);
        expect(acksOf(turns[0]!).map((message) => message.id)).toEqual([3]);
        expect(acksOf(turns[1]!)).toEqual([]);
    });

    it(`isAcknowledgment matches whole-message lexicon entries through trailing punctuation, nothing more`, () => {
        const user = (text: string): ChatMessage => ({ id: 1, role: `user`, text });
        for (const text of [`continue`, `Continue.`, `go for it`, `OK!!`, `yes…`, ` proceed `, `Go   ahead.`, `👍`]) {
            expect(isAcknowledgment(user(text)), text).toBe(true);
        }
        // "continue?" asks, "Continue. Then stop." instructs — neither is bare consent.
        for (const text of [``, `continue?`, `continue, but skip the tests`, `go for it as recommended`, `Continue. Then stop.`]) {
            expect(isAcknowledgment(user(text)), text).toBe(false);
        }
        // An attachment is content of its own, whatever the caption says; and only the user nudges.
        expect(isAcknowledgment({ id: 1, role: `user`, text: `continue`, attachments: [{ name: `a.png`, path: `p/a.png` }] })).toBe(false);
        expect(isAcknowledgment({ id: 1, role: `assistant`, text: `continue` })).toBe(false);
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
        await conversation.enqueue(`2+6?`);
        // The daemon took it, so it left the queue and joined the transcript.
        expect(conversation.queued.value).toHaveLength(0);

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

    it(`sends a steered message's attachments and editor context with it, so a mid-turn file isn't a lesser message`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `delta`, text: `working` }], { stayOpen: true }));

        const turn = conversation.send(`start`, settings);
        await vi.waitFor(() => expect(conversation.streaming.value).toBe(true));
        await conversation.enqueue(`look at this`, [{ name: `shot.png`, path: `.intentic/attachments/u1/shot.png` }], { file: `src/app.ts` });

        const steer = sandboxRequestMock.mock.calls.find(([path]) => path === `/agent/steer`);
        expect(JSON.parse(steer![1]!.body as string)).toMatchObject({
            text: `look at this`,
            attachments: [`.intentic/attachments/u1/shot.png`],
            editorContext: { file: `src/app.ts` },
        });
        // The bubble carries the files too — the transcript shows what was actually handed over.
        expect(conversation.messages.value.at(-1)).toMatchObject({ role: `user`, text: `look at this`, attachments: [{ name: `shot.png` }] });

        conversation.stop();
        await turn;
    });

    it(`keeps a message the running turn can't take, then sends it as the next turn once that one settles`, async () => {
        const conversation = new Conversation(`c1`);
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({
            start(c) {
                controller = c;
                c.enqueue(sseFrame(head()));
            },
        });
        // A native codex/grok/ACP turn registers no steering queue, so the daemon answers NOT_FOUND — the
        // message must survive that and go out on its own rather than vanishing.
        const followUp = sseResponse([{ kind: `delta`, text: `on it` }, { kind: `done` }]);
        let attaches = 0;
        sandboxRequestMock.mockImplementation((path: string, init?: RequestInit) => {
            if (path === `/agent/attach`) {
                attaches += 1;
                return attaches === 1 ? Promise.resolve({ ok: true, body } as Response) : followUp(path, init);
            }
            if (path === `/agent/steer`) {
                return Promise.resolve({ ok: false, status: 404 } as Response);
            }
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ run: `r1` }) } as Response);
        });

        const turn = conversation.send(`start`, settings);
        await conversation.enqueue(`also update the tests`);
        expect(conversation.queued.value).toMatchObject([{ text: `also update the tests` }]);
        expect(turnBodies()).toHaveLength(1);

        // The turn ends on its own — the queue goes out as the next turn.
        controller.enqueue(sseFrame({ kind: `end` }));
        controller.close();
        await turn;

        await vi.waitFor(() => expect(conversation.messages.value.at(-1)?.text).toBe(`on it`));
        expect(turnBodies()[1]).toMatchObject({ prompt: `also update the tests` });
        expect(conversation.queued.value).toHaveLength(0);
    });

    it(`carries several queued messages into ONE follow-up turn, in the order they were written`, async () => {
        const conversation = new Conversation(`c1`);
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({
            start(c) {
                controller = c;
                c.enqueue(sseFrame(head()));
            },
        });
        const followUp = sseResponse([{ kind: `done` }]);
        let attaches = 0;
        sandboxRequestMock.mockImplementation((path: string, init?: RequestInit) => {
            if (path === `/agent/attach`) {
                attaches += 1;
                return attaches === 1 ? Promise.resolve({ ok: true, body } as Response) : followUp(path, init);
            }
            if (path === `/agent/steer`) {
                return Promise.resolve({ ok: false, status: 404 } as Response);
            }
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ run: `r1` }) } as Response);
        });

        const turn = conversation.send(`start`, settings);
        await conversation.enqueue(`also the tests`, [{ name: `spec.md`, path: `.intentic/attachments/u1/spec.md` }]);
        await conversation.enqueue(`and the docs`);
        controller.enqueue(sseFrame({ kind: `end` }));
        controller.close();
        await turn;

        // Two thoughts about the same work are one request, not a turn each.
        await vi.waitFor(() => expect(turnBodies()).toHaveLength(2));
        expect(turnBodies()[1]).toMatchObject({
            prompt: `also the tests\n\nand the docs`,
            attachments: [`.intentic/attachments/u1/spec.md`],
        });
    });

    it(`holds the queue when the user stops the turn, then sends it with their next message`, async () => {
        const conversation = new Conversation(`c1`);
        const followUp = sseResponse([{ kind: `done` }]);
        let attaches = 0;
        const parked = sseResponse([{ kind: `delta`, text: `working` }], { stayOpen: true });
        sandboxRequestMock.mockImplementation((path: string, init?: RequestInit) => {
            if (path === `/agent/attach`) {
                attaches += 1;
                return attaches === 1 ? parked(path, init) : followUp(path, init);
            }
            if (path === `/agent/steer`) {
                return Promise.resolve({ ok: false, status: 404 } as Response);
            }
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ run: `r1` }) } as Response);
        });

        const turn = conversation.send(`start`, settings);
        await vi.waitFor(() => expect(conversation.streaming.value).toBe(true));
        await conversation.enqueue(`and the docs`);
        conversation.stop();
        await turn;

        // Stopping the agent is not a request for another turn — the message waits where the user can see it.
        expect(turnBodies()).toHaveLength(1);
        expect(conversation.queued.value).toMatchObject([{ text: `and the docs` }]);

        // Their next message takes it along.
        await conversation.enqueue(`actually, start with the docs`);
        await vi.waitFor(() => expect(turnBodies()).toHaveLength(2));
        expect(turnBodies()[1]).toMatchObject({ prompt: `and the docs\n\nactually, start with the docs` });
        expect(conversation.queued.value).toHaveLength(0);
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

    it(`dismissing a question stops the turn: the fork the agent could not call is not one it may now guess at`, async () => {
        const conversation = new Conversation(`c1`);
        const questions = [{ question: `Which?`, header: `Pick`, multiSelect: false, options: [{ label: `A`, description: `a` }] }];
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `question`, requestId: `q1`, questions }], { stayOpen: true }));

        const turn = conversation.send(`ask me`, settings);
        await vi.waitFor(() => expect(conversation.awaitingDecision.value).toBe(true));
        // Queued behind the card: a stopped turn must not fire it, the way an answered one would.
        await conversation.enqueue(`and then the docs`);
        await conversation.cancelQuestion(conversation.messages.value.find((message) => message.question !== undefined)!);
        await turn;

        const paths = sandboxRequestMock.mock.calls.map(([path]) => path);
        expect(paths).toContain(`/agent/reply`);
        expect(paths).toContain(`/agent/stop`);
        expect(conversation.messages.value.find((message) => message.question !== undefined)!.question).toMatchObject({ status: `cancelled` });
        expect(conversation.streaming.value).toBe(false);
        expect(conversation.error.value).toBeNull();
        expect(conversation.messages.value.slice(-2)).toMatchObject([
            { role: `notice`, text: `Question dismissed.` },
            { role: `notice`, text: `Stopped.` },
        ]);
        expect(turnBodies()).toHaveLength(1);
        expect(conversation.queued.value).toMatchObject([{ text: `and then the docs` }]);
    });

    it(`denying a permission stops the turn, and allowing one leaves it running`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(
            sseResponse(
                [
                    { kind: `permission`, requestId: `p1`, toolName: `Bash` },
                    { kind: `permission`, requestId: `p2`, toolName: `Write` },
                ],
                { stayOpen: true },
            ),
        );

        const turn = conversation.send(`run it`, settings);
        await vi.waitFor(() => expect(conversation.awaitingDecision.value).toBe(true));

        // Re-read per assertion: deciding a card replaces its message rather than mutating it.
        const cards = (): ChatMessage[] => conversation.messages.value.filter((message) => message.permission !== undefined);
        const [allowed, denied] = cards();
        // An allow is the turn carrying on with the user's blessing — nothing to stop.
        await conversation.decidePermission(allowed!, `once`);
        expect(conversation.streaming.value).toBe(true);
        expect(sandboxRequestMock.mock.calls.map(([path]) => path)).not.toContain(`/agent/stop`);

        await conversation.decidePermission(denied!, `deny`);
        await turn;

        expect(sandboxRequestMock.mock.calls.map(([path]) => path)).toContain(`/agent/stop`);
        expect(cards().map((card) => card.permission!.status)).toEqual([`allowed`, `denied`]);
        expect(conversation.streaming.value).toBe(false);
        expect(conversation.messages.value.at(-1)).toMatchObject({ role: `notice`, text: `Stopped.` });
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

    it(`renders a codex-advisory as a muted notice under the answer the turn actually produced`, async () => {
        const conversation = new Conversation(`c1`);
        conversation.provider.value = `codex`;
        // Codex warns when its pinned CLI has no metadata for a model the subscription already serves, then runs
        // the turn anyway. The red line said the turn had failed, directly beneath its own answer.
        sandboxRequestMock.mockImplementation(
            sseResponse([
                {
                    kind: `error`,
                    code: `codex-advisory`,
                    message:
                        "Model metadata for `gpt-5.6-sol` not found. Defaulting to fallback metadata; this can degrade performance and cause issues.",
                },
                { kind: `delta`, text: `ok` },
                { kind: `done` },
            ]),
        );
        await conversation.send(`hi`, { ...settings, agent: `codex`, model: `gpt-5.6-sol` });

        expect(conversation.messages.value.some((message) => message.role === `notice` && message.text.includes(`fallback metadata`))).toBe(true);
        // The turn's own answer still arrives — the advisory annotates it rather than replacing it.
        expect(conversation.messages.value.some((message) => message.role === `assistant` && message.text === `ok`)).toBe(true);
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

    it(`says when the chat continues by itself when the daemon scheduled the auto-resume`, async () => {
        const conversation = new Conversation(`c1`);
        // Far-future reset so the re-attach probe this arms stays parked for the test's lifetime.
        const resetsAt = Math.floor(Date.now() / 1000) + 3_600;
        sandboxRequestMock.mockImplementation(
            sseResponse([
                { kind: `error`, code: `rate_limit`, message: `Claude usage limit reached.`, resetsAt, autoResume: `scheduled` },
                { kind: `done` },
            ]),
        );
        await conversation.send(`hello`, settings);

        expect(conversation.messages.value.at(-1)!.role).toBe(`notice`);
        expect(conversation.messages.value.at(-1)!.text).toContain(`Auto-resume is on`);
        // Scheduled daemon-side — nothing to offer, so no banner state.
        expect(conversation.limitResume.value).toBeUndefined();
        expect(conversation.error.value).toBeNull();
        // Tears down the armed probe timer so the test leaves no open handle behind.
        conversation.abort();
    });

    it(`offers enabling auto-resume when the daemon only remembered the failed turn, and arming retires the offer`, async () => {
        const conversation = new Conversation(`c1`);
        const resetsAt = Math.floor(Date.now() / 1000) + 3_600;
        sandboxRequestMock.mockImplementation(
            sseResponse([
                { kind: `error`, code: `rate_limit`, message: `Claude usage limit reached.`, resetsAt, autoResume: `available` },
                { kind: `done` },
            ]),
        );
        await conversation.send(`hello`, settings);

        // The offer banner's state, alongside the usual muted notice.
        expect(conversation.limitResume.value).toEqual({ resetsAt });
        expect(conversation.messages.value.at(-1)!.role).toBe(`notice`);
        expect(conversation.error.value).toBeNull();

        // The user enabled the setting: the offer retires and the transcript says when the chat continues.
        conversation.armLimitResume();
        expect(conversation.limitResume.value).toBeUndefined();
        expect(conversation.messages.value.at(-1)!.text).toContain(`Auto-resume enabled`);
        conversation.abort();
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
        expect(source.title.value).toBe(`Original topic`);

        const branch = new Conversation(`c2`);
        branch.branchFrom(source, 0);
        expect(branch.messages.value).toEqual([]);
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `session`, sessionId: `s-2` }]));
        await branch.send(`new topic`, settings);

        // Each tab is findable by its own name rather than two tabs sharing one.
        expect(branch.title.value).toBe(`New topic`);
        expect(source.title.value).toBe(`Original topic`);
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

    /* The transcript-loss bug: reattach appends the running turn's prompt bubble to whatever the transcript
     * holds. A reload that lands mid-turn used to attach before the history was in place, so the chat came back
     * showing only the message being answered — and the settle then persisted that stub over the local mirror.
     * Attaching on top of an ALREADY-restored transcript is the shape hydrate now guarantees. */
    it(`reattach adds the live turn to the history already on screen instead of replacing it`, async () => {
        const conversation = new Conversation(`c1`);
        conversation.restoreMessages([
            { role: `user`, text: `start the migration` },
            { role: `assistant`, text: `Done with step one.` },
        ]);
        sandboxRequestMock.mockImplementation(() => {
            const body = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(sseFrame(head({ prompt: `Continue` })));
                    controller.enqueue(sseFrame({ kind: `frame`, seq: 1, event: { kind: `delta`, text: `Step two.` } }));
                    controller.enqueue(sseFrame({ kind: `end` }));
                    controller.close();
                },
            });
            return Promise.resolve({ ok: true, body } as Response);
        });

        await expect(conversation.reattach()).resolves.toBe(true);

        expect(conversation.messages.value.map(({ role, text }) => ({ role, text }))).toEqual([
            { role: `user`, text: `start the migration` },
            { role: `assistant`, text: `Done with step one.` },
            { role: `user`, text: `Continue` },
            { role: `assistant`, text: `Step two.` },
        ]);
    });

    /* The duplicated-chat bug: the daemon's session store holds a turn from the moment it starts, so a hydrate
     * that lands MID-TURN restores that turn and then attaches to the same run — and the synthesized bubble drew
     * it a second time. The live replay owns the run, so the restored copy is adopted, not doubled. */
    it(`reattach adopts a restored copy of the running turn instead of drawing it twice`, async () => {
        const conversation = new Conversation(`c1`);
        conversation.restoreMessages([
            { role: `user`, text: `start the migration` },
            { role: `assistant`, text: `Done with step one.` },
            // The turn that is still running: the store already has its prompt and the prose written so far.
            { role: `user`, text: `now do step two`, attachments: [`plan.md`] },
            { role: `assistant`, text: `Working on` },
        ]);
        sandboxRequestMock.mockImplementation(() => {
            const body = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(sseFrame(head({ prompt: `now do step two` })));
                    controller.enqueue(sseFrame({ kind: `frame`, seq: 1, event: { kind: `delta`, text: `Working on it.` } }));
                    controller.enqueue(sseFrame({ kind: `end` }));
                    controller.close();
                },
            });
            return Promise.resolve({ ok: true, body } as Response);
        });

        await expect(conversation.reattach()).resolves.toBe(true);

        expect(conversation.messages.value.map(({ role, text }) => ({ role, text }))).toEqual([
            { role: `user`, text: `start the migration` },
            { role: `assistant`, text: `Done with step one.` },
            { role: `user`, text: `now do step two` },
            // The replay rebuilt the answer from seq 0 — the store's partial copy came off with it.
            { role: `assistant`, text: `Working on it.` },
        ]);
        // The adopted bubble is the restored one, chips and all — the head carries no attachments to rebuild.
        expect(conversation.messages.value[2]?.attachments).toEqual([{ name: `plan.md`, path: `plan.md` }]);
    });

    /* The tail is only THIS run when it matches whole: a live "Continue" answering an earlier "Continue with the
     * tests" must not swallow that turn. */
    it(`reattach appends when the transcript's last prompt only looks like the running one`, async () => {
        const conversation = new Conversation(`c1`);
        conversation.restoreMessages([
            { role: `user`, text: `Continue with the tests` },
            { role: `assistant`, text: `All green.` },
        ]);
        sandboxRequestMock.mockImplementation(() => {
            const body = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(sseFrame(head({ prompt: `Continue` })));
                    controller.enqueue(sseFrame({ kind: `end` }));
                    controller.close();
                },
            });
            return Promise.resolve({ ok: true, body } as Response);
        });

        await expect(conversation.reattach()).resolves.toBe(true);

        expect(conversation.messages.value.map(({ role, text }) => ({ role, text }))).toEqual([
            { role: `user`, text: `Continue with the tests` },
            { role: `assistant`, text: `All green.` },
            { role: `user`, text: `Continue` },
            { role: `assistant`, text: `` },
        ]);
    });

    /* The daemon refused the turn before running any of it, so the message was never part of the conversation.
     * It comes back OUT of the transcript and into the queue — which is what makes reconnecting replay it,
     * rather than leaving the user to retype it into every chat the revocation hit. */
    it(`holds an undelivered message in the queue when the Claude credential is revoked`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(
            sseResponse([{ kind: `error`, code: `claude-reauth`, message: `Claude sign-in was revoked — reconnect the account.` }]),
        );

        await conversation.send(`land the branch`, {
            agent: `claude`,
            harness: `native`,
            model: `opus`,
            effort: `medium`,
            thinking: false,
            account: `acct-dead`,
        });

        expect(conversation.messages.value.map((message) => message.role)).toEqual([`notice`]);
        expect(conversation.queued.value.map((message) => message.text)).toEqual([`land the branch`]);
        // Muted, not the red error line: the fix is one click away on the banner this raises.
        expect(conversation.error.value).toBeNull();
    });

    it(`replays the held message once the account is reconnected`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(
            sseResponse([{ kind: `error`, code: `claude-reauth`, message: `Claude sign-in was revoked — reconnect the account.` }]),
        );
        await conversation.send(`land the branch`, {
            agent: `claude`,
            harness: `native`,
            model: `opus`,
            effort: `medium`,
            thinking: false,
            account: `acct-dead`,
        });

        // The reconnect: a new credential id, and the hold released.
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `delta`, text: `Landed.` }]));
        conversation.rebindAccount(`acct-new`);
        await conversation.resume();

        expect(conversation.queued.value).toEqual([]);
        expect(conversation.messages.value.map(({ role, text }) => ({ role, text }))).toEqual([
            { role: `notice`, text: expect.stringContaining(`revoked`) as unknown as string },
            { role: `user`, text: `land the branch` },
            { role: `assistant`, text: `Landed.` },
        ]);
    });

    // A reconnect mints a NEW account id. Leaving the old one on the session ref would read as a deliberate
    // account switch and retire a session that resumes perfectly well — the user reconnected to carry on.
    it(`keeps the session resumable across a reconnect`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `session`, sessionId: `s-1` }]));
        await conversation.send(`hi`, { agent: `claude`, harness: `native`, model: `opus`, effort: `medium`, thinking: false, account: `acct-dead` });

        conversation.rebindAccount(`acct-new`);
        await conversation.send(`again`, {
            agent: `claude`,
            harness: `native`,
            model: `opus`,
            effort: `medium`,
            thinking: false,
            account: `acct-new`,
        });

        const body = JSON.parse(sandboxRequestMock.mock.calls.at(-2)![1]!.body as string) as Record<string, unknown>;
        expect(body[`sessionId`]).toBe(`s-1`);
    });

    it(`reattach replays an already-answered question card as decided, not as a live prompt`, async () => {
        // The bug this guards: a reload replays the run from seq 0, so the card is rebuilt from its own frame —
        // and without the resolution frame it came back pending, offering Submit on a requestId the daemon had
        // already resolved, underneath a transcript that had visibly moved on.
        const conversation = new Conversation(`c1`);
        const questions = [{ question: `Which?`, header: `Pick`, multiSelect: false, options: [{ label: `A`, description: `a` }] }];
        sandboxRequestMock.mockImplementation(() => {
            const body = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(sseFrame(head({ prompt: `which one?`, startedAt: 1234, seq: 3 })));
                    controller.enqueue(sseFrame({ kind: `frame`, seq: 1, event: { kind: `question`, requestId: `q1`, questions } }));
                    controller.enqueue(
                        sseFrame({
                            kind: `frame`,
                            seq: 2,
                            event: { kind: `resolved`, requestId: `q1`, reply: { kind: `question`, requestId: `q1`, answers: { Which: [`A`] } } },
                        }),
                    );
                    controller.enqueue(sseFrame({ kind: `frame`, seq: 3, event: { kind: `delta`, text: `Doing A.` } }));
                    controller.enqueue(sseFrame({ kind: `end` }));
                    controller.close();
                },
            });
            return Promise.resolve({ ok: true, body } as Response);
        });

        await expect(conversation.reattach()).resolves.toBe(true);

        expect(conversation.messages.value[1]!.question).toMatchObject({ status: `answered`, answers: { Which: [`A`] } });
        // Nothing is parked, so the composer is free and no card is asking for an answer that was already given.
        expect(conversation.awaitingDecision.value).toBe(false);
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

    // The daemon recovers a turn's attached files from the stored prompt's note; the redrawn bubble shows
    // them as chips again (named by file), not as the injected protocol text.
    it(`redraws a restored message's attachments as chips`, () => {
        const conversation = new Conversation(`c1`);

        conversation.restoreMessages([{ role: `user`, text: `analyze this`, attachments: [`.intentic/attachments/uuid-1/image.png`] }]);

        expect(conversation.messages.value[0]).toMatchObject({
            role: `user`,
            text: `analyze this`,
            attachments: [{ name: `image.png`, path: `.intentic/attachments/uuid-1/image.png` }],
        });
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
