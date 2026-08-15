import { STATE_DIR } from "@intentic/constants";
import { type AgentEvent, RESUME_NOTES, withResumeNote } from "@intentic/sandbox-contract";
import { watch } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Conversation } from "./conversation";
import { providerAccounts } from "./providerAccounts";
import { transcriptView } from "./transcriptClock";
import { turnDefaults } from "./turnDefaults";
import { resolvePrompt } from "../agents/conflictResolution";
import { type ChatMessage, CONTINUATIONS, continuationFor, dayMarksOf, foldsIntoTurn, forkCutsOf, isAcknowledgment, turnsOf } from "./transcript";
import { usageStatusByAccount } from "./usageStatus";

// `sandboxError` stands in for the real one minus that module's app-wide singletons (the endpoint, session and
// sandbox stores sandboxRequest reaches for at import time). It keeps the half this file depends on: the daemon
// puts its own sentence for a refusal on `message`, and reading it is the whole point of the path below.
vi.mock("../sandbox/sandboxClient", () => ({
    sandboxRequest: vi.fn(),
    sandboxError: async (response: Response) => new Error(((await response.json()) as { message: string }).message),
}));
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
    // The window the panel announces it is displayed in — a module singleton like the rest below.
    transcriptView.value = undefined;
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

const settings = {
    agent: `claude`,
    harness: `native`,
    account: undefined,
    actsAs: undefined,
    model: `opus`,
    effort: `high`,
    thinking: false,
    fast: false,
} as const;

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

    /* The buffer's whole reason for existing: a turn's render cost is set by how many times the transcript is
     * WRITTEN, not by how many frames the daemon sent, so a burst has to cost what a single frame costs.
     *
     * Driven off a clock that never fires rather than the file's synchronous one, because a synchronous
     * requestAnimationFrame applies each frame the instant it arrives — precisely the behaviour the buffer
     * replaces — and would let this pass while measuring nothing.
     *
     * Tool calls rather than deltas, because a delta lands in the typewriter's buffer rather than in
     * `messages`, so a stopped clock hides the very difference under test: text only reaches a bubble when
     * the clock ticks, whether frames are buffered or not. A tool call changes the transcript on the spot,
     * which is what makes the per-frame write visible. */
    it(`applies a burst of frames in one write, so render cost does not scale with frame count`, async () => {
        const runWith = async (calls: number): Promise<{ writes: number; tools: number }> => {
            vi.stubGlobal(`requestAnimationFrame`, (): number => 0);
            const conversation = new Conversation(`c1`);
            let writes = 0;
            // Counted on `messages` because that is what the renderer reads: every fire is a transcript
            // re-render. `flush: sync` so the count is of writes, not of scheduler passes that batch them.
            const stop = watch(conversation.messages, () => (writes += 1), { flush: `sync` });
            sandboxRequestMock.mockImplementation(
                sseResponse([
                    ...Array.from({ length: calls }, (_, index): AgentEvent => ({
                        kind: `tool_call`,
                        id: `t${index}`,
                        name: `Read`,
                        category: `read`,
                        status: `completed`,
                    })),
                    { kind: `done` },
                ]),
            );
            await conversation.send(`Hi`, settings);
            stop();
            return { writes, tools: conversation.messages.value.reduce((total, message) => total + (message.tools?.length ?? 0), 0) };
        };

        const few = await runWith(4);
        const many = await runWith(16);

        // Four times the frames, the same number of renders — and every call still landed, so the fold that
        // bought this is applying them rather than collapsing them.
        expect(many.writes).toBe(few.writes);
        expect(few.tools).toBe(4);
        expect(many.tools).toBe(16);
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

    it(`switches provider mid-conversation: retires the session and carries no transcript up the wire`, async () => {
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

        /* A Codex thread must not resume as a Claude session: the switched turn drops the session id. It sends
         * NOTHING in its place — seeding the replacement is the daemon's job, off its own record of this
         * conversation (sessions/turn-transcript.ts → handoffHistory), so an omitted sessionId is the whole
         * signal. This window's painted bubbles never ride the wire. */
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `session`, sessionId: `s-1` }]));
        await conversation.send(`second`, settings);
        const secondBody = turnBodies()[1]!;
        expect(secondBody[`agent`]).toBe(`claude`);
        expect(`sessionId` in secondBody).toBe(false);
        expect(`history` in secondBody).toBe(false);

        // The new runtime's session is captured with its own provider; the next turn resumes it.
        expect(conversation.session.value).toMatchObject({ id: `s-1`, provider: `claude` });
        await conversation.send(`third`, settings);
        const thirdBody = turnBodies()[2]!;
        expect(thirdBody[`sessionId`]).toBe(`s-1`);
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
        expect(turns[0]!.folded.map((message) => message.id)).toEqual([3]);
        expect(turns[1]!.folded).toEqual([]);
        // A turn that folded nothing shares the empty array rather than allocating one, which is what keeps
        // the head bubble's `folded` prop stable across the rebuild `turnsOf` does on every frame.
        expect(turnsOf([{ id: 9, role: `user`, text: `hi` }])[0]!.folded).toBe(turns[1]!.folded);
    });

    /* An errand is the app's own prompt, sent on the user's behalf (errands.ts) — it must reach the agent as a
     * real turn and must NOT take the pin off the request it serves. Written against the composed prompt
     * rather than a hand-made string, so a reworded opening fails here instead of silently going back to
     * pinning a paragraph of machine prose over the user's question. */
    it(`turnsOf folds an app errand into the turn it serves, whatever the daemon wrapped it in`, () => {
        const errand = resolvePrompt([{ repo: `root`, clean: 1, paths: [{ path: `a.ts`, reason: `diverged` }] }]);
        const messages: ChatMessage[] = [
            { id: 1, role: `user`, text: `implement the extension host split` },
            { id: 2, role: `assistant`, text: `done` },
            { id: 3, role: `user`, text: errand },
            { id: 4, role: `assistant`, text: `rebased` },
            // The same errand as a turn the daemon restarted carries it behind a resume note.
            { id: 5, role: `user`, text: withResumeNote(errand, RESUME_NOTES.restart) },
        ];
        const turns = turnsOf(messages);
        expect(turns.map((turn) => ({ id: turn.id, ids: turn.messages.map((message) => message.id) }))).toEqual([{ id: 1, ids: [1, 2, 3, 4, 5] }]);
        expect(turns[0]!.folded.map((message) => message.id)).toEqual([3, 5]);
        expect(foldsIntoTurn(messages[3]!)).toBe(false);
    });

    /* THE FORK MARK'S NUMBER, one per turn: what a fork taken at the end of that turn's answer inherits, which
     * is also where the message below the line sits. The last turn's cut lands past the final message — the
     * whole conversation, the one cut with nothing below it — and a trailing notice stays above the line with
     * the turn it belongs to, so the cut still points at the next prompt (the row a rewind restores). */
    it(`forkCutsOf hands every turn the boundary just past it`, () => {
        const messages: ChatMessage[] = [
            { id: 1, role: `user`, text: `hi` },
            { id: 2, role: `assistant`, text: `hello` },
            { id: 3, role: `notice`, text: `Stopped.` },
            { id: 4, role: `user`, text: `again` },
            { id: 5, role: `assistant`, text: `sure` },
        ];
        expect([...forkCutsOf(turnsOf(messages))]).toEqual([
            [1, 3],
            [4, 5],
        ]);
        // Every turn has one, the first included: a fork below the opening answer keeps that whole exchange.
        expect(forkCutsOf(turnsOf(messages.slice(0, 2)))).toEqual(new Map([[1, 2]]));
        expect(forkCutsOf([])).toEqual(new Map());
    });

    /* THE TRANSCRIPT'S DATE (dayMarksOf) — a day named once, above the first turn sent on it. It is what the
     * per-prompt stamp leans on to be five characters wide, so the rule that matters is that it fires on every
     * change of day and on nothing else.
     *
     * Stamps are built from local wall-clock parts rather than UTC: the marker is the viewer's own day, so a
     * fixture pinned to a UTC hour would land on either side of midnight depending on where the runner is. */
    it(`dayMarksOf names a day above the first turn sent on it and nowhere else`, () => {
        const at = (day: number, hour: number): number => new Date(2026, 7, day, hour).getTime();
        const turns = turnsOf([
            // Opening frames with no stamp of their own — a restored history. They name no day and do not
            // consume the first one either: the prompt below still carries the marker.
            { id: 1, role: `assistant`, text: `restored` },
            { id: 2, role: `user`, text: `morning`, sentAt: at(10, 9) },
            { id: 3, role: `assistant`, text: `on it` },
            // Same day, hours later: no second marker.
            { id: 4, role: `user`, text: `and this too`, sentAt: at(10, 17) },
            { id: 5, role: `assistant`, text: `done` },
            // Picked up the next day.
            { id: 6, role: `user`, text: `back`, sentAt: at(11, 8) },
        ]);

        const marks = dayMarksOf(turns);
        expect([...marks.entries()]).toEqual([
            [2, `Aug 10, 2026`],
            [6, `Aug 11, 2026`],
        ]);
        // A transcript nothing is stamped in draws no marker at all rather than a plausible-looking date.
        expect(dayMarksOf(turnsOf([{ id: 1, role: `user`, text: `hi` }])).size).toBe(0);
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

    /* The posture is clamped at READ, like the effort scale one field up: a native Codex/Grok/ACP turn has an
     * approval channel for nothing, so "Manual" left showing above one was a promise the runtime could not
     * keep — it ran every tool call regardless. Clamping the pick instead would cost the user their choice the
     * moment they browsed to another provider and back. */
    it(`a permission mode the runtime can't hold reads as the one it runs, and the pick survives`, () => {
        const conversation = new Conversation(`c-modes`);
        conversation.modePick.value = `acceptEdits`;

        conversation.selectProvider(`codex`);
        expect(conversation.mode.value).toBe(`bypassPermissions`);

        // Under the Claude Code harness the same provider IS the loop that honours modes — and the pick was
        // never overwritten, so it comes back untouched.
        conversation.selectHarness(`claude-code`);
        expect(conversation.mode.value).toBe(`acceptEdits`);
        expect(conversation.capabilities.value.permissions).toBe(`modes`);

        // And back: the native runtime reads as autonomous again, while `plan` — which every runtime has,
        // emulated — rides through unchanged.
        conversation.selectHarness(`native`);
        expect(conversation.mode.value).toBe(`bypassPermissions`);
        conversation.modePick.value = `plan`;
        conversation.selectProvider(`grok`);
        expect(conversation.mode.value).toBe(`plan`);
    });

    it(`selectProvider re-scopes model + effort and prevents a Claude alias reaching Codex`, async () => {
        const conversation = new Conversation(`c1`);
        // Seeded from the Claude defaults.
        expect(conversation.provider.value).toBe(`claude`);
        expect(conversation.model.value).toBe(`opus`);

        // Pick a Claude alias + a Claude-only effort, then switch to Codex: the alias clears to the account
        // default ('') and 'max' is clamped — so no Claude model can ride a Codex turn.
        conversation.model.value = `haiku`;
        conversation.effortPick.value = `max`;
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
            actsAs: conversation.actsAs.value,
            model: conversation.model.value,
            effort: conversation.effort.value,
            thinking: false,
            fast: false,
        });
        const body = turnBodies()[0]!;
        expect(body[`agent`]).toBe(`codex`);
        expect(`model` in body).toBe(false);

        // A mid-chat pick switches the selection (no lock) and marks the pending cut with a notice.
        conversation.selectProvider(`claude`);
        expect(conversation.provider.value).toBe(`claude`);
        expect(conversation.messages.value.at(-1)!.role).toBe(`notice`);
    });

    /* THE PERSONA IS PART OF THE TURN, not of the conversation's opening — which is what makes "now act as Work
     * and post this" one pick rather than a new chat. The daemon resolves the card per turn, so the pick is read
     * at DELIVERY (turnSettings) and the same conversation can send one message as nobody and the next as Work.
     *
     * The first half matters as much as the second: an attended chat that names nobody must send no `actsAs` at
     * all, because that absence is what keeps every connected account in reach. */
    it(`sends the persona a turn is acting as, and nothing at all when the chat is nobody`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `done` }]));

        await conversation.send(`check our mentions`, conversation.turnSettings());
        expect(`actsAs` in turnBodies()[0]!).toBe(false);

        conversation.actsAs.value = `work`;
        await conversation.send(`reply to the top one`, conversation.turnSettings());
        expect(turnBodies()[1]![`actsAs`]).toBe(`work`);
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
        await conversation.enqueue(`look at this`, [{ name: `shot.png`, path: `.intentic/artifacts/attachments/u1/shot.png` }], {
            file: `src/app.ts`,
        });

        const steer = sandboxRequestMock.mock.calls.find(([path]) => path === `/agent/steer`);
        expect(JSON.parse(steer![1]!.body as string)).toMatchObject({
            text: `look at this`,
            attachments: [`.intentic/artifacts/attachments/u1/shot.png`],
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
        await conversation.enqueue(`also the tests`, [{ name: `spec.md`, path: `${STATE_DIR}/artifacts/attachments/u1/spec.md` }]);
        await conversation.enqueue(`and the docs`);
        controller.enqueue(sseFrame({ kind: `end` }));
        controller.close();
        await turn;

        // Two thoughts about the same work are one request, not a turn each.
        await vi.waitFor(() => expect(turnBodies()).toHaveLength(2));
        expect(turnBodies()[1]).toMatchObject({
            prompt: `also the tests\n\nand the docs`,
            attachments: [`.intentic/artifacts/attachments/u1/spec.md`],
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

    it(`waits for the stopped daemon run to release its lock before starting the next message`, async () => {
        const conversation = new Conversation(`c1`);
        const parked = sseResponse([{ kind: `delta`, text: `working` }], { stayOpen: true });
        const completed = sseResponse([{ kind: `done` }]);
        let attaches = 0;
        let releaseStop: (response: Response) => void = () => {};
        const stopped = new Promise<Response>((resolve) => {
            releaseStop = resolve;
        });
        sandboxRequestMock.mockImplementation((path: string, init?: RequestInit) => {
            if (path === `/agent/attach`) {
                attaches += 1;
                return attaches === 1 ? parked(path, init) : completed(path, init);
            }
            if (path === `/agent/stop`) {
                return stopped;
            }
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ run: `r${attaches + 1}` }) } as Response);
        });

        const first = conversation.send(`start`, settings);
        await vi.waitFor(() => expect(conversation.streaming.value).toBe(true));
        conversation.stop();
        await first;

        const next = conversation.enqueue(`try again`);
        await Promise.resolve();
        // The local attach is already gone, but /agent/stop has not yet confirmed daemon-side settlement.
        expect(turnBodies()).toHaveLength(1);

        releaseStop({ ok: true } as Response);
        await next;
        expect(turnBodies()).toHaveLength(2);
        expect(turnBodies()[1]).toMatchObject({ prompt: `try again` });
        expect(conversation.error.value).toBeNull();
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
        await conversation.decidePlan(planMessage!, true);
        expect(sandboxRequestMock).toHaveBeenLastCalledWith(`/agent/reply`, expect.objectContaining({ method: `POST` }));
        expect(conversation.messages.value[1]!.plan!.status).toBe(`approved`);
        expect(conversation.messages.value.at(-1)).toMatchObject({ role: `notice`, text: `Plan approved.` });
    });

    // The composer stages files against a pending plan card exactly as it does against a message; the reply has
    // one text field, so they travel as `@`-paths and stay on the bubble the rejection leaves behind.
    it(`sends a plan rejection's staged files as @-paths and keeps them on the feedback bubble`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `plan`, requestId: `d1`, text: `the plan` }]));
        await conversation.send(`make a plan`, settings);
        const planMessage = conversation.messages.value.find((message) => message.plan !== undefined);

        sandboxRequestMock.mockResolvedValue({ ok: true } as Response);
        await conversation.decidePlan(planMessage!, false, `this bit is wrong`, [
            { name: `shot.png`, path: `${STATE_DIR}/artifacts/attachments/a1/shot.png` },
        ]);

        const [, body] = sandboxRequestMock.mock.calls.at(-1) as [string, RequestInit];
        expect(JSON.parse(String(body.body))).toMatchObject({
            kind: `plan`,
            approve: false,
            feedback: `this bit is wrong\n@.intentic/artifacts/attachments/a1/shot.png`,
        });
        expect(conversation.messages.value.at(-1)).toMatchObject({
            role: `user`,
            text: `this bit is wrong`,
            attachments: [{ name: `shot.png`, path: `.intentic/artifacts/attachments/a1/shot.png` }],
        });
    });

    // A screenshot with nothing typed is a whole answer on its own — the branch the old text-only rule refused.
    it(`sends an attachment-only plan rejection`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `plan`, requestId: `d1`, text: `the plan` }]));
        await conversation.send(`make a plan`, settings);
        const planMessage = conversation.messages.value.find((message) => message.plan !== undefined);

        sandboxRequestMock.mockResolvedValue({ ok: true } as Response);
        await conversation.decidePlan(planMessage!, false, ``, [{ name: `shot.png`, path: `${STATE_DIR}/artifacts/attachments/a1/shot.png` }]);

        const [, body] = sandboxRequestMock.mock.calls.at(-1) as [string, RequestInit];
        expect(JSON.parse(String(body.body))).toMatchObject({ feedback: `@.intentic/artifacts/attachments/a1/shot.png` });
        expect(conversation.messages.value.at(-1)).toMatchObject({ role: `user`, text: `` });
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
        // ONE request does both halves — the daemon ends the turn where the dismissal lands. A stop sent
        // behind it is what flashed the board's Active lane between the two (see cancelQuestion).
        expect(paths).not.toContain(`/agent/stop`);
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

    /* THE SPEND CARD. Approving does NOT predict the outcome — the receipt is its own frame, from the platform's
     * answer — and a skip leaves the turn running: the agent was told to continue without the service, which is
     * work, not an ending. Both clicks travel the same /agent/reply side channel as every other card. */
    it(`parks the turn on a spend card; the click approves it and the receipt patches on when the run answers`, async () => {
        const conversation = new Conversation(`c1`);
        const offer = {
            slug: `acme-research`,
            name: `Acme Research`,
            publisher: `acme`,
            description: `Deep research runs.`,
            creditsPerRun: 40,
            credits: { allowance: 1000, remaining: 960, resetsAt: `2026-08-13T00:00:00Z` },
            request: `{"query":"communities"}`,
            why: `a deep pass beats my free scan here`,
        };
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `service_offer`, requestId: `s1`, offer }], { stayOpen: true }));

        const turn = conversation.send(`research it`, settings);
        await vi.waitFor(() => expect(conversation.awaitingDecision.value).toBe(true));

        const card = (): ChatMessage => conversation.messages.value.find((message) => message.serviceOffer !== undefined)!;
        expect(card().serviceOffer).toMatchObject({ requestId: `s1`, status: `pending`, offer: { creditsPerRun: 40 } });

        await conversation.decideServiceOffer(card(), true);
        expect(sandboxRequestMock).toHaveBeenLastCalledWith(`/agent/reply`, expect.objectContaining({ method: `POST` }));
        expect(card().serviceOffer).toMatchObject({ status: `approved` });
        // Approving is not an ending: the agent's command is still running the service.
        expect(conversation.streaming.value).toBe(true);
        await conversation.stop();
        await turn;
    });

    it(`skipping a spend card charges nothing and leaves the turn running`, async () => {
        const conversation = new Conversation(`c1`);
        const offer = { slug: `s`, name: `S`, publisher: `p`, description: `d`, creditsPerRun: 10, request: `{}` };
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `service_offer`, requestId: `s1`, offer }], { stayOpen: true }));

        const turn = conversation.send(`try it`, settings);
        await vi.waitFor(() => expect(conversation.awaitingDecision.value).toBe(true));
        const card = (): ChatMessage => conversation.messages.value.find((message) => message.serviceOffer !== undefined)!;
        await conversation.decideServiceOffer(card(), false);

        expect(card().serviceOffer).toMatchObject({ status: `skipped` });
        expect(sandboxRequestMock.mock.calls.map(([path]) => path)).not.toContain(`/agent/stop`);
        expect(conversation.streaming.value).toBe(true);
        await conversation.stop();
        await turn;
    });

    it(`a replayed spend card freezes from the resolved frame and wears its receipt`, async () => {
        const conversation = new Conversation(`c1`);
        const offer = { slug: `s`, name: `S`, publisher: `p`, description: `d`, creditsPerRun: 40, request: `{}` };
        sandboxRequestMock.mockImplementation(
            sseResponse([
                { kind: `service_offer`, requestId: `s1`, offer },
                { kind: `resolved`, requestId: `s1`, reply: { kind: `service_offer`, requestId: `s1`, approve: true } },
                { kind: `service_receipt`, requestId: `s1`, outcome: `ok`, credits: 40, remaining: 920 },
            ]),
        );

        await conversation.send(`research it`, settings);

        const card = conversation.messages.value.find((message) => message.serviceOffer !== undefined)!;
        expect(card.serviceOffer).toMatchObject({ status: `approved`, receipt: { outcome: `ok`, credits: 40, remaining: 920 } });
    });

    it(`an approved run's stream events accumulate on the card, in order, by requestId`, async () => {
        const conversation = new Conversation(`c1`);
        const offer = { slug: `s`, name: `S`, publisher: `p`, description: `d`, creditsPerRun: 40, request: `{}` };
        sandboxRequestMock.mockImplementation(
            sseResponse([
                { kind: `service_offer`, requestId: `s1`, offer },
                { kind: `resolved`, requestId: `s1`, reply: { kind: `service_offer`, requestId: `s1`, approve: true } },
                { kind: `service_event`, requestId: `s1`, event: { event: `status`, text: `Searching 240 communities…` } },
                { kind: `service_event`, requestId: `s1`, event: { event: `status`, text: `Ranking the 12 that fit…` } },
                // Another card's stream must not bleed onto this one.
                { kind: `service_event`, requestId: `other`, event: { event: `status`, text: `elsewhere` } },
                { kind: `service_receipt`, requestId: `s1`, outcome: `ok`, credits: 40, remaining: 920 },
            ]),
        );

        await conversation.send(`research it`, settings);

        const card = conversation.messages.value.find((message) => message.serviceOffer !== undefined)!;
        expect(card.serviceOffer?.events).toEqual([
            { event: `status`, text: `Searching 240 communities…` },
            { event: `status`, text: `Ranking the 12 that fit…` },
        ]);
        expect(card.serviceOffer?.receipt).toMatchObject({ outcome: `ok` });
    });

    /* THE SETUP CARD. Connect does NOT predict the outcome — the owner still has the setup to do, so the card
     * moves to `connecting` and the capability_outcome frame is what says how it ended — and "Not now" leaves
     * the turn running: the agent was told to continue without the capability, which is work, not an ending.
     * Both clicks travel the same /agent/reply side channel as every other card. */
    it(`parks the turn on a capability card; Connect moves it to connecting and the outcome patches on`, async () => {
        const conversation = new Conversation(`c1`);
        const offer = { card: `notion`, name: `Notion`, why: `I'll create a page there for each research writeup` };
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `capability_offer`, requestId: `k1`, offer }], { stayOpen: true }));

        const turn = conversation.send(`write it up in notion`, settings);
        await vi.waitFor(() => expect(conversation.awaitingDecision.value).toBe(true));

        const card = (): ChatMessage => conversation.messages.value.find((message) => message.capabilityOffer !== undefined)!;
        expect(card().capabilityOffer).toMatchObject({ requestId: `k1`, status: `pending`, offer: { card: `notion`, name: `Notion` } });

        await conversation.decideCapabilityOffer(card(), true);
        expect(sandboxRequestMock).toHaveBeenLastCalledWith(`/agent/reply`, expect.objectContaining({ method: `POST` }));
        // Connecting is not an ending: the agent's command is still parked, watching for the connection.
        expect(card().capabilityOffer).toMatchObject({ status: `connecting` });
        expect(card().capabilityOffer?.outcome).toBeUndefined();
        expect(conversation.streaming.value).toBe(true);
        await conversation.stop();
        await turn;
    });

    it(`"Not now" on a capability card connects nothing and leaves the turn running`, async () => {
        const conversation = new Conversation(`c1`);
        const offer = { card: `notion`, name: `Notion` };
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `capability_offer`, requestId: `k1`, offer }], { stayOpen: true }));

        const turn = conversation.send(`write it up in notion`, settings);
        await vi.waitFor(() => expect(conversation.awaitingDecision.value).toBe(true));
        const card = (): ChatMessage => conversation.messages.value.find((message) => message.capabilityOffer !== undefined)!;
        await conversation.decideCapabilityOffer(card(), false);

        expect(card().capabilityOffer).toMatchObject({ status: `skipped` });
        expect(sandboxRequestMock.mock.calls.map(([path]) => path)).not.toContain(`/agent/stop`);
        expect(conversation.streaming.value).toBe(true);
        await conversation.stop();
        await turn;
    });

    it(`a replayed capability card freezes from the resolved frame and wears its outcome`, async () => {
        const conversation = new Conversation(`c1`);
        const offer = { card: `notion`, name: `Notion` };
        sandboxRequestMock.mockImplementation(
            sseResponse([
                { kind: `capability_offer`, requestId: `k1`, offer },
                { kind: `resolved`, requestId: `k1`, reply: { kind: `capability_offer`, requestId: `k1`, connect: true } },
                { kind: `capability_outcome`, requestId: `k1`, outcome: `connected`, id: `notion` },
            ]),
        );

        await conversation.send(`write it up in notion`, settings);

        const card = conversation.messages.value.find((message) => message.capabilityOffer !== undefined)!;
        expect(card.capabilityOffer).toMatchObject({ status: `connecting`, outcome: { outcome: `connected`, id: `notion` } });
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

    /* THE OFFER TO PICK A DEAD TURN BACK UP, and the line it is drawn on. An UNCODED failure is the daemon
     * saying it has no name for what went wrong — the harness died, the agent stopped answering — which is the
     * one shape where nothing needs fixing first and carrying on is simply the rest of the work. A NAMED code
     * is the opposite by construction: it says what to go and repair, so an offer under it re-fails on the
     * press and teaches the user the button lies. */
    it(`offers to continue after a failure nobody can act on, and never after one that names a fix`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `error`, message: `agent did not complete (error_during_execution)` }]));
        await conversation.send(`ship the parser`, settings);
        expect(conversation.resumable.value).toBe(true);

        // The next turn is the answer to the offer, whichever way the user gave it — so the offer stands down
        // at the START of it rather than at its end, and cannot be pressed twice into two turns.
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `delta`, text: `carrying on` }, { kind: `done` }]));
        await conversation.send(CONTINUATIONS.plain, settings);
        expect(conversation.resumable.value).toBe(false);

        for (const code of [`subscription-required`, `agent-busy`, `claude-not-entitled`] as const) {
            sandboxRequestMock.mockImplementation(sseResponse([{ kind: `error`, code, message: `nope` }]));
            await conversation.send(`again`, settings);
            expect(conversation.error.value, code).toBe(`nope`);
            expect(conversation.resumable.value, code).toBe(false);
        }
    });

    /* THE SAME PRESS, LEFT ON. A chat that stops short five times in half an hour is five presses, and the
     * fourth of them happens while nobody is at the keyboard — which is the whole point of arming this. */
    it(`continues itself after a turn that stopped short, once its wait is up`, async () => {
        vi.useFakeTimers();
        try {
            const conversation = new Conversation(`c1`);
            conversation.setAutoContinue(true);
            sandboxRequestMock.mockImplementation(sseResponse([{ kind: `error`, message: `agent did not complete` }]));
            await conversation.send(`ship the parser`, settings);

            // Scheduled, not sent: the wait is what makes the automation something a person can get in front of.
            expect(conversation.resumable.value).toBe(true);
            expect(conversation.autoContinueAt.value).toBeGreaterThan(Date.now());
            expect(turnBodies()).toHaveLength(1);

            sandboxRequestMock.mockImplementation(sseResponse([{ kind: `delta`, text: `carrying on` }, { kind: `done` }]));
            await vi.advanceTimersByTimeAsync(6_000);

            // It said the sentence the button says, and the chat is running again with nobody having touched it.
            expect(turnBodies().map((body) => body[`prompt`])).toEqual([`ship the parser`, CONTINUATIONS.plain]);
            expect(conversation.autoContinueAt.value).toBeUndefined();
            expect(conversation.resumable.value).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    // Armed while a stopped turn is already on screen — which is where the switch is offered — it takes that
    // stop too. Waiting for the next one would leave the user pressing Continue anyway.
    it(`takes the stop it was armed in front of`, async () => {
        vi.useFakeTimers();
        try {
            const conversation = new Conversation(`c1`);
            sandboxRequestMock.mockImplementation(sseResponse([{ kind: `error`, message: `agent did not complete` }]));
            await conversation.send(`ship the parser`, settings);
            expect(conversation.autoContinueAt.value).toBeUndefined();

            conversation.setAutoContinue(true);
            expect(conversation.autoContinueAt.value).toBeGreaterThan(Date.now());
            sandboxRequestMock.mockImplementation(sseResponse([{ kind: `delta`, text: `carrying on` }, { kind: `done` }]));
            await vi.advanceTimersByTimeAsync(5_000);
            expect(turnBodies().map((body) => body[`prompt`])).toEqual([`ship the parser`, CONTINUATIONS.plain]);
        } finally {
            vi.useRealTimers();
        }
    });

    /* THE ONE ENDING IT MUST NEVER ANSWER. Stop is the user saying "not this" — restarting the turn they just
     * stopped is the exact opposite of what they asked for, and it is the same `resumable` flag either way, so
     * the difference has to be read off who ended it rather than off what was left behind. */
    it(`stays out of the way of a turn the user stopped`, async () => {
        vi.useFakeTimers();
        try {
            const conversation = new Conversation(`c1`);
            conversation.setAutoContinue(true);
            sandboxRequestMock.mockImplementation(sseResponse([{ kind: `delta`, text: `working` }], { stayOpen: true }));
            const turn = conversation.send(`ship the parser`, settings);
            await vi.waitFor(() => expect(conversation.streaming.value).toBe(true));
            await conversation.stop();
            await turn;

            expect(conversation.resumable.value).toBe(true);
            expect(conversation.autoContinueAt.value).toBeUndefined();
            await vi.advanceTimersByTimeAsync(60_000);
            expect(turnBodies()).toHaveLength(1);
        } finally {
            vi.useRealTimers();
        }
    });

    /* AND THE OTHER HALF OF LEAVING IT ON: knowing when to stop. Turns that die in seconds mean something is
     * actually wrong, and the fastest way to make that expensive is to retry it unattended forever — so each
     * wait is longer than the last, and after three the automation stands down and says why. */
    it(`backs off, then gives up and says so, when nothing it continues gets anywhere`, async () => {
        vi.useFakeTimers();
        try {
            const conversation = new Conversation(`c1`);
            conversation.setAutoContinue(true);
            sandboxRequestMock.mockImplementation(sseResponse([{ kind: `error`, message: `agent did not complete` }]));

            const waits: number[] = [];
            for (let attempt = 0; attempt < 3; attempt += 1) {
                await conversation.send(attempt === 0 ? `ship the parser` : CONTINUATIONS.plain, settings);
                waits.push(conversation.autoContinueAt.value! - Date.now());
                await vi.advanceTimersByTimeAsync(0);
            }
            expect(waits).toEqual([5_000, 15_000, 45_000]);

            // The fourth stop is the one it declines to answer: off, with a line saying so where the user reads.
            await conversation.send(CONTINUATIONS.plain, settings);
            expect(conversation.autoContinue.value).toBe(false);
            expect(conversation.autoContinueAt.value).toBeUndefined();
            expect(conversation.messages.value.at(-1)).toMatchObject({
                role: `notice`,
                text: expect.stringContaining(`Auto-continue stopped`),
            });
        } finally {
            vi.useRealTimers();
        }
    });

    // ...and a turn that ran long enough to have done some of the job starts the ladder over, so an all-night
    // run of real turns keeps its short pauses however many times it is picked back up.
    it(`resets the backoff after a turn that got somewhere`, async () => {
        vi.useFakeTimers();
        try {
            const conversation = new Conversation(`c1`);
            conversation.setAutoContinue(true);
            const instant = sseResponse([{ kind: `error`, message: `agent did not complete` }]);
            sandboxRequestMock.mockImplementation(instant);
            await conversation.send(`ship the parser`, settings);
            // Exactly the wait, so the clock stands where the next one is scheduled from and the assertions below
            // read the delay itself rather than the delay minus however far the test overshot.
            await vi.advanceTimersByTimeAsync(5_000);
            // The second stop is on the ladder's second rung, having bought nothing.
            expect(conversation.autoContinueAt.value! - Date.now()).toBe(15_000);

            // A turn that spent a minute working before it stopped — the clock moves inside the request, which is
            // the one seam a canned stream has for "this took a while".
            sandboxRequestMock.mockImplementation((path, init) => {
                if (path === `/agent`) {
                    vi.setSystemTime(Date.now() + 60_000);
                }
                return instant(path, init);
            });
            await vi.advanceTimersByTimeAsync(15_000);
            expect(conversation.autoContinueAt.value! - Date.now()).toBe(5_000);
        } finally {
            vi.useRealTimers();
        }
    });

    /* THE CASE THE WHOLE THING IS FOR: a tool the user refused, the agent stopped waiting to be told what to do,
     * and the sentence that tells it. It has to name the refusal — a bare "continue" reads as "go on then, run
     * it", which is how a declined command gets run on the second press — and it has to FOLD, so that pressing
     * the button leaves the transcript exactly as pinned as typing the word did. */
    it(`arms the continue offer when a denied tool stops the turn, with the sentence that names the refusal`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `permission`, requestId: `p1`, toolName: `Bash` }], { stayOpen: true }));

        const turn = conversation.send(`clean the sandbox`, settings);
        await vi.waitFor(() => expect(conversation.awaitingDecision.value).toBe(true));
        await conversation.decidePermission(
            conversation.messages.value.find((message) => message.permission !== undefined)!,
            `deny`,
        );
        await turn;

        expect(conversation.resumable.value).toBe(true);
        const text = continuationFor(conversation.messages.value);
        expect(text).toBe(CONTINUATIONS.afterDenial);
        // Allowing the same tool instead leaves the ordinary sentence — there is no refusal to carry on without.
        expect(continuationFor([{ id: 1, role: `user`, text: `hi`, permission: { requestId: `p1`, toolName: `Bash`, status: `allowed` } }])).toBe(
            CONTINUATIONS.plain,
        );

        // Both sentences are nudges, not new instructions: they fold into the turn they continue, so the prompt
        // that defines the work keeps the pin.
        for (const sentence of Object.values(CONTINUATIONS)) {
            expect(foldsIntoTurn({ id: 1, role: `user`, text: sentence }), sentence).toBe(true);
        }
        expect(turnsOf([...conversation.messages.value, { id: 99, role: `user`, text }]).map((group) => group.id)).toEqual([
            conversation.messages.value[0]!.id,
        ]);
    });

    it(`self-heals a dead session id: drops it on a session-not-found error and notices instead of erroring`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `session`, sessionId: `s-1` }]));
        await conversation.send(`first`, settings);

        // The agent lost the session inside its own process mid-turn — the daemon reseeds whatever it can see for
        // itself, so this code reaches the client only for the one runtime whose sessions it cannot see.
        sandboxRequestMock.mockImplementation(
            sseResponse([
                { kind: `error`, code: `session-not-found`, message: `The agent restarted and cannot resume this chat's session.` },
                { kind: `done` },
            ]),
        );
        await conversation.send(`second`, settings);

        expect(conversation.session.value).toBeUndefined();
        // The runtime's OWN sentence: this line used to state a cause it cannot know ("the sandbox was rebuilt or
        // the session was deleted"), which was usually neither.
        expect(conversation.messages.value.at(-1)).toMatchObject({
            role: `notice`,
            text: `The agent restarted and cannot resume this chat's session.`,
        });
        expect(conversation.error.value).toBeNull();
        expect(conversation.status.value).not.toBe(`error`);

        // The next send starts fresh — no dead id on the wire. The conversation id is unchanged, so the daemon
        // reseeds the replacement session from its own record of this same conversation; nothing rides up.
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `session`, sessionId: `s-2` }]));
        await conversation.send(`third`, settings);
        const thirdBody = turnBodies()[2]!;
        expect(`sessionId` in thirdBody).toBe(false);
        expect(`history` in thirdBody).toBe(false);
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

    /* A spent allowance names its reset instant and stops there. Nothing re-runs the turn and nothing is armed:
     * the allowance is the user's own budget, so the next send is theirs to make. A daemon old enough to still
     * send an `autoResume` verdict on a rate_limit frame changes none of that. */
    it(`names the reset instant on a usage limit and arms nothing`, async () => {
        const conversation = new Conversation(`c1`);
        const resetsAt = Math.floor(Date.now() / 1000) + 3_600;
        sandboxRequestMock.mockImplementation(
            sseResponse([
                { kind: `error`, code: `rate_limit`, message: `Claude usage limit reached.`, resetsAt, autoResume: `scheduled` },
                { kind: `done` },
            ]),
        );
        await conversation.send(`hello`, settings);

        const notice = conversation.messages.value.at(-1)!;
        expect(notice.role).toBe(`notice`);
        expect(notice.text).toContain(`Resets`);
        expect(notice.text).not.toContain(`Auto-resume`);
        // No offer banner and no opt-out: there is no automation here to describe or to regret.
        expect(notice.noticeAction).toBeUndefined();
        expect(conversation.failures.outageResume.value).toBeUndefined();
        expect(conversation.error.value).toBeNull();
    });

    /* A PROVIDER OUTAGE, which reads like a limit hit and behaves nothing like one: no reset instant to aim at,
     * an escalating wait instead of a fixed one, and a bounded number of tries. What must survive refactors is the
     * severity — the turn is coming back, so a red line here would be reporting a failure the user never has to
     * act on — and the fact that the wait names an instant, because a silently growing backoff with no clock is
     * indistinguishable from nothing happening. */
    it(`reads an outage as a wait with its own clock, not as a crash`, async () => {
        const conversation = new Conversation(`c1`);
        // Far-future so the re-attach probe this arms stays parked for the test's lifetime.
        const retryAt = Math.floor(Date.now() / 1000) + 3_600;
        sandboxRequestMock.mockImplementation(
            sseResponse([
                {
                    kind: `error`,
                    code: `provider-outage`,
                    message: `API Error: 529 Overloaded.`,
                    autoResume: `scheduled`,
                    outage: { retryAt, attempt: 2, maxAttempts: 6 },
                },
                { kind: `done` },
            ]),
        );
        await conversation.send(`hello`, settings);

        const notice = conversation.messages.value.at(-1)!;
        expect(notice.role).toBe(`notice`);
        expect(notice.text).toContain(`attempt 2 of 6`);
        // The moment-of-regret opt-out rides the notice the automation's own firing produced.
        expect(notice.noticeAction).toBe(`outageOptOut`);
        expect(conversation.failures.outageResume.value).toEqual({ retryAt, attempt: 2, maxAttempts: 6, scheduled: true });
        expect(conversation.error.value).toBeNull();
        expect(conversation.status.value).not.toBe(`error`);
        conversation.abort();
    });

    /* A ROTATED CREDENTIAL. The daemon re-mints and re-runs the turn within a scheduler pass, so this reads as a
     * wait rather than a crash — but the wait has to be VISIBLE and, above all, WATCHED. Both were missing: the
     * notice promised a continuation and nothing was armed to catch it, so the chat sat on this line while
     * /agents reported the same agent working. */
    it(`reads a rotated credential as a wait it is actually watching`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(
            sseResponse([
                {
                    kind: `error`,
                    code: `claude-token-refused`,
                    message: `Failed to authenticate. API Error: 401 OAuth access token has been revoked`,
                    autoResume: `scheduled`,
                },
                { kind: `done` },
            ]),
        );
        await conversation.send(`hello`, settings);

        const notice = conversation.messages.value.at(-1)!;
        expect(notice.role).toBe(`notice`);
        expect(notice.text).toContain(`being renewed`);
        // The spinner: the line declares which wait it describes, and the conversation says the wait is on.
        expect(notice.noticeWait).toBe(`credentialRenewal`);
        expect(conversation.failures.credentialRenewal.value).toBeDefined();
        expect(conversation.error.value).toBeNull();
        // Not a reauth: the account is fine, and lighting its badge would send the user to fix nothing.
        expect(providerAccounts.value[`claude`]?.some((account) => account.needsReauth === true)).not.toBe(true);
        conversation.abort();
    });

    /* THE BUG THIS WHOLE PATH EXISTS FOR. Attach streams are pull: the daemon's resumed run reaches a window only
     * if that window goes looking. Nothing did, so the chat kept showing the frame it died on while /agents
     * reported the same agent working, and the only way back was reloading the browser. */
    it(`goes looking for the resumed run and renders it, without the user doing anything`, async () => {
        vi.useFakeTimers();
        try {
            const conversation = new Conversation(`c1`);
            sandboxRequestMock.mockImplementation(
                sseResponse([{ kind: `error`, code: `claude-token-refused`, message: `401 revoked`, autoResume: `scheduled` }, { kind: `done` }]),
            );
            await conversation.send(`refactor the store`, settings);
            expect(conversation.failures.credentialRenewal.value).toBeDefined();

            // What the daemon started a moment later: the same request, behind the note saying why it re-ran —
            // and a run of its OWN, because resuming starts a turn rather than reviving the one that died. That
            // is what keeps the renewal notice above: it belongs to the run that failed, and only that run's own
            // rows come off when this window attaches to a run it has already drawn.
            sandboxRequestMock.mockImplementation(() => {
                const body = new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(sseFrame(head({ run: `r2`, prompt: withResumeNote(`refactor the store`, RESUME_NOTES.auth) })));
                        controller.enqueue(sseFrame({ kind: `frame`, seq: 1, event: { kind: `delta`, text: `Picking it back up.` } }));
                        controller.enqueue(sseFrame({ kind: `end` }));
                        controller.close();
                    },
                });
                return Promise.resolve({ ok: true, body } as Response);
            });
            await vi.advanceTimersByTimeAsync(2_000);

            // The wait is over, and the resumed answer is in the transcript under the original question.
            expect(conversation.failures.credentialRenewal.value).toBeUndefined();
            expect(conversation.messages.value.map(({ role, text }) => ({ role, text }))).toEqual([
                { role: `user`, text: `refactor the store` },
                { role: `assistant`, text: `` },
                { role: `notice`, text: expect.stringContaining(`being renewed`) },
                { role: `assistant`, text: `Picking it back up.` },
            ]);
        } finally {
            vi.useRealTimers();
        }
    });

    // The other half of the promise: the spinner belongs to a turn that comes back, so a turn attaching stops it.
    it(`stops the renewal spinner when the resumed turn lands`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(
            sseResponse([{ kind: `error`, code: `claude-token-refused`, message: `401 revoked`, autoResume: `scheduled` }, { kind: `done` }]),
        );
        await conversation.send(`hello`, settings);
        expect(conversation.failures.credentialRenewal.value).toBeDefined();

        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `delta`, text: `back` }, { kind: `done` }]));
        await conversation.send(`again`, settings);
        expect(conversation.failures.credentialRenewal.value).toBeUndefined();
    });

    // With nothing armed the daemon is telling us this turn is NOT coming back — the one case where the user
    // really is needed. A spinner here would be a promise nothing was going to keep.
    it(`asks for a reconnect when no renewal is armed`, async () => {
        const conversation = new Conversation(`c1`);
        conversation.account.value = `acct-1`;
        providerAccounts.value = { ...providerAccounts.value, claude: [{ id: `acct-1`, label: `Claude`, connectedAt: 0 }] };
        sandboxRequestMock.mockImplementation(
            sseResponse([{ kind: `error`, code: `claude-token-refused`, message: `401 revoked` }, { kind: `done` }]),
        );
        await conversation.send(`hello`, settings);

        const notice = conversation.messages.value.at(-1)!;
        expect(notice.text).toContain(`Reconnect`);
        expect(notice.noticeWait).toBeUndefined();
        expect(conversation.failures.credentialRenewal.value).toBeUndefined();
        expect(providerAccounts.value[`claude`]?.[0]?.needsReauth).toBe(true);
    });

    it(`hands the message back and says so plainly once the retries are spent`, async () => {
        const conversation = new Conversation(`c1`);
        // No `outage` block: the daemon's attempts are gone, so nothing is coming back.
        sandboxRequestMock.mockImplementation(
            sseResponse([{ kind: `error`, code: `provider-outage`, message: `API Error: 500 Internal server error.` }, { kind: `done` }]),
        );
        await conversation.send(`hello`, settings);

        // The red line is now honest — and the words the user typed are back in the queue rather than lost with
        // the turn, which is the part of this failure that was ever actually ours.
        expect(conversation.error.value).toContain(`500`);
        expect(conversation.failures.outageResume.value).toBeUndefined();
        expect(conversation.queued.value.some((message) => message.text === `hello`)).toBe(true);
    });

    it(`offers turning outage auto-resume on when the daemon only remembered the turn`, async () => {
        const conversation = new Conversation(`c1`);
        const retryAt = Math.floor(Date.now() / 1000) + 3_600;
        sandboxRequestMock.mockImplementation(
            sseResponse([
                {
                    kind: `error`,
                    code: `provider-outage`,
                    message: `API Error: 500 Internal server error.`,
                    autoResume: `available`,
                    outage: { retryAt, attempt: 1, maxAttempts: 6 },
                },
                { kind: `done` },
            ]),
        );
        await conversation.send(`hello`, settings);

        expect(conversation.failures.outageResume.value).toEqual({ retryAt, attempt: 1, maxAttempts: 6, scheduled: false });
        // Nothing is armed, so no opt-out is offered — there is nothing to opt out of yet.
        expect(conversation.messages.value.at(-1)!.noticeAction).toBeUndefined();

        // Enabling the setting arms the very turn that bounced, daemon-side; this reflects it.
        conversation.failures.armOutageResume();
        expect(conversation.failures.outageResume.value?.scheduled).toBe(true);
        expect(conversation.messages.value.at(-1)!.text).toContain(`Auto-resume enabled`);
        conversation.abort();
    });

    // The turn is alive here — a status, never a transcript line, and it must not outlive the turn it describes.
    it(`shows an in-turn provider retry as live status and drops it when the turn settles`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(
            sseResponse([
                { kind: `provider_retry`, attempt: 3, maxAttempts: 300, nextAttemptAt: Date.now() + 45_000, status: 529 },
                { kind: `delta`, text: `back` },
                { kind: `done` },
            ]),
        );
        await conversation.send(`hello`, settings);

        expect(conversation.providerRetry.value).toBeUndefined();
        expect(conversation.messages.value.some((message) => message.role === `notice` && message.text.includes(`retry`))).toBe(false);
        expect(conversation.error.value).toBeNull();
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

    it(`forkFrom copies the turns above the cut and seeds a fresh session from them`, async () => {
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

        const fork = new Conversation(`c2`);
        fork.forkFrom(source, index, `now`);
        sandboxRequestMock.mockImplementation(
            sseResponse([
                { kind: `session`, sessionId: `s-2` },
                { kind: `delta`, text: `redone` },
            ]),
        );
        await fork.send(`second, revised`, settings);

        // The fork carries the turns above the cut, then its own first turn and the answer to it.
        expect(fork.messages.value.map((message) => message.text)).toEqual([`first`, `one`, `second, revised`, `redone`]);
        /* The fork is a new conversation daemon-side: no session id rides. What rides instead is where it was
         * cut from — two RECORD rows (the "first" prompt and the "one" answer) — so the daemon copies that
         * prefix of c1's record into c2's before running, and the fork seeds itself from there like any other
         * conversation. The bubbles themselves never go up. */
        const body = turnBodies()[2]!;
        expect(`sessionId` in body).toBe(false);
        expect(`history` in body).toBe(false);
        expect(body[`forkOf`]).toEqual({ conversationId: `c1`, keep: 2, files: `now` });
        expect(fork.session.value).toMatchObject({ id: `s-2`, provider: `claude` });
        expect(fork.conversationId).not.toBe(source.conversationId);
        // Named once. The copy has happened, so a later turn is an ordinary turn on an ordinary conversation.
        await fork.send(`again`, settings);
        expect(`forkOf` in turnBodies()[3]!).toBe(false);
        // The point of forking: the source keeps its own transcript and session, untouched.
        expect(source.messages.value.map((message) => message.text)).toEqual([`first`, `one`, `second`, `two`]);
        expect(source.session.value).toMatchObject({ id: `s-1` });
        expect(source.contextUsage.value).toMatchObject({ tokens: 500, contextWindow: 1000 });
    });

    /* THE LINKAGE MUST OUTLIVE EVERYTHING SHORT OF THE ACK. Until the daemon accepts the fork's first turn,
     * `pendingForkOf` is the only record anywhere that this conversation IS a fork — which is why it is a
     * public ref the tab snapshot persists (a fork rebuilt after a reload, or hydrated in the popped window,
     * must still name its source), and why a send refused at the door must not consume it. Both losses ended
     * the same way in the field: the first send opened an ordinary empty conversation daemon-side, and a chat
     * that LOOKED continued answered from nothing. */
    it(`keeps the fork linkage through a refused first send and spends it on the ack`, async () => {
        const source = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(
            sseResponse([
                { kind: `session`, sessionId: `s-1` },
                { kind: `delta`, text: `one` },
            ]),
        );
        await source.send(`first`, settings);

        const fork = new Conversation(`c2`);
        fork.forkFrom(source, 2, `now`);
        // Where the tab snapshot reads it (snapshotTab) and a rebuilt tab puts it back (restoreTab).
        expect(fork.pendingForkOf.value).toEqual({ conversationId: `c1`, keep: 2, files: `now` });

        // Turned away at the door: nothing ran daemon-side, so the linkage is not spent — the words are held
        // in the queue and the retry must still name the source.
        sandboxRequestMock.mockResolvedValue(new Response(JSON.stringify({ message: `nope` }), { status: 400 }));
        await fork.send(`carry on differently`, settings);
        expect(fork.pendingForkOf.value).toEqual({ conversationId: `c1`, keep: 2, files: `now` });

        // The user sends again; the held words ride the fresh turn, and the cut rides with them.
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `session`, sessionId: `s-2` }]));
        await fork.enqueue(``);
        const retry = turnBodies().at(-1)!;
        expect(retry[`forkOf`]).toEqual({ conversationId: `c1`, keep: 2, files: `now` });
        // The ack is what spends it: from here the fork's record stands on its own.
        expect(fork.pendingForkOf.value).toBeUndefined();
    });

    it(`a fork taken at the first message starts empty and names itself from its own first message`, async () => {
        const source = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(
            sseResponse([
                { kind: `session`, sessionId: `s-1` },
                { kind: `delta`, text: `hi!` },
            ]),
        );
        await source.send(`original topic`, settings);
        expect(source.title.value).toBe(`Original topic`);

        const fork = new Conversation(`c2`);
        fork.forkFrom(source, 0, `now`);
        expect(fork.messages.value).toEqual([]);
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `session`, sessionId: `s-2` }]));
        await fork.send(`new topic`, settings);

        // Each tab is findable by its own name rather than two tabs sharing one.
        expect(fork.title.value).toBe(`New topic`);
        expect(source.title.value).toBe(`Original topic`);
        // Nothing preceded the cut, so the fresh session gets neither a session id nor a history seed.
        const body = turnBodies()[1]!;
        expect(`sessionId` in body).toBe(false);
        expect(`history` in body).toBe(false);
    });

    /* THE TWO KINDS OF NOTICE, and why a fork has to tell them apart. A notice this window drew (a provider
     * switch, a rewind) exists nowhere in the daemon's record. One the daemon WROTE DOWN — a refused turn, a
     * turn it resumed by itself — is a row of that record like any other, and counting it out told the daemon
     * to copy fewer rows than the user had selected: the tail of the branch went missing, silently, for every
     * conversation that had ever seen a provider error. */
    it(`a fork counts the notices the daemon recorded and skips the ones drawn locally`, async () => {
        const source = new Conversation(`c1`);
        source.restoreMessages([
            { role: `user`, text: `ship the parser` },
            { role: `assistant`, text: `on it` },
            { role: `notice`, text: `Failed to authenticate. API Error: 401.` },
            { role: `notice`, text: `Claude sign-in renewed — this turn picked up where it left off.` },
            { role: `assistant`, text: `picking back up` },
        ]);
        // …and one this window wrote itself, which the record knows nothing about.
        source.selectProvider(`codex`);
        expect(source.messages.value.at(-1)!.role).toBe(`notice`);

        const fork = new Conversation(`c2`);
        fork.forkFrom(source, source.messages.value.length, `now`);
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `session`, sessionId: `s-2` }]));
        await fork.send(`carry on`, { ...settings, agent: `codex`, model: `` });
        // Five recorded rows: the switch notice at the end is this window's own and is not one of them.
        expect(turnBodies()[0]![`forkOf`]).toEqual({ conversationId: `c1`, keep: 5, files: `now` });
    });

    it(`a fork carries the source's provider selection and drops its pending switch notice`, async () => {
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

        // Branching before the notice leaves it behind — it belongs to the source's segment cut, not the fork.
        const fork = new Conversation(`c2`);
        fork.forkFrom(source, 0, `now`);
        expect(fork.provider.value).toBe(`codex`);
        expect(fork.messages.value.every((message) => message.role !== `notice`)).toBe(true);

        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `session`, sessionId: `thr-1` }]));
        await fork.send(`first, revised`, { ...settings, agent: `codex`, model: `` });
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

    /* A RUN THE DAEMON RESTARTED. Its prompt is the user's words behind a note explaining the interruption
     * (RESUME_NOTES), and rendering the head verbatim put that machine prose into the transcript as a message the
     * user had supposedly typed — directly under the copy they really did type. Stripped, it matches the bubble
     * that is already there, so the resumed run continues under the original question. */
    it(`reattach continues the original prompt when the daemon resumed the turn`, async () => {
        const conversation = new Conversation(`c1`);
        conversation.restoreMessages([{ role: `user`, text: `refactor the store` }]);
        sandboxRequestMock.mockImplementation(() => {
            const body = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(sseFrame(head({ prompt: withResumeNote(`refactor the store`, RESUME_NOTES.auth) })));
                    controller.enqueue(sseFrame({ kind: `frame`, seq: 1, event: { kind: `delta`, text: `Picking it back up.` } }));
                    controller.enqueue(sseFrame({ kind: `end` }));
                    controller.close();
                },
            });
            return Promise.resolve({ ok: true, body } as Response);
        });

        await expect(conversation.reattach()).resolves.toBe(true);

        expect(conversation.messages.value.map(({ role, text }) => ({ role, text }))).toEqual([
            { role: `user`, text: `refactor the store` },
            { role: `assistant`, text: `Picking it back up.` },
        ]);
    });

    /* THE ANSWER DRAWN TWICE. A sandbox restart while the turn was parked on a question cannot un-park the run
     * that died with it, so the daemon starts a fresh one carrying the user's answer (RESUME_NOTES.answered) and
     * this window renders it. Then the stream drops — a restart is exactly when one does — and the window
     * attaches to that SAME run again.
     *
     * An attach replays its run from the first frame, and a resumed run's bubble deliberately keeps whatever sits
     * under it, because normally that is the dead run's work. Here it was this run's own answer, so the whole
     * thing landed a second time, verbatim, under the one bubble. */
    it(`reattaching to a resumed park's run redraws its answer instead of stacking a second copy`, async () => {
        const conversation = new Conversation(`c1`);
        conversation.restoreMessages([{ role: `user`, text: `which shape should it be?` }]);
        const carried = withResumeNote(`The user answered: a mode of the board.`, RESUME_NOTES.answered);
        sandboxRequestMock.mockImplementation(() => {
            const body = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(sseFrame(head({ run: `r2`, prompt: carried })));
                    controller.enqueue(sseFrame({ kind: `frame`, seq: 1, event: { kind: `delta`, text: `That settles it.` } }));
                    controller.enqueue(sseFrame({ kind: `end` }));
                    controller.close();
                },
            });
            return Promise.resolve({ ok: true, body } as Response);
        });

        await expect(conversation.reattach()).resolves.toBe(true);
        await expect(conversation.reattach()).resolves.toBe(true);

        expect(conversation.messages.value.map(({ role, text }) => ({ role, text }))).toEqual([
            { role: `user`, text: `which shape should it be?` },
            // The answer the daemon carried in, as its own bubble — words the transcript had never shown — and
            // exactly one copy of what the run made of it.
            { role: `user`, text: `The user answered: a mode of the board.` },
            { role: `assistant`, text: `That settles it.` },
        ]);
    });

    /* The other resume shape, and why the reclaim goes by RUN rather than by position: a re-run's bubble sits
     * above the work of the run that died, which nothing will ever redraw. Attaching twice has to take back this
     * run's own answer and leave that alone — truncating to the bubble would take both. */
    it(`reattaching to a re-run replaces only its own answer, keeping the dead run's work above it`, async () => {
        const conversation = new Conversation(`c1`);
        conversation.restoreMessages([
            { role: `user`, text: `refactor the store` },
            { role: `assistant`, text: `Got as far as the reducer.` },
        ]);
        sandboxRequestMock.mockImplementation(() => {
            const body = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(sseFrame(head({ run: `r2`, prompt: withResumeNote(`refactor the store`, RESUME_NOTES.restart) })));
                    controller.enqueue(sseFrame({ kind: `frame`, seq: 1, event: { kind: `delta`, text: `Picking it back up.` } }));
                    controller.enqueue(sseFrame({ kind: `end` }));
                    controller.close();
                },
            });
            return Promise.resolve({ ok: true, body } as Response);
        });

        await expect(conversation.reattach()).resolves.toBe(true);
        await expect(conversation.reattach()).resolves.toBe(true);

        expect(conversation.messages.value.map(({ role, text }) => ({ role, text }))).toEqual([
            { role: `user`, text: `refactor the store` },
            { role: `assistant`, text: `Got as far as the reducer.` },
            { role: `assistant`, text: `Picking it back up.` },
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
            actsAs: undefined,
            model: `opus`,
            effort: `medium`,
            thinking: false,
            fast: false,
            account: `acct-dead`,
        });

        expect(conversation.messages.value.map((message) => message.role)).toEqual([`notice`]);
        expect(conversation.queued.value.map((message) => message.text)).toEqual([`land the branch`]);
        // Muted, not the red error line: the fix is one click away on the banner this raises.
        expect(conversation.error.value).toBeNull();
    });

    /* The harness read the leading `/` as a command it doesn't have and discarded the rest of the message, so
     * the model never saw it and the daemon's transcript has no user turn to restore — the bubble in this
     * window is the only copy left. Same hold as a revoked credential, for the same reason: nothing ran. */
    it(`holds the message when the harness ate it as an unknown slash command`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(
            sseResponse([
                {
                    kind: `error`,
                    code: `unknown-command`,
                    message: "`/workspace` isn't a command this agent has, so it read your message as one and dropped the rest.",
                },
            ]),
        );

        await conversation.send(`/workspace view does not remember the file tree`, {
            agent: `claude`,
            harness: `native`,
            actsAs: undefined,
            account: undefined,
            model: `opus`,
            effort: `medium`,
            thinking: false,
            fast: false,
        });

        expect(conversation.messages.value.map((message) => message.role)).toEqual([`notice`]);
        // Held verbatim, leading slash and all — retyping it is exactly what the user should not have to do.
        expect(conversation.queued.value.map((message) => message.text)).toEqual([`/workspace view does not remember the file tree`]);
        // Muted: sending again is the fix, and the daemon now knows the command list well enough to let it past.
        expect(conversation.error.value).toBeNull();
    });

    /* THE REFUSAL THAT NEVER BECAME A TURN. The daemon turned the POST away at the door, so there is no error
     * FRAME to classify and none of the machinery above ran — which is exactly how this path came to do neither
     * of the two things every code up there does. What it left instead was a bare "Chat request failed (400)"
     * naming nothing the user could fix, their words stranded in a transcript no daemon has a record of, and a
     * conversation the fleet never registered: a card on the board with no archive, no discard and no drop.
     *
     * Both halves are asserted because either alone still strands them. The daemon's own sentence, because the
     * status code is not a thing anybody can act on. And the words back in the QUEUE — held there, not flushed:
     * a queue that re-sent itself would re-fail identically for as long as the cause stood. */
    it(`says why the daemon refused the turn, and takes the undelivered message back`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockResolvedValue(new Response(JSON.stringify({ message: `invalid attachment path: ../../etc/passwd` }), { status: 400 }));

        await conversation.send(`redesign the settings page`, {
            agent: `claude`,
            harness: `native`,
            actsAs: undefined,
            account: undefined,
            model: `opus`,
            effort: `medium`,
            thinking: false,
            fast: false,
        });

        expect(conversation.error.value).toBe(
            `invalid attachment path: ../../etc/passwd Your message is held below — send it again once that's sorted.`,
        );
        expect(conversation.queued.value.map((message) => message.text)).toEqual([`redesign the settings page`]);
        // Out of the transcript entirely: nothing about this send is part of the conversation, here or daemon-side.
        expect(conversation.messages.value).toEqual([]);
    });

    // A 409 is the one refusal that keeps neither half: a turn IS running on this conversation, so these words
    // are its to take as steering and the queue has to stay free to flush into it when it settles.
    it(`leaves the queue alone when the refusal is that a turn is already running`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockResolvedValue(new Response(JSON.stringify({ message: `a turn is already running` }), { status: 409 }));

        await conversation.send(`and the docs`, {
            agent: `claude`,
            harness: `native`,
            actsAs: undefined,
            account: undefined,
            model: `opus`,
            effort: `medium`,
            thinking: false,
            fast: false,
        });

        expect(conversation.error.value).toBe(`This agent already has a turn running — wait for it to finish.`);
        expect(conversation.queued.value).toEqual([]);
    });

    it(`replays the held message once the account is reconnected`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(
            sseResponse([{ kind: `error`, code: `claude-reauth`, message: `Claude sign-in was revoked — reconnect the account.` }]),
        );
        await conversation.send(`land the branch`, {
            agent: `claude`,
            harness: `native`,
            actsAs: undefined,
            model: `opus`,
            effort: `medium`,
            thinking: false,
            fast: false,
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
        await conversation.send(`hi`, {
            agent: `claude`,
            harness: `native`,
            actsAs: undefined,
            model: `opus`,
            effort: `medium`,
            thinking: false,
            fast: false,
            account: `acct-dead`,
        });

        conversation.rebindAccount(`acct-new`);
        await conversation.send(`again`, {
            agent: `claude`,
            harness: `native`,
            actsAs: undefined,
            model: `opus`,
            effort: `medium`,
            thinking: false,
            fast: false,
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

    it(`surfaces a genuine 409 start without claiming which window owns the turn`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockResolvedValue({ ok: false, status: 409 } as Response);

        await conversation.send(`Hi`, settings);

        expect(conversation.error.value).toBe(`This agent already has a turn running — wait for it to finish.`);
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

        conversation.restoreMessages([{ role: `user`, text: `analyze this`, attachments: [`${STATE_DIR}/artifacts/attachments/uuid-1/image.png`] }]);

        expect(conversation.messages.value[0]).toMatchObject({
            role: `user`,
            text: `analyze this`,
            attachments: [{ name: `image.png`, path: `.intentic/artifacts/attachments/uuid-1/image.png` }],
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

/* THE CLOCK'S WINDOW. A popped-out chat is DOM teleported into a second real window while this module keeps
 * running in the opener's realm (composables/usePopout.ts), and rendering steps belong to a window: the opener,
 * sitting behind the chat window the user is working in, is given none. A clock armed there stops — the frames
 * pile up in the inbox and the panel out there shows a live-looking transcript that never moves, which is what
 * "the popped-out chat stopped reacting" is. So the panel announces which window its rows are in, and the two
 * tests below pin both halves: the frames are asked of THAT window, and a frame that never comes cannot park
 * the transcript for good. */
describe(`the transcript's clock`, () => {
    // A window that hands out frames on request — what the pop-out is, and what this realm is not while it sits
    // behind it.
    const viewWithFrames = (): { view: Window; deliver: () => void } => {
        const owed: FrameRequestCallback[] = [];
        return {
            view: { requestAnimationFrame: (callback: FrameRequestCallback) => owed.push(callback) } as unknown as Window,
            deliver: () => owed.splice(0, owed.length).forEach((callback) => callback(0)),
        };
    };

    it(`asks the window the panel is displayed in for its frames, not the realm it runs in`, async () => {
        const conversation = new Conversation(`c-popped`);
        const opener: FrameRequestCallback[] = [];
        vi.stubGlobal(`requestAnimationFrame`, (callback: FrameRequestCallback) => opener.push(callback));
        const { view, deliver } = viewWithFrames();
        transcriptView.value = view;
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `delta`, text: `hi` }], { stayOpen: true }));

        const turn = conversation.send(`go`, settings);
        // Delivered per poll rather than once: the head opens the stream a beat before the delta rides in, so
        // the frame the transcript is waiting on is not always the first one owed.
        await vi.waitFor(() => {
            deliver();
            expect(conversation.messages.value.at(-1)).toMatchObject({ role: `assistant`, text: `hi` });
        });

        // The opener was never asked. Being asked is the whole bug: it answers when it is in front and goes
        // silent when it is behind, which is exactly backwards for a panel that lives in the other window.
        expect(opener).toHaveLength(0);

        conversation.stop();
        await turn;
    });

    it(`applies frames on its own timer when the window it asked never delivers one`, async () => {
        const conversation = new Conversation(`c-parked`);
        // Frames requested and never delivered: the chat window minimized, or — the one that used to be
        // permanent — a pop-out closed while still owing the frame the armed clock was waiting on.
        transcriptView.value = viewWithFrames().view;
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `delta`, text: `hi` }], { stayOpen: true }));

        const turn = conversation.send(`go`, settings);

        await vi.waitFor(() => expect(conversation.messages.value.at(-1)).toMatchObject({ role: `assistant`, text: `hi` }), { timeout: 2_000 });

        conversation.stop();
        await turn;
    });

    /* The rewind's one genuine hazard: the DAEMON's transcript index and the BUBBLE's position are different
     * numbers, and they diverge the moment a local notice is drawn. Sending the bubble position would restore
     * a different turn than the one clicked and drop a different set of messages. */
    it(`rewinds by the daemon's transcript index and truncates by the bubble's, then drops the session`, async () => {
        const conversation = new Conversation(`c-rewind`);
        sandboxRequestMock.mockImplementation(
            sseResponse([
                { kind: `session`, sessionId: `s-1` },
                // index 0: the daemon has this turn's user message at the head of its record.
                { kind: `checkpoint`, id: `cp-1`, index: 0 },
                { kind: `delta`, text: `done` },
                { kind: `done` },
            ]),
        );
        await conversation.send(`first`, settings);
        expect(conversation.session.value).toBeDefined();

        const user = conversation.messages.value[0];
        expect(user).toMatchObject({ role: `user`, checkpointId: `cp-1`, rewindIndex: 0 });

        sandboxRequestMock.mockImplementation(async () => new Response(JSON.stringify({ snapshot: `cp-1`, dropped: 2 }), { status: 200 }));
        expect(await conversation.rewindTo(user!)).toBe(true);

        const [path, init] = sandboxRequestMock.mock.calls.at(-1)!;
        expect(path).toBe(`/agent/rewind`);
        expect(JSON.parse(init!.body as string)).toEqual({ conversationId: `c-rewind`, index: 0 });
        /* Everything from the rewound message on is gone, and the next send starts a fresh provider thread.
         * What stands in its place is the line saying so: a transcript that merely stopped two messages short
         * looks exactly like one that was always that length, and the workspace having moved with it is the
         * part nothing else on screen would ever mention. */
        expect(conversation.messages.value).toEqual([
            expect.objectContaining({ role: `notice`, text: `Went back to here — 2 messages dropped and the files restored to this point.` }),
        ]);
        expect(conversation.session.value).toBeUndefined();
    });

    it(`leaves the tab untouched when the daemon refuses the rewind`, async () => {
        const conversation = new Conversation(`c-busy`);
        sandboxRequestMock.mockImplementation(
            sseResponse([{ kind: `session`, sessionId: `s-1` }, { kind: `checkpoint`, id: `cp-1`, index: 0 }, { kind: `done` }]),
        );
        await conversation.send(`first`, settings);
        const before = conversation.messages.value.length;

        sandboxRequestMock.mockImplementation(async () => new Response(`busy`, { status: 409 }));
        expect(await conversation.rewindTo(conversation.messages.value[0]!)).toBe(false);

        // A transcript cut against a workspace that never moved is the one state with no way back.
        expect(conversation.messages.value).toHaveLength(before);
        expect(conversation.session.value).toBeDefined();
        expect(conversation.error.value).toContain(`running a turn`);
    });
});

/* SPEAKING AS THE AGENT (Conversation.placeAsAgent) — the tab's half of agents.place. The daemon appends the
 * row to its record and forgets the provider session; these check the tab then agrees on both halves, and that
 * a refusal moves NOTHING — a bubble drawn for a row the record never took would be the transcript lying. */
describe(`Conversation placeAsAgent`, () => {
    it(`appends a marked agent bubble and drops the session, so the next send starts a fresh thread`, async () => {
        const conversation = new Conversation(`c-place`);
        sandboxRequestMock.mockImplementation(
            sseResponse([{ kind: `session`, sessionId: `s-1` }, { kind: `delta`, text: `done` }, { kind: `done` }]),
        );
        await conversation.send(`first`, settings);
        expect(conversation.session.value).toBeDefined();

        sandboxRequestMock.mockImplementation(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
        expect(await conversation.placeAsAgent(`I checked the tests.`)).toBe(true);

        const [path, init] = sandboxRequestMock.mock.calls.at(-1)!;
        expect(path).toBe(`/agents/c-place/place`);
        expect(JSON.parse(init!.body as string)).toEqual({ text: `I checked the tests.` });
        // The bubble reads as the agent's, carrying the mark whose one audience is the human re-reading this.
        expect(conversation.messages.value.at(-1)).toMatchObject({ role: `assistant`, text: `I checked the tests.`, placed: true });
        // And the local session matches the daemon's forgotten one — the next send resumes nothing.
        expect(conversation.session.value).toBeUndefined();
    });

    it(`leaves the tab untouched when the daemon refuses the place`, async () => {
        const conversation = new Conversation(`c-place-busy`);
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `session`, sessionId: `s-1` }, { kind: `done` }]));
        await conversation.send(`first`, settings);
        const before = conversation.messages.value.length;

        sandboxRequestMock.mockImplementation(async () => new Response(`busy`, { status: 409 }));
        expect(await conversation.placeAsAgent(`planted`)).toBe(false);

        expect(conversation.messages.value).toHaveLength(before);
        expect(conversation.session.value).toBeDefined();
        expect(conversation.error.value).toContain(`running a turn`);
    });

    // The mark survives a reopen: the record's `placed` maps back onto the bubble a restored tab draws.
    it(`restores a placed row with its mark`, () => {
        const conversation = new Conversation(`c-place-restore`);
        conversation.restoreMessages([
            { role: `user`, text: `map the flow` },
            { role: `assistant`, text: `I checked the tests.`, placed: true },
        ]);
        expect(conversation.messages.value.at(-1)).toMatchObject({ role: `assistant`, text: `I checked the tests.`, placed: true });
        expect(conversation.messages.value[0]).not.toHaveProperty(`placed`);
    });
});

/* WHEN EACH MESSAGE WAS SENT (ChatMessage.sentAt) — the stamp the bubble shows on hover. Three sources, and the
 * point of the group is that they agree: a turn sent here, a turn already running when this tab arrived, and a
 * turn read back out of the daemon's record all say the hour the user actually pressed send. */
describe(`Conversation sent time`, () => {
    it(`stamps a message the user sends here with the moment it was sent`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `delta`, text: `On it.` }, { kind: `done` }]));

        const before = Date.now();
        await conversation.send(`Hi there`, settings);

        const sentAt = conversation.messages.value[0]?.sentAt;
        expect(sentAt).toBeGreaterThanOrEqual(before);
        expect(sentAt).toBeLessThanOrEqual(Date.now());
        // Only the user's row. Nothing in the stream says when a given block of the answer was written, and a
        // bubble stamped with a time it has no claim to is worse than one that says nothing.
        expect(conversation.messages.value[1]?.sentAt).toBeUndefined();
    });

    // A turn that has been running since before this tab attached — a reload, a second window. Its bubble is
    // drawn now and was sent then, so it takes the RUN's start rather than the moment its reader turned up.
    it(`takes the running turn's own start for a bubble drawn on reattach`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(() =>
            Promise.resolve({
                ok: true,
                body: new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(sseFrame(head({ prompt: `refactor the parser`, startedAt: 1234, seq: 1 })));
                        controller.enqueue(sseFrame({ kind: `frame`, seq: 1, event: { kind: `delta`, text: `On it.` } }));
                        controller.enqueue(sseFrame({ kind: `end` }));
                        controller.close();
                    },
                }),
            } as Response),
        );

        await expect(conversation.reattach()).resolves.toBe(true);

        expect(conversation.messages.value[0]).toMatchObject({ role: `user`, text: `refactor the parser`, sentAt: 1234 });
    });

    // Reopened tomorrow, the same message keeps the hour it was typed at — the daemon wrote it down beside the
    // words (RestoredMessage.sentAt), and a redraw from the record must not re-date the conversation.
    it(`keeps the daemon's stamp when a stored transcript is restored`, () => {
        const conversation = new Conversation(`c1`);

        conversation.restoreMessages([
            { role: `user`, text: `start the migration`, sentAt: 1_767_225_600_000 },
            { role: `assistant`, text: `Done with step one.` },
        ]);

        expect(conversation.messages.value.map((message) => message.sentAt)).toEqual([1_767_225_600_000, undefined]);
    });
});
