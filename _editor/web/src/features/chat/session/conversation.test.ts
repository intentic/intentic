import { STATE_DIR } from "@intentic/constants";
import {
    type AgentEvent,
    type AgentReply,
    type AttachFrame,
    isAwaitingDecision,
    isTurnFact,
    mentionPaths,
    RESUME_NOTES,
    resumeDisclosure,
    type TranscriptRow,
    withoutResumeNote,
    withResumeNote,
    type MessageReceipt,
} from "@intentic/sandbox-contract";
import { TranscriptFold, userRow } from "@intentic/sandbox-contract/transcript-fold";
import { watch } from "vue";
import { waitFor, stubGlobal, unstubAllGlobals, advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { SandboxHttpError } from "../../sandbox/client/sandboxHttpError";
import type { SandboxCallContext } from "../../sandbox/client/sandboxRpc";
import { fakeSandboxRpc } from "../../../testing/sandboxRpcFake";
import { Conversation } from "./conversation";
import { planFeedback } from "./cardReplies";
import { seedFork } from "./forkSeed";
import { providerAccounts, usageByAccount } from "../accounts/providerAccounts";
import { turnDefaults } from "../run/turnDefaults";
import { resolvePrompt } from "../../agents/review/conflictResolution";
import { errands } from "../run/errands";
import {
    type ChatMessage,
    CONTINUATIONS,
    continuationFor,
    cutsAboveOf,
    dayMarksOf,
    foldsIntoTurn,
    forkCutsOf,
    isAcknowledgment,
    recordedRows,
    turnsOf,
} from "../transcript/transcript";
import type { AttachHead } from "../run/turnStream";

// How a call was aimed and paced, as the typed client hands it to a procedure.
interface CallOptions {
    readonly signal?: AbortSignal;
    readonly context?: SandboxCallContext;
}

// The daemon as this suite models it: one handler over each procedure's route name, since a turn's protocol spans
// several (start, attach, stop, reply) and a test swaps the whole of it at once. The box a call went to rides its context.
const { daemon } = { daemon: jest.fn<(procedure: string, input: unknown, options?: CallOptions) => Promise<unknown>>() };
// Each procedure a conversation calls, served by the model above; the answer is the model's to shape, so the client's
// own answer type is waived here and nowhere else.
const procedureOf =
    (name: string) =>
    (input: unknown, options?: CallOptions): never =>
        daemon(name, input, options) as never;
jest.mock("../../sandbox/client/sandboxRpc", () => ({
    sandboxRpc: fakeSandboxRpc({
        agent: {
            run: procedureOf(`agent.run`),
            attach: procedureOf(`agent.attach`),
            reply: procedureOf(`agent.reply`),
            stop: procedureOf(`agent.stop`),
            resume: procedureOf(`agent.resume`),
            queueResume: procedureOf(`agent.queueResume`),
            rewind: procedureOf(`agent.rewind`),
        },
        agents: { place: procedureOf(`agents.place`), transcript: procedureOf(`agents.transcript`) },
    }),
}));
// Every procedure this conversation called at a given box, in order.
const proceduresAimedAt = (at: string | undefined): string[] =>
    daemon.mock.calls.filter(([, , options]) => options?.context?.at === at).map(([procedure]) => procedure);
// A refusal, in the daemon's words: the status's own fallback when it said none.
const daemonRefusal = (status: number, message = `Request failed (${status}).`): SandboxHttpError => new SandboxHttpError(status, message);
// A call's input as the daemon receives it: JSON, so nothing undefined arrives.
const wire = (input: unknown): Record<string, unknown> => JSON.parse(JSON.stringify(input)) as Record<string, unknown>;

// Stubs useChat-catalog's reload so a model-invalid error doesn't pull in the whole chat store.
const loadProviderModelsMock = jest.fn(async () => {});
const loadTrialStatusMock = jest.fn(async () => {});
jest.mock("../models/useChat-catalog", () => ({ loadProviderModels: loadProviderModelsMock, loadTrialStatus: loadTrialStatusMock }));

// turnDefaults is a module singleton; reseed before each test.
const seedTurnDefaults = (): void => {
    turnDefaults.models.value = { claude: `opus`, codex: ``, grok: `` };
    turnDefaults.provider.value = `claude`;
};

// The typewriter drains via requestAnimationFrame; run frames synchronously so deltas land immediately.
beforeEach(() => {
    runsMinted = 0;
    seedTurnDefaults();
    stubGlobal(`requestAnimationFrame`, (callback: FrameRequestCallback): number => {
        callback(0);
        return 0;
    });
    stubGlobal(`cancelAnimationFrame`, () => {});
});

afterEach(() => {
    unstubAllGlobals();
    jest.clearAllMocks();
    seedTurnDefaults();
});

// One attach frame as it comes off the wire: parsed afresh, never an object the fixture still holds.
const frameOf = (payload: unknown): AttachFrame => JSON.parse(JSON.stringify(payload)) as AttachFrame;

// Run id counter shared across every fake daemon in a test, so runs from different fakes get different ids; reset
// each test.
let runsMinted = 0;

// Models the daemon's turn protocol (ack, attach replay via TranscriptFold, stop/reply) behind the procedures above.
// `head`, a thunk read per attach, overrides a resumed run's id, prompt and start time.
interface LiveRun {
    readonly controller: ReadableStreamDefaultController<AttachFrame>;
    readonly fold: TranscriptFold;
    seq: number;
    readonly queue: AgentEvent[];
    // Stamped onto every row this run emits, head and patches alike, as TurnRun does (turn-runs.ts).
    readonly run: string;
}
const turnDaemon = (
    events: AgentEvent[],
    options?: {
        stayOpen?: boolean;
        head?: () => Partial<{ run: string; prompt: string; rows: TranscriptRow[]; startedAt: number }>;
        // What the daemon does with a message said while a run is live: into it, or into the queue behind it.
        midTurn?: `steered` | `queued`;
    },
): ((procedure: string, input: unknown, call?: CallOptions) => Promise<unknown>) => {
    // The turn the last `agent.run` asked for: the head's opening row is built from it.
    let requested: { readonly prompt: string; readonly attachments: readonly string[]; readonly messageId: string | undefined } | undefined;
    // A stop that landed after the ack and before the attach: the run is over by the time its head goes out.
    let stopRequested = false;
    let live: LiveRun | undefined;
    // One run per turn started, each under its own id: a turn served under a prior run's id would rebase onto its
    // rows and replace them.
    let runId = `r1`;
    // The run's fold once served: a second attach to the same run gets its accumulated rows, not the events replayed
    // again.
    let served: TranscriptFold | undefined;
    const startTurn = (): void => {
        runsMinted += 1;
        runId = `r${runsMinted}`;
        served = undefined;
        stopRequested = false;
    };
    const ok = (): Promise<{ ok: true }> => Promise.resolve({ ok: true });
    const started = (): Promise<MessageReceipt> => Promise.resolve({ delivered: `started`, run: runId });
    const emit = (state: LiveRun, patches: ReturnType<TranscriptFold[`apply`]>): void => {
        for (const patch of patches) {
            const stamped = patch.op === `append` || patch.op === `replace` ? { ...patch, row: { ...patch.row, run: state.run } } : patch;
            state.controller.enqueue(frameOf({ kind: `patch`, seq: (state.seq += 1), patch: stamped }));
        }
    };
    const end = (state: LiveRun, ending: `settled` | `stopped`): void => {
        live = undefined;
        emit(state, state.fold.finish(ending));
        state.controller.enqueue(frameOf({ kind: `end` }));
        state.controller.close();
    };
    // A stop names its turn: by run, by a message it carries, or whatever is live for a caller naming neither. A run
    // taken and not attached to yet is over by the time its head goes out.
    const stopNamed = (body: Record<string, unknown>): boolean => {
        const names = (run: string, messages: readonly (string | undefined)[]): boolean =>
            body[`live`] === true || body[`run`] === run || (typeof body[`messageId`] === `string` && messages.includes(body[`messageId`]));
        if (live !== undefined) {
            const named = names(
                live.run,
                live.fold.rows.map((row) => row.messageId),
            );
            if (named) {
                end(live, `stopped`);
            }
            return named;
        }
        stopRequested = requested !== undefined && names(runId, [requested.messageId]);
        return stopRequested;
    };
    // Stream the queued events until they run out, or a card parks the turn on the user.
    const serve = (state: LiveRun): void => {
        while (state.queue.length > 0) {
            const event = state.queue.shift()!;
            emit(state, state.fold.apply(event));
            if (isTurnFact(event)) {
                state.controller.enqueue(frameOf({ kind: `fact`, seq: (state.seq += 1), fact: event }));
            }
            const last = state.fold.rows.at(-1);
            if (last !== undefined && isAwaitingDecision(last) && !state.queue.some((next) => next.kind === `resolved`)) {
                return;
            }
        }
        if (stopRequested) {
            end(state, `stopped`);
        } else if (options?.stayOpen !== true) {
            end(state, `settled`);
        }
    };
    // A message said while a run is live goes into it, or waits in the queue behind it; otherwise it starts a turn.
    const said = (body: Record<string, unknown>): Promise<MessageReceipt> => {
        if (live !== undefined) {
            return Promise.resolve(options?.midTurn === `queued` ? { delivered: `queued` } : { delivered: `steered`, run: live.run });
        }
        startTurn();
        requested = {
            prompt: String(body[`prompt`] ?? ``),
            attachments: (body[`attachments`] as string[] | undefined) ?? [],
            messageId: body[`messageId`] as string | undefined,
        };
        return started();
    };
    return (procedure, input, call) => {
        const body = input === undefined ? undefined : wire(input);
        if (procedure === `agent.run`) {
            return said(body ?? {});
        }
        // Resume runs the held turn as a new turn on its own prompt copy, as letting a held queue go does with its
        // words; the head that follows opens its own run rather than replacing the refused attempt's rows.
        if (procedure === `agent.resume` || procedure === `agent.queueResume`) {
            startTurn();
            return Promise.resolve({ run: runId });
        }
        if (procedure === `agent.stop`) {
            return Promise.resolve({ stopped: stopNamed(body ?? {}) });
        }
        if (procedure === `agent.reply` && live !== undefined) {
            const state = live;
            const reply = body as unknown as AgentReply;
            const dismissed = reply.kind === `question` && reply.cancelled === true;
            if (dismissed) {
                emit(state, state.fold.note({ role: `notice`, text: `Question dismissed.` }));
            }
            emit(state, state.fold.apply({ kind: `resolved`, requestId: reply.requestId, reply }));
            if (reply.kind === `plan`) {
                emit(state, state.fold.note({ role: `notice`, text: reply.approve ? `Plan approved.` : `Kept planning.` }));
                if (!reply.approve && reply.feedback !== undefined && reply.feedback.trim().length > 0) {
                    emit(state, state.fold.note(userRow(reply.feedback, Date.now(), mentionPaths(reply.feedback))));
                }
            }
            if (dismissed) {
                end(state, `stopped`);
            } else {
                serve(state);
            }
            return ok();
        }
        if (procedure !== `agent.attach`) {
            return ok();
        }
        const overrides = options?.head?.() ?? {};
        const run = overrides.run ?? runId;
        const startedAt = overrides.startedAt ?? Date.now();
        const opening =
            overrides.rows ??
            (overrides.prompt === undefined
                ? openingOf(requested?.prompt ?? `hi`, startedAt, requested?.attachments ?? [], requested?.messageId)
                : openingOf(overrides.prompt, startedAt));
        const stream = new ReadableStream<AttachFrame>({
            start(controller) {
                // Re-attach to a served run: the head already carries its rows, so nothing is left to fold in.
                const replay = served === undefined;
                const fold = served ?? new TranscriptFold(opening);
                served = fold;
                controller.enqueue(
                    frameOf({ kind: `attached`, run, startedAt, seq: 0, rows: structuredClone(fold.rows).map((row) => ({ ...row, run })) }),
                );
                const state: LiveRun = { controller, fold, seq: 0, queue: replay ? [...events] : [], run };
                live = state;
                call?.signal?.addEventListener(`abort`, () => {
                    if (live === state) {
                        live = undefined;
                    }
                    controller.error(new DOMException(`aborted`, `AbortError`));
                });
                serve(state);
            },
        });
        return Promise.resolve(stream);
    };
};

// A run's opening rows, matching the daemon's openingRows (turn-transcript.ts): a resumed run opens on its notice,
// an answered park opens on the answer under a note, otherwise the prompt itself, under the id its sender gave it or
// one the daemon names.
const openingOf = (prompt: string, sentAt: number, attachments: readonly string[] = [], messageId = `m-daemon`): TranscriptRow[] => {
    const resume = resumeDisclosure(prompt);
    if (resume?.kind === `notice`) {
        return [{ role: `notice`, text: resume.text }];
    }
    const row = userRow(withoutResumeNote(prompt), sentAt, attachments, messageId);
    return [resume?.kind === `note` ? { ...row, notes: [resume.note] } : row];
};

// The head frame of an attach stream: the run's identity and its rows so far, each row carrying that identity.
const head = (overrides?: Partial<{ run: string; prompt: string; startedAt: number; seq: number; rows: TranscriptRow[] }>): AttachHead => {
    const run = overrides?.run ?? `r1`;
    const rows = overrides?.rows ?? openingOf(overrides?.prompt ?? `hi`, overrides?.startedAt ?? 0);
    return { kind: `attached`, run, startedAt: overrides?.startedAt ?? 0, seq: overrides?.seq ?? 0, rows: rows.map((row) => ({ ...row, run })) };
};

// Serves a run one frame at a time for tests that hold the stream open and feed it by hand; `head()` gives the
// rows at that moment, as a re-attach would be handed.
const liveRun = (
    overrides?: Parameters<typeof head>[0],
): { head: () => AttachHead; frames: (event: AgentEvent) => AttachFrame[]; ending: (ending: `settled` | `stopped`) => AttachFrame[] } => {
    const opening = head(overrides);
    const fold = new TranscriptFold(opening.rows);
    let seq = opening.seq;
    const patches = (changed: ReturnType<TranscriptFold[`apply`]>): AttachFrame[] =>
        changed.map((patch) => ({ kind: `patch`, seq: (seq += 1), patch }));
    return {
        head: () => ({ ...opening, seq, rows: [...structuredClone(fold.rows)] }),
        frames: (event) => {
            const frames = patches(fold.apply(event));
            if (isTurnFact(event)) {
                frames.push({ kind: `fact`, seq: (seq += 1), fact: event });
            }
            return frames;
        },
        // Mirrors how the daemon unwinds a run: the open bubble closed and pending cards frozen as nobody's decision.
        ending: (ending) => patches(fold.finish(ending)),
    };
};

// Delivers one chunk per pull, then closes or errors, modeling a drop after the chunks arrived (erroring in
// `start()` would discard queued chunks).
const chunkStream = (chunks: unknown[], end: `close` | `error`): ReadableStream<AttachFrame> => {
    let next = 0;
    return new ReadableStream<AttachFrame>({
        pull(controller) {
            if (next < chunks.length) {
                controller.enqueue(frameOf(chunks[next]));
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

// Inputs of the turn-start (`agent.run`) calls, as the daemon receives them; attach/control calls interleave, so assert
// through this rather than raw call indexes.
const turnBodies = (): Record<string, unknown>[] =>
    daemon.mock.calls.filter(([procedure]) => procedure === `agent.run`).map(([, input]) => wire(input));

const settings = {
    agent: `claude`,
    harness: `native`,
    account: undefined,
    actsAs: undefined,
    startIn: undefined,
    model: `opus`,
    effort: `high`,
    thinking: false,
    fast: false,
} as const;

describe(`Conversation`, () => {
    it(`streams deltas into the assistant bubble and captures session, model, and title`, async () => {
        const conversation = new Conversation(`c1`);
        daemon.mockImplementation(
            turnDaemon([
                { kind: `session`, sessionId: `s-1` },
                { kind: `init`, model: `claude-opus` },
                { kind: `delta`, text: `Hello ` },
                { kind: `delta`, text: `world` },
                { kind: `done` },
            ]),
        );

        await conversation.turn.send(`Hi there`, settings);

        expect(conversation.transcript.messages.value).toHaveLength(2);
        expect(conversation.transcript.messages.value[0]).toMatchObject({ role: `user`, text: `Hi there` });
        expect(conversation.transcript.messages.value[1]).toMatchObject({ role: `assistant`, text: `Hello world` });
        expect(conversation.session.value).toEqual({ id: `s-1`, provider: `claude`, account: undefined, harness: `native` });
        expect(conversation.activeModel.value).toBe(`claude-opus`);
        expect(conversation.title.value).toBe(`Hi there`);
        expect(conversation.turn.streaming.value).toBe(false);
    });

    it(`adopts the account the daemon served an unpinned turn on, so the next send resumes the session`, async () => {
        const conversation = new Conversation(`c-unpinned`);
        expect(conversation.selection.account.value).toBeUndefined();
        daemon.mockImplementation(turnDaemon([{ kind: `session`, sessionId: `s-1`, account: `with-room` }, { kind: `done` }]));

        await conversation.turn.send(`hi`, settings);

        expect(conversation.session.value).toEqual({ id: `s-1`, provider: `claude`, account: `with-room`, harness: `native` });
        expect(conversation.selection.account.value).toBe(`with-room`);
    });

    // Made at the picker, which is what makes it the user's: an account the app wrote in (a restored tab, a route) is only
    // this window's guess, and the daemon's session replaces it (the test above).
    // The account a conversation runs on is the daemon's record: what the session frame says it served on is what the
    // composer shows next, whatever this window had picked.
    it(`shows the account the daemon reports the session on, over a pick`, async () => {
        const conversation = new Conversation(`c-pinned`);
        conversation.selection.apply({ kind: `selectAccount`, account: `acct-1` });
        daemon.mockImplementation(turnDaemon([{ kind: `session`, sessionId: `s-1`, account: `acct-2` }, { kind: `done` }]));

        await conversation.turn.send(`hi`, { ...settings, account: `acct-1` });

        expect(conversation.session.value?.account).toBe(`acct-2`);
        expect(conversation.selection.account.value).toBe(`acct-2`);
    });

    // Driven off a stalled clock rather than the file's synchronous RAF stub, and tool calls rather than deltas, since
    // a delta only reaches `messages` when the clock ticks and would hide the difference under test.
    it(`applies a burst of frames in one write, so render cost does not scale with frame count`, async () => {
        const runWith = async (calls: number): Promise<{ writes: number; tools: number }> => {
            stubGlobal(`requestAnimationFrame`, (): number => 0);
            const conversation = new Conversation(`c1`);
            let writes = 0;
            // messages is what the renderer reads; `flush: sync` counts actual writes, not batched scheduler passes.
            const stop = watch(conversation.transcript.messages, () => (writes += 1), { flush: `sync` });
            daemon.mockImplementation(
                turnDaemon([
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
            await conversation.turn.send(`Hi`, settings);
            stop();
            return { writes, tools: conversation.transcript.messages.value.reduce((total, message) => total + (message.tools?.length ?? 0), 0) };
        };

        const few = await runWith(4);
        const many = await runWith(16);

        expect(many.writes).toBe(few.writes);
        expect(few.tools).toBe(4);
        expect(many.tools).toBe(16);
    });

    it(`replays the captured session id on the next turn and omits it on the first`, async () => {
        const conversation = new Conversation(`c1`);
        daemon.mockImplementation(turnDaemon([{ kind: `session`, sessionId: `s-1` }]));
        await conversation.turn.send(`first`, settings);
        await conversation.turn.send(`second`, settings);

        const [firstBody, secondBody] = turnBodies();
        expect(`sessionId` in firstBody!).toBe(false);
        expect(secondBody![`sessionId`]).toBe(`s-1`);
    });

    it(`switches provider mid-conversation: retires the session and carries no transcript up the wire`, async () => {
        const conversation = new Conversation(`c1`);
        // The selection and the turn settings move together (useChat builds settings from the selection).
        conversation.selection.apply({ kind: `selectProvider`, provider: `codex` });
        daemon.mockImplementation(
            turnDaemon([
                { kind: `session`, sessionId: `thr-1` },
                { kind: `delta`, text: `sure` },
            ]),
        );
        await conversation.turn.send(`first`, { ...settings, agent: `codex`, model: `` });
        const firstBody = turnBodies()[0]!;
        expect(firstBody[`agent`]).toBe(`codex`);
        // Codex's ChatGPT-account auth rejects a named model: an empty selection is omitted from the wire.
        expect(`model` in firstBody).toBe(false);

        conversation.selection.apply({ kind: `selectProvider`, provider: `claude` });
        expect(conversation.transcript.messages.value.at(-1)!.role).toBe(`notice`);

        // An omitted sessionId is the whole signal that this is a fresh session; the daemon reseeds the replacement
        // itself.
        daemon.mockImplementation(turnDaemon([{ kind: `session`, sessionId: `s-1` }]));
        await conversation.turn.send(`second`, settings);
        const secondBody = turnBodies()[1]!;
        expect(secondBody[`agent`]).toBe(`claude`);
        expect(`sessionId` in secondBody).toBe(false);
        expect(`history` in secondBody).toBe(false);

        // The new runtime's session is captured with its own provider; the next turn resumes it.
        expect(conversation.session.value).toMatchObject({ id: `s-1`, provider: `claude` });
        await conversation.turn.send(`third`, settings);
        const thirdBody = turnBodies()[2]!;
        expect(thirdBody[`sessionId`]).toBe(`s-1`);
    });

    it(`switching away and back before sending keeps the session and removes the notice`, async () => {
        const conversation = new Conversation(`c1`);
        daemon.mockImplementation(turnDaemon([{ kind: `session`, sessionId: `s-1` }]));
        await conversation.turn.send(`first`, settings);

        conversation.selection.apply({ kind: `selectProvider`, provider: `grok` });
        expect(conversation.transcript.messages.value.at(-1)!.role).toBe(`notice`);
        conversation.selection.apply({ kind: `selectProvider`, provider: `claude` });
        expect(conversation.transcript.messages.value.every((message) => message.role !== `notice`)).toBe(true);

        await conversation.turn.send(`second`, settings);
        const secondBody = turnBodies()[1]!;
        expect(secondBody[`sessionId`]).toBe(`s-1`);
        expect(`history` in secondBody).toBe(false);
    });

    it(`says what a same-provider model swap costs, where it used to say nothing at all`, async () => {
        const conversation = new Conversation(`c1`);
        daemon.mockImplementation(turnDaemon([{ kind: `session`, sessionId: `s-1` }]));
        await conversation.turn.send(`first`, settings);

        conversation.selection.apply({ kind: `selectModel`, pick: { provider: `claude`, value: `haiku` } });
        const notice = conversation.transcript.messages.value.at(-1)!;
        expect(notice.role).toBe(`notice`);
        expect(notice.text).toContain(`Switched to`);
        expect(notice.text).not.toContain(`fresh session`);

        await conversation.turn.send(`second`, { ...settings, model: `haiku` });
        const secondBody = turnBodies()[1]!;
        expect(secondBody[`sessionId`]).toBe(`s-1`);
        expect(secondBody[`model`]).toBe(`haiku`);
    });

    it(`says nothing about a model picked before the chat has run anything`, async () => {
        const conversation = new Conversation(`c1`);
        // No turn sent yet, so no cost exists for a divider to report.
        conversation.selection.apply({ kind: `selectModel`, pick: { provider: `claude`, value: `haiku` } });
        expect(conversation.transcript.messages.value).toEqual([]);
    });

    it(`names the allowance the new model spends, when the plan meters it and we have a reading`, async () => {
        usageByAccount.value = {};
        const conversation = new Conversation(`c1`);
        conversation.selection.apply({ kind: `set`, picks: { account: `acct-1` } });
        daemon.mockImplementation(
            turnDaemon([
                { kind: `session`, sessionId: `s-1` },
                // The per-model usage pools a Claude plan publishes, keyed by model.
                {
                    kind: `account_usage`,
                    account: `acct-1`,
                    windows: [
                        { kind: `seven_day`, utilization: 20, gates: `all` },
                        { kind: `model:Opus`, label: `Opus`, utilization: 61.4, resetsAt: 1_700_000, gates: { models: [`Opus`] } },
                    ],
                },
                { kind: `done` },
            ]),
        );
        await conversation.turn.send(`first`, { ...settings, account: `acct-1` });

        conversation.selection.apply({ kind: `selectModel`, pick: { provider: `claude`, value: `claude-opus-4-6` } });
        // Rounded once, by the same projection the usage meters use.
        expect(conversation.transcript.messages.value.at(-1)!.text).toContain(`Opus 61% used`);
    });

    // A parked turn is `streaming` too (the run is alive), so a mid-turn guard on that flag also blocked switching
    // while waiting on a card; a refused allowance needs an account with headroom right then.
    it(`takes an account switch while a turn waits on a card, and holds its divider until the turn settles`, async () => {
        const conversation = new Conversation(`c1`);
        const questions = [{ question: `Which?`, header: `Pick`, multiSelect: false, options: [{ label: `A`, description: `a` }] }];
        daemon.mockImplementation(
            turnDaemon(
                [
                    { kind: `session`, sessionId: `s-1` },
                    { kind: `question`, requestId: `q1`, questions },
                ],
                { stayOpen: true },
            ),
        );
        const turn = conversation.turn.send(`ask me`, settings);
        await waitFor(() => expect(conversation.transcript.awaitingDecision.value).toBe(true));

        conversation.selection.apply({ kind: `selectAccount`, account: `with-room` });
        expect(conversation.selection.account.value).toBe(`with-room`);
        // Nothing drawn yet: the tail belongs to the card; a divider there would sit between the question and the
        // answer.
        expect(conversation.transcript.messages.value.every((message) => message.role !== `notice`)).toBe(true);

        conversation.turn.stop();
        await turn;

        // Settled: the tail is the composer's again; the notice says the next message starts a fresh session (a new
        // account is serving).
        expect(conversation.transcript.messages.value.some((message) => message.role === `notice` && message.text.includes(`fresh session`))).toBe(
            true,
        );

        daemon.mockImplementation(turnDaemon([{ kind: `done` }]));
        await conversation.turn.send(`go on`, conversation.selection.turnSettings());
        const secondBody = turnBodies()[1]!;
        expect(secondBody[`account`]).toBe(`with-room`);
        expect(`sessionId` in secondBody).toBe(false);
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
        // Empty `folded` arrays are shared, not allocated per turn, so the prop stays reference-stable across every
        // rebuild `turnsOf` does.
        expect(turnsOf([{ id: 9, role: `user`, text: `hi` }])[0]!.folded).toBe(turns[1]!.folded);
    });

    // An errand is the app's own prompt sent on the user's behalf (errands.ts); it must reach the agent as a real turn
    // and keep the pin on the request it serves.
    it(`turnsOf folds an app errand into the turn it serves, whatever the daemon wrapped it in`, () => {
        const errand = resolvePrompt([{ repo: `root`, clean: 1, paths: [{ path: `a.ts`, reason: `diverged` }] }]);
        const messages: ChatMessage[] = [
            { id: 1, role: `user`, text: `implement the extension host split` },
            { id: 2, role: `assistant`, text: `done` },
            { id: 3, role: `user`, text: errand },
            { id: 4, role: `assistant`, text: `rebased` },
            // The same errand behind a resume note, as a daemon-restarted turn carries it.
            { id: 5, role: `user`, text: withResumeNote(errand, RESUME_NOTES.restart) },
        ];
        const turns = turnsOf(messages);
        expect(turns.map((turn) => ({ id: turn.id, ids: turn.messages.map((message) => message.id) }))).toEqual([{ id: 1, ids: [1, 2, 3, 4, 5] }]);
        expect(turns[0]!.folded.map((message) => message.id)).toEqual([3, 5]);
        expect(foldsIntoTurn(messages[3]!)).toBe(false);
    });

    // The fork mark is one per turn, at the boundary just past it; the last turn's cut lands past the final message,
    // and a trailing notice stays with the turn it belongs to.
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
        // Every turn gets a cut, including the first: a fork below the opening answer keeps that whole exchange.
        expect(forkCutsOf(turnsOf(messages.slice(0, 2)))).toEqual(new Map([[1, 2]]));
        expect(forkCutsOf([])).toEqual(new Map());
    });

    // Covers boundaries a per-turn mark cannot reach: messages a turn folded (they sit inside it), and the first
    // message, which has no mark since nothing precedes it.
    it(`cutsAboveOf covers the folded messages and the first, and nothing that already has a mark`, () => {
        const messages: ChatMessage[] = [
            { id: 1, role: `user`, text: `hi` },
            { id: 2, role: `assistant`, text: `hello` },
            { id: 3, role: `user`, text: `continue` },
            { id: 4, role: `assistant`, text: `sure` },
            { id: 5, role: `user`, text: `now do the other thing` },
            { id: 6, role: `assistant`, text: `done` },
        ];
        expect([...cutsAboveOf(turnsOf(messages))]).toEqual([
            // 'continue' folded into turn 1, two rows deep.
            [3, 2],
        ]);
        // Message 5 opens turn 2; its boundary is turn 1's close mark (forkCutsOf), not one here.
        expect(cutsAboveOf(turnsOf(messages)).has(5)).toBe(false);
        // A transcript opening on the agent's words has no first prompt to mark; an assistant row is not a point to go
        // back to.
        expect(cutsAboveOf(turnsOf(messages.slice(1)))).toEqual(new Map([[3, 1]]));
        expect(cutsAboveOf([])).toEqual(new Map());
    });

    // Names a day once, above the first turn sent on it, firing on every day change and nothing else. Built from
    // local wall-clock parts, not UTC, since the marker is the viewer's own day.
    it(`dayMarksOf names a day above the first turn sent on it and nowhere else`, () => {
        const at = (day: number, hour: number): number => new Date(2026, 7, day, hour).getTime();
        const turns = turnsOf([
            // Opening frames from a restored history carry no stamp; they don't consume the first day marker either.
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
        // "continue?" asks, "Continue. Then stop." instructs: neither is bare consent.
        for (const text of [``, `continue?`, `continue, but skip the tests`, `go for it as recommended`, `Continue. Then stop.`]) {
            expect(isAcknowledgment(user(text)), text).toBe(false);
        }
        // An attachment is content of its own, whatever the caption says; and only the user nudges.
        expect(isAcknowledgment({ id: 1, role: `user`, text: `continue`, attachments: [`p/a.png`] })).toBe(false);
        expect(isAcknowledgment({ id: 1, role: `assistant`, text: `continue` })).toBe(false);
    });

    // A native Codex/Grok/ACP turn has no approval channel, so a `Manual` pick would run every tool call regardless;
    // clamp the effective posture (like effort), not the pick itself.
    it(`a permission mode the runtime can't hold reads as the one it runs, and the pick survives`, () => {
        const conversation = new Conversation(`c-modes`);
        conversation.selection.apply({ kind: `set`, picks: { modePick: `default` } });

        conversation.selection.apply({ kind: `selectProvider`, provider: `codex` });
        expect(conversation.selection.mode.value).toBe(`bypassPermissions`);

        // Claude Code honours modes directly; the pick was never overwritten, so it returns untouched.
        conversation.selection.apply({ kind: `selectHarness`, harness: `claude-code` });
        expect(conversation.selection.mode.value).toBe(`default`);
        expect(conversation.selection.capabilities.value.permissions).toBe(`modes`);

        // Native reads as autonomous again; `plan`, which every runtime has (emulated or not), rides through unchanged.
        conversation.selection.apply({ kind: `selectHarness`, harness: `native` });
        expect(conversation.selection.mode.value).toBe(`bypassPermissions`);
        conversation.selection.apply({ kind: `set`, picks: { modePick: `plan` } });
        conversation.selection.apply({ kind: `selectProvider`, provider: `grok` });
        expect(conversation.selection.mode.value).toBe(`plan`);
    });

    it(`merges updates into the matching tool by id and drops updates with no match`, async () => {
        const conversation = new Conversation(`c1`);
        daemon.mockImplementation(
            turnDaemon([
                { kind: `tool_call`, id: `t1`, name: `Bash`, category: `execute`, status: `in_progress`, target: `ls` },
                // Interim snapshot (live output), then the terminal status: content replaces each time.
                { kind: `tool_call_update`, id: `t1`, content: [{ type: `text`, text: `fi` }] },
                { kind: `tool_call_update`, id: `t1`, status: `completed`, content: [{ type: `text`, text: `file.txt` }] },
                { kind: `tool_call_update`, id: `missing`, status: `completed`, content: [{ type: `text`, text: `dropped` }] },
            ]),
        );

        await conversation.turn.send(`run it`, settings);

        const assistant = conversation.transcript.messages.value[1]!;
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
        daemon.mockImplementation(
            turnDaemon([
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

        await conversation.turn.send(`explore it`, settings);

        const assistant = conversation.transcript.messages.value[1]!;
        // The sub-agent's own prose never leaks into the parent bubble: only the main agent's own delta types in.
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
        daemon.mockImplementation(
            turnDaemon([
                { kind: `thinking`, text: `pondering` },
                { kind: `todos`, items: [{ content: `step 1`, status: `in_progress`, activeForm: `Stepping` }] },
                { kind: `delta`, text: `answer` },
                { kind: `usage`, costUsd: 0.5, numTurns: 1 },
            ]),
        );

        await conversation.turn.send(`plan it`, settings);

        const assistant = conversation.transcript.messages.value[1]!;
        expect(assistant.thinking).toBe(`pondering`);
        expect(assistant.todos).toEqual([{ content: `step 1`, status: `in_progress`, activeForm: `Stepping` }]);
        expect(assistant.usage).toMatchObject({ costUsd: 0.5, numTurns: 1 });
    });

    it(`splits a turn's prose at each text_end, so tool cards sit under the block that introduced them`, async () => {
        const conversation = new Conversation(`c1`);
        daemon.mockImplementation(
            turnDaemon([
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

        await conversation.turn.send(`fix the router`, settings);

        // One bubble per prose block, carrying the tools that ran after it, so cards sit inline instead of all hoisted
        // above one paragraph.
        const [, first, second, third] = conversation.transcript.messages.value;
        expect(conversation.transcript.messages.value).toHaveLength(4);
        expect(first).toMatchObject({ role: `assistant`, text: `Reading the router.` });
        expect(first!.tools).toBeUndefined();
        expect(second).toMatchObject({ role: `assistant`, text: `Found it — fixing.` });
        expect(second!.tools?.map((tool) => tool.id)).toEqual([`b1`]);
        expect(third).toMatchObject({ role: `assistant`, text: `Done.`, usage: { costUsd: 0.3 } });
        expect(third!.tools?.map((tool) => tool.id)).toEqual([`e1`]);
    });

    it(`ignores a text_end that closed no prose, so an empty block leaves no stranded bubble`, async () => {
        const conversation = new Conversation(`c1`);
        daemon.mockImplementation(
            turnDaemon([
                // An empty text block opened and closed before the model went straight to its first tool.
                { kind: `text_end` },
                { kind: `tool_call`, id: `b1`, name: `Bash`, category: `execute`, status: `in_progress`, target: `ls` },
                { kind: `delta`, text: `Listed them.` },
                { kind: `text_end` },
            ]),
        );

        await conversation.turn.send(`list them`, settings);

        expect(conversation.transcript.messages.value).toHaveLength(2);
        expect(conversation.transcript.messages.value[1]).toMatchObject({ role: `assistant`, text: `Listed them.` });
        expect(conversation.transcript.messages.value[1]!.tools?.map((tool) => tool.id)).toEqual([`b1`]);
    });

    it(`ignores a sub-agent's text_end: its blocks never split the parent turn's bubble`, async () => {
        const conversation = new Conversation(`c1`);
        daemon.mockImplementation(
            turnDaemon([
                { kind: `tool_call`, id: `agent1`, name: `Agent`, category: `other`, status: `in_progress`, target: `explore` },
                { kind: `delta`, text: `sub prose`, parentToolUseId: `agent1` },
                { kind: `text_end`, parentToolUseId: `agent1` },
                { kind: `delta`, text: `main answer` },
            ]),
        );

        await conversation.turn.send(`explore it`, settings);

        expect(conversation.transcript.messages.value).toHaveLength(2);
        expect(conversation.transcript.messages.value[1]).toMatchObject({ role: `assistant`, text: `main answer` });
    });

    it(`opens a fresh bubble per turn: a stream carrying several turns splits at each usage boundary`, async () => {
        const conversation = new Conversation(`c1`);
        // A steered conversation's stream carries one turn per queued message; usage is each turn's boundary.
        daemon.mockImplementation(
            turnDaemon([
                { kind: `delta`, text: `first answer` },
                { kind: `usage`, costUsd: 0.1 },
                { kind: `thinking`, text: `next` },
                { kind: `delta`, text: `second answer` },
                { kind: `usage`, costUsd: 0.2 },
                { kind: `done` },
            ]),
        );

        await conversation.turn.send(`two things`, settings);

        expect(conversation.transcript.messages.value).toHaveLength(3);
        const [, first, second] = conversation.transcript.messages.value;
        expect(first).toMatchObject({ role: `assistant`, text: `first answer`, usage: { costUsd: 0.1 } });
        expect(second).toMatchObject({ role: `assistant`, text: `second answer`, thinking: `next`, usage: { costUsd: 0.2 } });
    });

    // A steer absorbed mid-turn produces no `usage` boundary; the model just keeps writing, so the reply opens a new
    // bubble below the steer rather than continuing the one above.
    it(`steers mid-turn: the message lands where the turn took it and the answer opens below it`, async () => {
        const conversation = new Conversation(`c1`);
        const run = liveRun({ prompt: `2+3?` });
        let controller!: ReadableStreamDefaultController<AttachFrame>;
        const body = new ReadableStream<AttachFrame>({
            start(c) {
                controller = c;
                controller.enqueue(frameOf(run.head()));
            },
        });
        let sends = 0;
        daemon.mockImplementation((procedure: string) => {
            if (procedure === `agent.run`) {
                sends += 1;
                return Promise.resolve(sends === 1 ? { delivered: `started`, run: `r1` } : { delivered: `steered`, run: `r1` });
            }
            return Promise.resolve(procedure === `agent.attach` ? body : { ok: true });
        });
        const emit = (event: AgentEvent): void => {
            for (const frame of run.frames(event)) {
                controller.enqueue(frameOf(frame));
            }
        };

        const turn = conversation.turn.send(`2+3?`, settings);
        emit({ kind: `delta`, text: `5` });
        await waitFor(() => expect(conversation.transcript.messages.value[1]?.text).toBe(`5`));

        await conversation.turn.say(`2+6?`);
        // The daemon said it into the running turn, so nothing is drawn here: the run's own frame draws it.
        expect(turnBodies().map((sent) => sent[`prompt`])).toEqual([`2+3?`, `2+6?`]);
        expect(conversation.transcript.messages.value).toHaveLength(2);
        emit({ kind: `steer`, text: `2+6?`, sentAt: 1_767_225_600_000 });
        await waitFor(() => expect(conversation.transcript.messages.value).toHaveLength(3));

        // Absorbed mid-turn: no usage boundary, so the model's words open a new bubble below.
        emit({ kind: `delta`, text: `8` });
        await waitFor(() => expect(conversation.transcript.messages.value[3]?.text).toBe(`8`));
        emit({ kind: `usage`, costUsd: 0.1 });
        emit({ kind: `done` });
        controller.enqueue(frameOf({ kind: `end` }));
        controller.close();
        await turn;

        expect(conversation.transcript.messages.value.map(({ role, text }) => ({ role, text }))).toEqual([
            { role: `user`, text: `2+3?` },
            { role: `assistant`, text: `5` },
            { role: `user`, text: `2+6?` },
            { role: `assistant`, text: `8` },
        ]);
        // The daemon's stamp, not this window's clock: the bubble must not jump when the record replaces it.
        expect(conversation.transcript.messages.value[2]!.sentAt).toBe(1_767_225_600_000);
    });

    it(`draws a steer that another window sent, off the run's own frames`, async () => {
        const conversation = new Conversation(`c1`);
        daemon.mockImplementation(
            turnDaemon([
                { kind: `delta`, text: `looking` },
                { kind: `steer`, text: `check the tests too`, sentAt: 1_767_225_600_000 },
                { kind: `delta`, text: `will do` },
                { kind: `done` },
            ]),
        );

        await conversation.turn.send(`have a look`, settings);

        expect(conversation.transcript.messages.value.map(({ role, text }) => ({ role, text }))).toEqual([
            { role: `user`, text: `have a look` },
            { role: `assistant`, text: `looking` },
            { role: `user`, text: `check the tests too` },
            { role: `assistant`, text: `will do` },
        ]);
        // Nothing was typed here, so nothing was sent from here either.
        expect(turnBodies()).toHaveLength(1);
    });

    it(`sends a steered message's attachments and editor context with it, so a mid-turn file isn't a lesser message`, async () => {
        const conversation = new Conversation(`c1`);
        daemon.mockImplementation(
            turnDaemon(
                [
                    { kind: `delta`, text: `working` },
                    {
                        kind: `steer`,
                        text: `look at this`,
                        sentAt: 1_767_225_600_000,
                        attachments: [`.intentic/records/artifacts/attachments/u1/shot.png`],
                    },
                ],
                { stayOpen: true },
            ),
        );

        const turn = conversation.turn.send(`start`, settings);
        // Said once the run is live daemon-side, as the daemon decides by that whether words go into it.
        await waitFor(() => expect(conversation.transcript.messages.value.some((message) => message.role === `assistant`)).toBe(true));
        await conversation.turn.say(`look at this`, [{ name: `shot.png`, path: `.intentic/records/artifacts/attachments/u1/shot.png` }], {
            file: `src/app.ts`,
        });

        expect(turnBodies()[1]).toMatchObject({
            prompt: `look at this`,
            attachments: [`.intentic/records/artifacts/attachments/u1/shot.png`],
            editorContext: { file: `src/app.ts` },
        });
        // Name attachment chips from the restored frame path.
        await waitFor(() =>
            expect(conversation.transcript.messages.value.at(-1)).toMatchObject({
                role: `user`,
                text: `look at this`,
                attachments: [`.intentic/records/artifacts/attachments/u1/shot.png`],
            }),
        );

        conversation.turn.stop();
        await turn;
    });

    // A `@path` is the tokenizer's reading of the words, and pasted terminal output is full of the shape (curl's
    // `@file`): merged into the chips, one of those refused the whole message. Absolute paths never ride at all, and
    // the rest ride a field the daemon may drop from.
    it(`sends @-mentioned paths apart from the staged chips, and never one from outside the workspace`, async () => {
        const conversation = new Conversation(`c1`);
        daemon.mockImplementation(turnDaemon([{ kind: `delta`, text: `ok` }]));

        const chip = `${STATE_DIR}/records/artifacts/attachments/u1/shot.png`;
        await conversation.turn.send(`check @src/app.ts against: curl --data-binary @/tmp/probe/req.json`, settings, [
            { name: `shot.png`, path: chip },
        ]);

        const started = daemon.mock.calls.find(([procedure]) => procedure === `agent.run`);
        expect(wire(started![1])).toMatchObject({ attachments: [chip], mentions: [`src/app.ts`] });
    });

    // The press is the send: the bubble reads as sent and the composer is free while the daemon's answer is on its way.
    it(`draws a message as sent at the press, while the daemon's answer is still on its way`, async () => {
        const conversation = new Conversation(`c1`);
        let ack!: (receipt: MessageReceipt) => void;
        daemon.mockImplementation((procedure: string) =>
            procedure === `agent.run`
                ? new Promise<MessageReceipt>((resolve) => {
                      ack = resolve;
                  })
                : Promise.resolve({ ok: true }),
        );

        const sending = conversation.turn.say(`fix the failing check`);
        await waitFor(() => expect(turnBodies()).toHaveLength(1));
        expect(conversation.transcript.messages.value.map(({ role, text }) => ({ role, text }))).toEqual([
            { role: `user`, text: `fix the failing check` },
        ]);
        expect(conversation.draft.value).toBe(``);

        ack({ delivered: `started`, run: `r1` });
        await sending;

        expect(conversation.draft.value).toBe(``);
        expect(conversation.error.value).toBeNull();
    });

    // A turn that takes no words mid-way leaves the message in the daemon's queue, which starts it once that turn settles;
    // this window follows it there, since the queue is shown on the card.
    it(`follows the turn the daemon's queue starts once the running one settles`, async () => {
        const conversation = new Conversation(`c1`);
        let controller!: ReadableStreamDefaultController<AttachFrame>;
        const body = new ReadableStream<AttachFrame>({
            start(c) {
                controller = c;
                c.enqueue(frameOf(head()));
            },
        });
        const followUp = turnDaemon([{ kind: `delta`, text: `on it` }, { kind: `done` }], {
            head: () => ({ run: `r2`, prompt: `also update the tests` }),
        });
        let attaches = 0;
        let sends = 0;
        daemon.mockImplementation((procedure: string, input: unknown, options?: CallOptions) => {
            if (procedure === `agent.attach`) {
                attaches += 1;
                if (attaches === 1) {
                    return Promise.resolve(body);
                }
                // The card, once the queue started its turn: nothing waits any more.
                conversation.queue.value = { items: [], revision: 2 };
                return followUp(procedure, input, options);
            }
            if (procedure === `agent.run`) {
                sends += 1;
                return Promise.resolve(sends === 1 ? { delivered: `started`, run: `r1` } : { delivered: `queued` });
            }
            return Promise.resolve({ ok: true });
        });

        const turn = conversation.turn.send(`start`, settings);
        await waitFor(() => expect(conversation.transcript.messages.value.map(({ text }) => text)).toEqual([`hi`]));
        await conversation.turn.say(`also update the tests`);
        // What the card says waits, in every window.
        conversation.queue.value = { items: [{ id: `m-2`, text: `also update the tests`, voice: `person`, queuedAt: 1, revision: 1 }], revision: 1 };
        expect(turnBodies().map((sent) => sent[`prompt`])).toEqual([`start`, `also update the tests`]);
        expect(conversation.transcript.messages.value.map(({ text }) => text)).toEqual([`hi`]);

        // The turn ends on its own, and the daemon starts the next with what waited.
        controller.enqueue(frameOf({ kind: `end` }));
        controller.close();
        await turn;

        await waitFor(() => expect(conversation.transcript.messages.value.at(-1)?.text).toBe(`on it`), { timeout: 5_000 });
        expect(conversation.transcript.messages.value.map(({ role, text }) => ({ role, text }))).toEqual([
            { role: `user`, text: `hi` },
            { role: `user`, text: `also update the tests` },
            { role: `assistant`, text: `on it` },
        ]);
    });

    // The daemon joins what waits into one turn; each message leaves this window as it is typed, files and all.
    it(`sends each message said mid-turn to the daemon as it is typed, with its files`, async () => {
        const conversation = new Conversation(`c1`);
        daemon.mockImplementation(turnDaemon([{ kind: `delta`, text: `working` }], { stayOpen: true, midTurn: `queued` }));

        const turn = conversation.turn.send(`start`, settings);
        await waitFor(() => expect(conversation.turn.streaming.value).toBe(true));
        await conversation.turn.say(`also the tests`, [{ name: `spec.md`, path: `${STATE_DIR}/records/artifacts/attachments/u1/spec.md` }]);
        await conversation.turn.say(`and the docs`);

        expect(turnBodies().slice(1)).toMatchObject([
            { prompt: `also the tests`, attachments: [`.intentic/records/artifacts/attachments/u1/spec.md`] },
            { prompt: `and the docs` },
        ]);
        conversation.turn.stop();
        await turn;
    });

    it(`waits for the stopped daemon run to release its lock before starting the next message`, async () => {
        const conversation = new Conversation(`c1`);
        const parked = turnDaemon([{ kind: `delta`, text: `working` }], { stayOpen: true });
        const completed = turnDaemon([{ kind: `done` }]);
        let attaches = 0;
        let releaseStop: (answer: { ok: true }) => void = () => {};
        const stopped = new Promise<{ ok: true }>((resolve) => {
            releaseStop = resolve;
        });
        daemon.mockImplementation((procedure: string, input: unknown, options?: CallOptions) => {
            if (procedure === `agent.stop`) {
                // The stop's two halves held apart: the daemon cancels the run (ending the attach) at once, but only
                // confirms the stop when released.
                void parked(procedure, input, options);
                return stopped;
            }
            const serving = attaches === 0 ? parked : completed;
            if (procedure === `agent.attach`) {
                attaches += 1;
            }
            return serving(procedure, input, options);
        });

        const first = conversation.turn.send(`start`, settings);
        await waitFor(() => expect(conversation.turn.streaming.value).toBe(true));
        conversation.turn.stop();
        await first;

        const next = conversation.turn.say(`try again`);
        await Promise.resolve();
        // The local attach is already gone, but the stop has not yet confirmed daemon-side settlement.
        expect(turnBodies()).toHaveLength(1);

        releaseStop({ ok: true });
        await next;
        expect(turnBodies()).toHaveLength(2);
        expect(turnBodies()[1]).toMatchObject({ prompt: `try again` });
        expect(conversation.error.value).toBeNull();
    });

    it(`parks the turn on a plan card and streams the continuation into a fresh bubble`, async () => {
        const conversation = new Conversation(`c1`);
        daemon.mockImplementation(
            turnDaemon([
                { kind: `delta`, text: `intro` },
                { kind: `plan`, requestId: `d1`, text: `the plan` },
                { kind: `delta`, text: `after approval` },
            ]),
        );

        const turn = conversation.turn.send(`make a plan`, settings);
        await waitFor(() => expect(conversation.transcript.awaitingDecision.value).toBe(true));

        const [, planMessage] = conversation.transcript.messages.value;
        expect(planMessage).toMatchObject({ text: `intro`, plan: { requestId: `d1`, text: `the plan`, status: `pending` } });

        expect(await conversation.requests.reply(`d1`, { kind: `plan`, approve: true })).toBe(true);
        expect(daemon).toHaveBeenLastCalledWith(`agent.reply`, { kind: `plan`, requestId: `d1`, approve: true }, { context: { at: undefined } });
        await turn;

        // The verdict is the daemon's own line; what comes next opens a fresh bubble rather than typing into the
        // card's.
        expect(conversation.transcript.messages.value.slice(1).map(({ role, text }) => ({ role, text }))).toEqual([
            { role: `assistant`, text: `intro` },
            { role: `notice`, text: `Plan approved.` },
            { role: `assistant`, text: `after approval` },
        ]);
        expect(conversation.transcript.messages.value[1]?.plan).toMatchObject({ status: `approved` });
        expect(conversation.transcript.awaitingDecision.value).toBe(false);
    });

    // Files staged against a plan card travel as `@`-paths in the reply's single text field, same as against a
    // message.
    it(`sends a plan rejection's staged files as @-paths and keeps them on the feedback bubble`, async () => {
        const conversation = new Conversation(`c1`);
        daemon.mockImplementation(turnDaemon([{ kind: `plan`, requestId: `d1`, text: `the plan` }]));
        const turn = conversation.turn.send(`make a plan`, settings);
        await waitFor(() => expect(conversation.transcript.awaitingDecision.value).toBe(true));

        await conversation.requests.reply(`d1`, {
            kind: `plan`,
            approve: false,
            feedback: planFeedback(`this bit is wrong`, [{ name: `shot.png`, path: `${STATE_DIR}/records/artifacts/attachments/a1/shot.png` }]),
        });

        const [, reply] = daemon.mock.calls.at(-1)!;
        expect(wire(reply)).toMatchObject({
            kind: `plan`,
            approve: false,
            feedback: `this bit is wrong\n@.intentic/records/artifacts/attachments/a1/shot.png`,
        });
        await turn;
        // The feedback is the daemon's row: the user's words as sent, with the upload's chip on them.
        expect(conversation.transcript.messages.value.at(-1)).toMatchObject({
            role: `user`,
            text: `this bit is wrong\n@.intentic/records/artifacts/attachments/a1/shot.png`,
            attachments: [`.intentic/records/artifacts/attachments/a1/shot.png`],
        });
    });

    // A screenshot with nothing typed is a whole answer on its own.
    it(`sends an attachment-only plan rejection`, async () => {
        const conversation = new Conversation(`c1`);
        daemon.mockImplementation(turnDaemon([{ kind: `plan`, requestId: `d1`, text: `the plan` }]));
        const turn = conversation.turn.send(`make a plan`, settings);
        await waitFor(() => expect(conversation.transcript.awaitingDecision.value).toBe(true));

        await conversation.requests.reply(`d1`, {
            kind: `plan`,
            approve: false,
            feedback: planFeedback(``, [{ name: `shot.png`, path: `${STATE_DIR}/records/artifacts/attachments/a1/shot.png` }]),
        });

        const [, reply] = daemon.mock.calls.at(-1)!;
        expect(wire(reply)).toMatchObject({ feedback: `@.intentic/records/artifacts/attachments/a1/shot.png` });
        await turn;
        expect(conversation.transcript.messages.value.at(-1)).toMatchObject({
            role: `user`,
            text: `@.intentic/records/artifacts/attachments/a1/shot.png`,
            attachments: [`.intentic/records/artifacts/attachments/a1/shot.png`],
        });
    });

    it(`keeps the user's posture when the AGENT enters plan mode mid-turn`, async () => {
        const conversation = new Conversation(`c1`);
        // An isolated conversation (its own worktree in the sandbox container) runs unattended by default.
        expect(conversation.selection.mode.value).toBe(`bypassPermissions`);
        daemon.mockImplementation(
            turnDaemon([
                { kind: `mode`, mode: `plan` },
                { kind: `delta`, text: `planning` },
            ]),
        );

        await conversation.turn.send(`something big`, settings);

        // The composer follows the running turn, but the pick for the next turn is untouched; an agent entering plan
        // mode
        // must not cost the user their permissions.
        expect(conversation.turn.liveMode.value).toBe(`plan`);
        expect(conversation.selection.mode.value).toBe(`bypassPermissions`);

        await conversation.turn.send(`carry on`, settings);
        const [first, second] = turnBodies();
        expect(first![`permissionMode`]).toBe(`bypassPermissions`);
        expect(second![`permissionMode`]).toBe(`bypassPermissions`);
    });

    it(`parks the turn on a question card and submits answers over the side channel`, async () => {
        const conversation = new Conversation(`c1`);
        const questions = [{ question: `Which?`, header: `Pick`, multiSelect: false, options: [{ label: `A`, description: `a` }] }];
        daemon.mockImplementation(turnDaemon([{ kind: `question`, requestId: `q1`, questions }]));

        const turn = conversation.turn.send(`ask me`, settings);
        await waitFor(() => expect(conversation.transcript.awaitingDecision.value).toBe(true));

        const questionMessage = conversation.transcript.messages.value[1]!;
        expect(questionMessage.question).toMatchObject({ requestId: `q1`, status: `pending` });

        await conversation.requests.reply(`q1`, { kind: `question`, answers: { "Which?": [`A`] } });
        expect(daemon).toHaveBeenLastCalledWith(
            `agent.reply`,
            { kind: `question`, requestId: `q1`, answers: { "Which?": [`A`] } },
            { context: { at: undefined } },
        );
        await turn;
        expect(conversation.transcript.messages.value[1]!.question).toMatchObject({ status: `answered`, answers: { "Which?": [`A`] } });
    });

    it(`dismissing a question stops the turn: the fork the agent could not call is not one it may now guess at`, async () => {
        const conversation = new Conversation(`c1`);
        const questions = [{ question: `Which?`, header: `Pick`, multiSelect: false, options: [{ label: `A`, description: `a` }] }];
        daemon.mockImplementation(turnDaemon([{ kind: `question`, requestId: `q1`, questions }], { stayOpen: true, midTurn: `queued` }));

        const turn = conversation.turn.send(`ask me`, settings);
        await waitFor(() => expect(conversation.transcript.awaitingDecision.value).toBe(true));
        // Queued behind the card, in the daemon: the stop holds it there, where an answer would have let it go in.
        await conversation.turn.say(`and then the docs`);
        await conversation.requests.reply(`q1`, { kind: `question`, cancelled: true });
        await turn;

        const procedures = daemon.mock.calls.map(([procedure]) => procedure);
        expect(procedures).toContain(`agent.reply`);
        // The dismissal request ends the turn without a separate stop request.
        expect(procedures).not.toContain(`agent.stop`);
        expect(conversation.transcript.messages.value.find((message) => message.question !== undefined)!.question).toMatchObject({
            status: `cancelled`,
        });
        expect(conversation.turn.streaming.value).toBe(false);
        expect(conversation.error.value).toBeNull();
        expect(conversation.transcript.messages.value.slice(-2)).toMatchObject([
            { role: `notice`, text: `Question dismissed.` },
            { role: `notice`, text: `Stopped.` },
        ]);
        expect(turnBodies().map((sent) => sent[`prompt`])).toEqual([`ask me`, `and then the docs`]);
    });

    it(`denying a permission stops the turn, and allowing one leaves it running`, async () => {
        const conversation = new Conversation(`c1`);
        daemon.mockImplementation(
            turnDaemon(
                [
                    { kind: `permission`, requestId: `p1`, toolName: `Bash` },
                    { kind: `permission`, requestId: `p2`, toolName: `Write` },
                ],
                { stayOpen: true },
            ),
        );

        const turn = conversation.turn.send(`run it`, settings);
        await waitFor(() => expect(conversation.transcript.awaitingDecision.value).toBe(true));

        // Re-read per assertion: deciding a card replaces its message rather than mutating it.
        const cards = (): ChatMessage[] => conversation.transcript.messages.value.filter((message) => message.permission !== undefined);
        // An allow is the turn carrying on with the user's blessing: nothing to stop.
        await conversation.requests.reply(`p1`, { kind: `permission`, decision: `once` });
        expect(conversation.turn.streaming.value).toBe(true);
        expect(daemon.mock.calls.map(([procedure]) => procedure)).not.toContain(`agent.stop`);

        // The turn was parked on the first card and only asks the second once that answer un-parks it.
        await waitFor(() => expect(cards()).toHaveLength(2));
        await conversation.requests.reply(`p2`, { kind: `permission`, decision: `deny` });
        await turn;

        expect(daemon.mock.calls.map(([procedure]) => procedure)).toContain(`agent.stop`);
        expect(cards().map((card) => card.permission!.status)).toEqual([`allowed`, `denied`]);
        expect(conversation.turn.streaming.value).toBe(false);
        expect(conversation.transcript.messages.value.at(-1)).toMatchObject({ role: `notice`, text: `Stopped.` });
    });

    // A card answered twice in quick succession (allow then deny) must send one reply: the daemon un-parks on
    // whichever lands first and 404s the second, dropped silently rather than surfaced as an error.
    it(`sends one reply for a card answered twice in the same breath, and shows no error for the second`, async () => {
        const conversation = new Conversation(`c1`);
        // A reply the test holds open, so both clicks land inside the window the round trip is in flight for.
        let release = (): void => undefined;
        const inFlight = new Promise<void>((resolve) => {
            release = () => resolve();
        });
        const stream = turnDaemon([{ kind: `permission`, requestId: `p1`, toolName: `Bash` }], { stayOpen: true });
        daemon.mockImplementation(async (procedure, input, options) => {
            if (procedure === `agent.reply`) {
                await inFlight;
                return { ok: true };
            }
            return stream(procedure, input, options);
        });

        const turn = conversation.turn.send(`run it`, settings);
        await waitFor(() => expect(conversation.transcript.awaitingDecision.value).toBe(true));

        const allow = conversation.requests.reply(`p1`, { kind: `permission`, decision: `once` });
        // Not awaited between the two: the first reply has not come back yet.
        const deny = conversation.requests.reply(`p1`, { kind: `permission`, decision: `deny` });
        expect(conversation.requests.isReplying(`p1`)).toBe(true);
        release();
        expect(await Promise.all([allow, deny])).toEqual([true, false]);
        expect(conversation.requests.isReplying(`p1`)).toBe(false);

        const replies = daemon.mock.calls.filter(([procedure]) => procedure === `agent.reply`);
        expect(replies).toHaveLength(1);
        expect(conversation.error.value).toBeNull();
        // The card reads as the first press said (allow); the turn carries on.
        expect(conversation.transcript.messages.value.find((message) => message.permission !== undefined)?.permission?.status).toBe(`allowed`);

        conversation.turn.stop();
        await turn;
    });

    // The press-lock guard covers only the window a reply is in flight for, not a card's whole life.
    it(`lets a fresh card be answered after the one before it has landed`, async () => {
        const conversation = new Conversation(`c1`);
        daemon.mockImplementation(
            turnDaemon(
                [
                    { kind: `permission`, requestId: `p1`, toolName: `Bash` },
                    { kind: `permission`, requestId: `p2`, toolName: `Write` },
                ],
                { stayOpen: true },
            ),
        );

        const turn = conversation.turn.send(`run it`, settings);
        await waitFor(() => expect(conversation.transcript.awaitingDecision.value).toBe(true));
        const cards = (): ChatMessage[] => conversation.transcript.messages.value.filter((message) => message.permission !== undefined);

        await conversation.requests.reply(`p1`, { kind: `permission`, decision: `once` });
        // The second card is the turn carrying on past the first answer, so it only exists once that one landed.
        await waitFor(() => expect(cards()).toHaveLength(2));
        await conversation.requests.reply(`p2`, { kind: `permission`, decision: `once` });

        expect(daemon.mock.calls.filter(([procedure]) => procedure === `agent.reply`)).toHaveLength(2);
        expect(cards().map((card) => card.permission!.status)).toEqual([`allowed`, `allowed`]);

        conversation.turn.stop();
        await turn;
    });

    // The release card is addressed to named approvers, not whoever is looking; the daemon checks identity on reply.
    // This suite pins only the chat half: park, settle, and the receipt naming who released it.
    it(`parks the turn on a release card; the click settles it and the receipt names who released it`, async () => {
        const conversation = new Conversation(`c1`);
        const offer = {
            subject: `DATABASE_URL`,
            kind: `secret` as const,
            lane: `shell` as const,
            detail: `psql {{secret:DATABASE_URL}}`,
            why: `run the migration`,
            approvers: [`bob@corp.com`],
            scope: `use` as const,
        };
        daemon.mockImplementation(turnDaemon([{ kind: `credential_offer`, requestId: `c1`, offer }], { stayOpen: true }));

        const turn = conversation.turn.send(`migrate the db`, settings);
        await waitFor(() => expect(conversation.transcript.awaitingDecision.value).toBe(true));

        const card = (): ChatMessage => conversation.transcript.messages.value.find((message) => message.credentialOffer !== undefined)!;
        expect(card().credentialOffer).toMatchObject({ requestId: `c1`, status: `pending`, offer: { approvers: [`bob@corp.com`] } });

        await conversation.requests.reply(`c1`, { kind: `credential_offer`, approve: true });
        expect(daemon).toHaveBeenLastCalledWith(
            `agent.reply`,
            { kind: `credential_offer`, requestId: `c1`, approve: true },
            { context: { at: undefined } },
        );
        expect(card().credentialOffer).toMatchObject({ status: `approved` });
        // Releasing is not an ending: the exit the turn was parked on carries on.
        expect(conversation.turn.streaming.value).toBe(true);
        await conversation.turn.stop();
        await turn;
    });

    it(`a replayed release card freezes from the resolved frame and wears the approver's name`, async () => {
        const conversation = new Conversation(`c1`);
        const offer = {
            subject: `reddit`,
            kind: `capability` as const,
            lane: `session` as const,
            approvers: [`bob@corp.com`],
            scope: `conversation` as const,
        };
        daemon.mockImplementation(
            turnDaemon([
                { kind: `credential_offer`, requestId: `c1`, offer },
                { kind: `resolved`, requestId: `c1`, reply: { kind: `credential_offer`, requestId: `c1`, approve: true } },
                { kind: `credential_receipt`, requestId: `c1`, outcome: `released`, approvedBy: `bob@corp.com` },
            ]),
        );

        await conversation.turn.send(`post it`, settings);

        const card = conversation.transcript.messages.value.find((message) => message.credentialOffer !== undefined)!;
        expect(card.credentialOffer).toMatchObject({ status: `approved`, receipt: { outcome: `released`, approvedBy: `bob@corp.com` } });
    });

    // Connect does not predict the outcome: the card moves to `connecting` and a capability_outcome frame says how it
    // ended. "Not now" leaves the turn running; both travel the same `agent.reply` channel.
    it(`parks the turn on a capability card; Connect moves it to connecting and the outcome patches on`, async () => {
        const conversation = new Conversation(`c1`);
        const offer = { entry: `notion`, name: `Notion`, why: `I'll create a page there for each research writeup` };
        daemon.mockImplementation(turnDaemon([{ kind: `capability_offer`, requestId: `k1`, offer }], { stayOpen: true }));

        const turn = conversation.turn.send(`write it up in notion`, settings);
        await waitFor(() => expect(conversation.transcript.awaitingDecision.value).toBe(true));

        const card = (): ChatMessage => conversation.transcript.messages.value.find((message) => message.capabilityOffer !== undefined)!;
        expect(card().capabilityOffer).toMatchObject({ requestId: `k1`, status: `pending`, offer: { entry: `notion`, name: `Notion` } });

        await conversation.requests.reply(`k1`, { kind: `capability_offer`, connect: true });
        expect(daemon).toHaveBeenLastCalledWith(
            `agent.reply`,
            { kind: `capability_offer`, requestId: `k1`, connect: true },
            { context: { at: undefined } },
        );
        // Connecting is not an ending: the agent's command is still parked, watching for the connection.
        expect(card().capabilityOffer).toMatchObject({ status: `connecting` });
        expect(card().capabilityOffer?.outcome).toBeUndefined();
        expect(conversation.turn.streaming.value).toBe(true);
        await conversation.turn.stop();
        await turn;
    });

    it(`"Not now" on a capability card connects nothing and leaves the turn running`, async () => {
        const conversation = new Conversation(`c1`);
        const offer = { entry: `notion`, name: `Notion` };
        daemon.mockImplementation(turnDaemon([{ kind: `capability_offer`, requestId: `k1`, offer }], { stayOpen: true }));

        const turn = conversation.turn.send(`write it up in notion`, settings);
        await waitFor(() => expect(conversation.transcript.awaitingDecision.value).toBe(true));
        const card = (): ChatMessage => conversation.transcript.messages.value.find((message) => message.capabilityOffer !== undefined)!;
        await conversation.requests.reply(`k1`, { kind: `capability_offer`, connect: false });

        expect(card().capabilityOffer).toMatchObject({ status: `skipped` });
        expect(daemon.mock.calls.map(([procedure]) => procedure)).not.toContain(`agent.stop`);
        expect(conversation.turn.streaming.value).toBe(true);
        await conversation.turn.stop();
        await turn;
    });

    it(`a replayed capability card freezes from the resolved frame and wears its outcome`, async () => {
        const conversation = new Conversation(`c1`);
        const offer = { entry: `notion`, name: `Notion` };
        daemon.mockImplementation(
            turnDaemon([
                { kind: `capability_offer`, requestId: `k1`, offer },
                { kind: `resolved`, requestId: `k1`, reply: { kind: `capability_offer`, requestId: `k1`, connect: true } },
                { kind: `capability_outcome`, requestId: `k1`, outcome: `connected`, id: `notion` },
            ]),
        );

        await conversation.turn.send(`write it up in notion`, settings);

        const card = conversation.transcript.messages.value.find((message) => message.capabilityOffer !== undefined)!;
        expect(card.capabilityOffer).toMatchObject({ status: `connecting`, outcome: { outcome: `connected`, id: `notion` } });
    });

    it(`surfaces daemon error facts and ignores unfamiliar frames`, async () => {
        const conversation = new Conversation(`c1`);
        const run = liveRun();
        daemon.mockImplementation((procedure: string) => {
            if (procedure !== `agent.attach`) {
                return Promise.resolve({ delivered: `started`, run: `r1` });
            }
            const frames = [
                run.head(),
                { kind: `future-thing`, seq: 1, payload: 1 },
                ...run.frames({ kind: `error`, message: `boom` }),
                { kind: `end` },
            ];
            return Promise.resolve(chunkStream(frames, `close`));
        });

        await conversation.turn.send(`hi`, settings);

        expect(conversation.error.value).toBe(`boom`);
        expect(conversation.status.value).toBe(`error`);
        // The unknown frame left no trace: the user's row and the daemon's line about the failure.
        expect(conversation.transcript.messages.value.map((message) => message.role)).toEqual([`user`, `notice`]);
    });

    // An uncoded failure names nothing to fix, so continuing is simply the rest of the work. A named code means
    // something needs fixing first, so no continue offer rides under it.
    it(`offers to continue after a failure nobody can act on, and never after one that names a fix`, async () => {
        const conversation = new Conversation(`c1`);
        daemon.mockImplementation(turnDaemon([{ kind: `error`, message: `agent did not complete (error_during_execution)` }]));
        await conversation.turn.send(`ship the parser`, settings);
        expect(conversation.pickUp.value).toEqual({ reason: `stopped` });

        // The offer stands down at the start of the next turn, not its end, so it can't be pressed twice into two
        // turns.
        daemon.mockImplementation(turnDaemon([{ kind: `delta`, text: `carrying on` }, { kind: `done` }]));
        await conversation.turn.send(CONTINUATIONS.plain, settings);
        expect(conversation.pickUp.value).toBeUndefined();

        for (const code of [`subscription-required`, `agent-busy`, `claude-not-entitled`] as const) {
            daemon.mockImplementation(turnDaemon([{ kind: `error`, code, message: `nope` }]));
            await conversation.turn.send(`again`, settings);
            expect(conversation.error.value, code).toBe(`nope`);
            expect(conversation.pickUp.value, code).toBeUndefined();
        }
    });

    // The ladder that re-runs a held turn is the daemon's now (agent/run/turn/turn-resume.ts, runStopRung), not this
    // window's: it has to fire with no tab open, and a browser timer could not. Its rungs, its cap and its stand-down
    // notice are covered by turn-resume.integration.test.ts.

    // A bare "continue" after a denied tool reads as "run it anyway", so the continuation must name the refusal. It
    // must also fold into the turn, so pressing it matches typing the words.
    it(`arms the continue offer when a denied tool stops the turn, with the sentence that names the refusal`, async () => {
        const conversation = new Conversation(`c1`);
        daemon.mockImplementation(turnDaemon([{ kind: `permission`, requestId: `p1`, toolName: `Bash` }], { stayOpen: true }));

        const turn = conversation.turn.send(`clean the sandbox`, settings);
        await waitFor(() => expect(conversation.transcript.awaitingDecision.value).toBe(true));
        await conversation.requests.reply(`p1`, { kind: `permission`, decision: `deny` });
        await turn;

        expect(conversation.pickUp.value).toEqual({ reason: `stopped` });
        const text = continuationFor(conversation.transcript.messages.value);
        expect(text).toBe(CONTINUATIONS.afterDenial);
        // Allowing the same tool instead leaves the ordinary sentence: there is no refusal to carry on without.
        expect(continuationFor([{ id: 1, role: `user`, text: `hi`, permission: { requestId: `p1`, toolName: `Bash`, status: `allowed` } }])).toBe(
            CONTINUATIONS.plain,
        );

        // Both continuation sentences fold into the turn, so the prompt defining the work keeps the pin.
        for (const sentence of Object.values(CONTINUATIONS)) {
            expect(foldsIntoTurn({ id: 1, role: `user`, text: sentence }), sentence).toBe(true);
        }
        expect(turnsOf([...conversation.transcript.messages.value, { id: 99, role: `user`, text }]).map((group) => group.id)).toEqual([
            conversation.transcript.messages.value[0]!.id,
        ]);
    });

    it(`self-heals a dead session id: drops it on a session-not-found error and notices instead of erroring`, async () => {
        const conversation = new Conversation(`c1`);
        daemon.mockImplementation(turnDaemon([{ kind: `session`, sessionId: `s-1` }]));
        await conversation.turn.send(`first`, settings);

        // The daemon reseeds a lost session itself when it can; this path fires only for the one runtime whose sessions
        // it can't see.
        daemon.mockImplementation(
            turnDaemon([
                { kind: `error`, code: `session-not-found`, message: `The agent restarted and cannot resume this chat's session.` },
                { kind: `done` },
            ]),
        );
        await conversation.turn.send(`second`, settings);

        expect(conversation.session.value).toBeUndefined();
        // Shows the runtime's own sentence rather than guessing a cause it cannot know.
        expect(conversation.transcript.messages.value.at(-1)).toMatchObject({
            role: `notice`,
            text: `The agent restarted and cannot resume this chat's session.`,
        });
        expect(conversation.error.value).toBeNull();
        expect(conversation.status.value).not.toBe(`error`);

        // The next send carries no dead session id; the daemon reseeds the replacement from its own record of this
        // conversation.
        daemon.mockImplementation(turnDaemon([{ kind: `session`, sessionId: `s-2` }]));
        await conversation.turn.send(`third`, settings);
        const thirdBody = turnBodies()[2]!;
        expect(`sessionId` in thirdBody).toBe(false);
        expect(`history` in thirdBody).toBe(false);
        expect(conversation.session.value).toMatchObject({ id: `s-2`, provider: `claude` });
    });

    it(`surfaces an unrecoverable grok-model-invalid error and reloads the catalog`, async () => {
        loadProviderModelsMock.mockClear();
        const conversation = new Conversation(`c1`);
        conversation.selection.apply({ kind: `set`, picks: { provider: `grok`, model: `grok-code-fast-1` } });
        // Reaches the client only when the daemon's in-turn self-heal failed too: xAI rejected the model and named no
        // alternative.
        const xaiMessage = `xAI returned no available models for your account.`;
        daemon.mockImplementation(turnDaemon([{ kind: `error`, code: `grok-model-invalid`, message: xaiMessage }, { kind: `done` }]));
        await conversation.turn.send(`hi`, { ...settings, agent: `grok`, model: `grok-code-fast-1` });
        // The catalog reload is a fire-and-forget dynamic import; let its microtasks drain before asserting it.
        await new Promise((resolve) => setTimeout(resolve, 0));

        // The daemon's message surfaces both as the error ref and as a transcript notice; the catalog reload refreshes
        // the picker.
        expect(conversation.error.value).toBe(xaiMessage);
        expect(conversation.transcript.messages.value.at(-1)).toMatchObject({ role: `notice`, text: xaiMessage });
        expect(loadProviderModelsMock).toHaveBeenCalledWith(`grok`);
    });

    it(`surfaces a codex-model-invalid error and reloads the Codex catalog`, async () => {
        loadProviderModelsMock.mockClear();
        const conversation = new Conversation(`c1`);
        conversation.selection.apply({ kind: `set`, picks: { provider: `codex`, model: `gpt-5-codex` } });
        // Codex has no in-turn self-heal, so the rejection always lands here; the reload repoints the picker to the
        // daemon's live default.
        daemon.mockImplementation(
            turnDaemon([
                {
                    kind: `error`,
                    code: `codex-model-invalid`,
                    message: `The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account.`,
                },
                { kind: `done` },
            ]),
        );
        await conversation.turn.send(`hi`, { ...settings, agent: `codex`, model: `gpt-5-codex` });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(conversation.error.value).toContain(`not supported`);
        expect(loadProviderModelsMock).toHaveBeenCalledWith(`codex`);
    });

    // A model the subscription plan doesn't cover, not a bad name or a dead provider; the daemon drops it from the
    // catalog. The words are held since the endpoint refused before any token was spent.
    it(`holds the message and reloads the catalog when the plan does not cover the model`, async () => {
        loadProviderModelsMock.mockClear();
        const conversation = new Conversation(`c1`);
        conversation.selection.apply({ kind: `set`, picks: { provider: `kimi`, model: `kimi-k2.7-code-highspeed` } });
        const refusal = `Your current subscription does not have access to kimi-for-coding-highspeed. Upgrade to higher-tier Kimi Code plans.`;
        daemon.mockImplementation(turnDaemon([{ kind: `error`, code: `model-unavailable`, message: refusal }, { kind: `done` }]));
        await conversation.turn.send(`hi`, { ...settings, agent: `kimi`, model: `kimi-k2.7-code-highspeed` });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(conversation.error.value).toContain(`does not have access`);
        expect(loadProviderModelsMock).toHaveBeenCalledWith(`kimi`);
        // The daemon takes the prompt back into the conversation's queue, held, rather than leaving it unanswered in the
        // transcript, as any refusal that ran nothing does; nothing of it stays in this window.
        expect(conversation.transcript.messages.value.some((message) => message.role === `user`)).toBe(false);
        expect(conversation.draft.value).toBe(``);
    });

    it(`renders a codex-advisory as a muted notice under the answer the turn actually produced`, async () => {
        const conversation = new Conversation(`c1`);
        conversation.selection.apply({ kind: `set`, picks: { provider: `codex` } });
        // Codex warns when its CLI has no metadata for a model the subscription serves, then runs the turn anyway; this
        // is not a failure.
        daemon.mockImplementation(
            turnDaemon([
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
        await conversation.turn.send(`hi`, { ...settings, agent: `codex`, model: `gpt-5.6-sol` });

        expect(
            conversation.transcript.messages.value.some((message) => message.role === `notice` && message.text.includes(`fallback metadata`)),
        ).toBe(true);
        // The turn's own answer still arrives: the advisory annotates it rather than replacing it.
        expect(conversation.transcript.messages.value.some((message) => message.role === `assistant` && message.text === `ok`)).toBe(true);
        expect(conversation.error.value).toBeNull();
        expect(conversation.status.value).not.toBe(`error`);
    });

    it(`renders a rate_limit error as a muted notice, not the red error ref`, async () => {
        const conversation = new Conversation(`c1`);
        daemon.mockImplementation(
            turnDaemon([{ kind: `error`, code: `rate_limit`, message: `Claude usage limit reached — try again shortly.` }, { kind: `done` }]),
        );
        await conversation.turn.send(`hello`, settings);

        // The subscription's usage cap is not a crash: a notice, no error ref, no error status.
        expect(conversation.transcript.messages.value.at(-1)!.role).toBe(`notice`);
        expect(conversation.transcript.messages.value.at(-1)!.text).toContain(`usage limit`);
        expect(conversation.error.value).toBeNull();
        expect(conversation.status.value).not.toBe(`error`);
    });

    // A spent allowance names its reset instant and leaves the turn pickable from it; nothing re-runs automatically
    // even if the daemon sends an `autoResume` verdict.
    it(`names the reset instant on a usage limit, and leaves the turn pickable from it`, async () => {
        const conversation = new Conversation(`c1`);
        const resetsAt = Math.floor(Date.now() / 1000) + 3_600;
        daemon.mockImplementation(
            turnDaemon([
                // `available`: the daemon would fire the held turn at reset, but this conversation hasn't armed that;
                // this is the
                // default.
                { kind: `error`, code: `rate_limit`, message: `Claude usage limit reached.`, resetsAt, autoResume: `available` },
                { kind: `done` },
            ]),
        );
        await conversation.turn.send(`hello`, settings);

        const notice = conversation.transcript.messages.value.at(-1)!;
        expect(notice.role).toBe(`notice`);
        // The daemon's line says what happened; when it reopens is `pickUp.readyAt`, read in the viewer's own time
        // zone.
        expect(notice.text).toBe(`Claude usage limit reached.`);
        // No opt-out and nothing marked automatic: nothing is armed yet.
        expect(notice.noticeAction).toBeUndefined();
        expect(conversation.failures.outageResume.value).toBeUndefined();
        expect(conversation.error.value).toBeNull();
        // The press, and the instant it starts working: the reset, to the millisecond the frame named.
        expect(conversation.pickUp.value).toEqual({ reason: `limit`, readyAt: resetsAt * 1_000 });
    });

    // Once armed, the daemon fires the held turn at the published reset hour and says so on the frame. `nextAt` is the
    // booking it will actually keep — distinct from `resetsAt`, which is only the provider's fact about the allowance.
    it(`reports a scheduled send when the conversation is armed for the reset`, async () => {
        const conversation = new Conversation(`c1`);
        const resetsAt = Math.floor(Date.now() / 1000) + 3_600;
        daemon.mockImplementation(
            turnDaemon([
                {
                    kind: `error`,
                    code: `rate_limit`,
                    message: `Claude usage limit reached.`,
                    resetsAt,
                    nextAt: resetsAt,
                    autoResume: `scheduled`,
                    held: { ran: false },
                },
                { kind: `done` },
            ]),
        );
        await conversation.turn.send(`hello`, settings);

        expect(conversation.pickUp.value).toEqual({
            reason: `limit`,
            readyAt: resetsAt * 1_000,
            nextAt: resetsAt * 1_000,
            held: { ran: false },
        });
        // Still a notice rather than the red line: an armed wait is the least alarming state this failure has.
        expect(conversation.error.value).toBeNull();
        // The row states the provider's own sentence and nothing more: what happens next, and the way to change it,
        // are the card's above the composer, said once.
        expect(conversation.transcript.messages.value.at(-1)!.text).toBe(`Claude usage limit reached.`);
    });

    // An allowance the daemon can't date still offers the press immediately: there's nothing to wait for and the
    // provider's own sentence already says to retry. A guessed countdown would be worse than none.
    it(`offers an undated usage limit straight away`, async () => {
        const conversation = new Conversation(`c1`);
        daemon.mockImplementation(turnDaemon([{ kind: `error`, code: `rate_limit`, message: `Kimi usage limit reached.` }, { kind: `done` }]));
        await conversation.turn.send(`hello`, settings);

        expect(conversation.pickUp.value).toEqual({ reason: `limit` });
    });

    it(`re-runs the held turn on a press instead of appending anything to the chat`, async () => {
        const conversation = new Conversation(`c1`);
        daemon.mockImplementation(
            turnDaemon([{ kind: `error`, code: `rate_limit`, message: `Claude usage limit reached.`, held: { ran: false } }, { kind: `done` }]),
        );
        await conversation.turn.send(`ship the parser`, settings);

        expect(conversation.pickUp.value).toEqual({ reason: `limit`, held: { ran: false } });

        // The re-run's own run: the same words, behind a note explaining why they're back.
        daemon.mockImplementation(
            turnDaemon([{ kind: `delta`, text: `on it` }, { kind: `done` }], {
                head: () => ({ prompt: withResumeNote(`ship the parser`, RESUME_NOTES.refused), startedAt: Date.now() }),
            }),
        );
        // Undefined: nothing was said, so there is nothing for the composer's recall ring to take.
        await expect(conversation.turn.continueTurn()).resolves.toBeUndefined();

        expect(daemon.mock.calls.map(([procedure]) => procedure)).toContain(`agent.resume`);
        // No second turn started: `agent.run` is what saying something costs, and nothing was said.
        expect(turnBodies()).toHaveLength(1);
        // One user row, still their own words: the note came off and the bubble was reused, not repeated.
        expect(conversation.transcript.messages.value.filter((message) => message.role === `user`)).toMatchObject([{ text: `ship the parser` }]);
        expect(conversation.transcript.messages.value.at(-1)).toMatchObject({ role: `assistant`, text: `on it` });
    });

    it(`keeps one user row through four presses against an allowance that keeps refusing`, async () => {
        const conversation = new Conversation(`c1`);
        const refuse = (prompt?: string): ReturnType<typeof turnDaemon> =>
            turnDaemon([{ kind: `error`, code: `rate_limit`, message: `Claude usage limit reached.`, held: { ran: false } }, { kind: `done` }], {
                head: () => ({ startedAt: Date.now(), ...(prompt === undefined ? {} : { prompt }) }),
            });
        daemon.mockImplementation(refuse());
        await conversation.turn.send(`ship the parser`, settings);

        daemon.mockImplementation(refuse(withResumeNote(`ship the parser`, RESUME_NOTES.refused)));
        for (let press = 0; press < 4; press += 1) {
            await conversation.turn.continueTurn();
        }

        expect(turnBodies()).toHaveLength(1);
        expect(conversation.transcript.messages.value.filter((message) => message.role === `user`)).toMatchObject([{ text: `ship the parser` }]);
        // Still offering the press, because the turn is still held: a re-run refused is a re-run to make again.
        expect(conversation.pickUp.value).toEqual({ reason: `limit`, held: { ran: false } });
    });

    // If the daemon isn't actually holding the turn (a restart between refusal and press), the press must not become
    // dead: it falls back to sending an ordinary "carry on" turn.
    it(`falls back to saying carry on when the held turn has gone`, async () => {
        const conversation = new Conversation(`c1`);
        daemon.mockImplementation(
            turnDaemon([{ kind: `error`, code: `rate_limit`, message: `Claude usage limit reached.`, held: { ran: true } }, { kind: `done` }]),
        );
        await conversation.turn.send(`ship the parser`, settings);

        const refusedResume = turnDaemon([{ kind: `delta`, text: `carrying on` }, { kind: `done` }]);
        daemon.mockImplementation((procedure, input, options) =>
            procedure === `agent.resume` ? Promise.reject(daemonRefusal(404, `no held turn`)) : refusedResume(procedure, input, options),
        );
        await expect(conversation.turn.continueTurn()).resolves.toBe(CONTINUATIONS.plain);

        expect(turnBodies().map((body) => body[`prompt`])).toEqual([`ship the parser`, CONTINUATIONS.plain]);
    });

    // The resume pass's own rung got there first, in a turn this window wasn't following: the press follows it, and
    // "Continue" never reaches the conversation.
    it(`follows the turn already re-running the held one, rather than saying carry on`, async () => {
        const conversation = new Conversation(`c1`);
        daemon.mockImplementation(
            turnDaemon([{ kind: `error`, message: `Google turn timed out waiting for OpenCode.`, held: { ran: true } }, { kind: `done` }]),
        );
        await conversation.turn.send(`ship the parser`, settings);
        expect(conversation.pickUp.value).toMatchObject({ reason: `stopped`, held: { ran: true } });

        const rung = turnDaemon([{ kind: `delta`, text: `back on it` }, { kind: `done` }], {
            head: () => ({ run: `rung-1`, prompt: withResumeNote(`ship the parser`, RESUME_NOTES.stopped), startedAt: Date.now() }),
        });
        daemon.mockImplementation((procedure, input, options) =>
            procedure === `agent.resume`
                ? Promise.reject(daemonRefusal(409, `a turn is already running in that conversation`))
                : rung(procedure, input, options),
        );
        await expect(conversation.turn.continueTurn()).resolves.toBeUndefined();

        expect(turnBodies()).toHaveLength(1);
        expect(conversation.transcript.messages.value.filter((message) => message.role === `user`)).toMatchObject([{ text: `ship the parser` }]);
        expect(conversation.transcript.messages.value.at(-1)).toMatchObject({ role: `assistant`, text: `back on it` });
    });

    it(`keeps a stopped turn's booked rung and how far the ladder got on the pick-up`, async () => {
        const conversation = new Conversation(`c1`);
        const nextAt = Math.floor(Date.now() / 1000) + 15;
        daemon.mockImplementation(
            turnDaemon([
                {
                    kind: `error`,
                    message: `Google turn timed out waiting for OpenCode.`,
                    held: { ran: true },
                    autoResume: `scheduled`,
                    nextAt,
                    retries: { made: 1, max: 3 },
                },
                { kind: `done` },
            ]),
        );
        await conversation.turn.send(`ship the parser`, settings);

        expect(conversation.pickUp.value).toEqual({ reason: `stopped`, nextAt: nextAt * 1_000, retries: { made: 1, max: 3 }, held: { ran: true } });
        expect(conversation.transcript.messages.value.at(-1)).toMatchObject({
            role: `notice`,
            text: `Google turn timed out waiting for OpenCode. Retrying by itself: attempt 2 of 3.`,
        });
    });

    // A turn the sandbox started itself (a fix press, a peer's message) and kept after the door turned it away: its
    // words were never in this window, so the press asks the sandbox to run that turn and sends nothing of its own.
    it(`runs a turn the sandbox kept on a press, as it was started, sending nothing of its own`, async () => {
        const conversation = new Conversation(`c1`);
        daemon.mockImplementation(
            turnDaemon([{ kind: `delta`, text: `on it` }, { kind: `done` }], {
                head: () => ({ prompt: withResumeNote(`fix the pipeline`, RESUME_NOTES.door), startedAt: Date.now() }),
            }),
        );
        await conversation.turn.resendKept({ text: `fix the pipeline`, attachments: [] });

        const press = daemon.mock.calls.find(([procedure]) => procedure === `agent.resume`)!;
        // No routing: whatever this window's composer holds is not what the sandbox started the turn on.
        expect(wire(press[1])).toEqual({ conversationId: `c1` });
        expect(turnBodies()).toHaveLength(0);
        expect(conversation.transcript.messages.value.at(-1)).toMatchObject({ role: `assistant`, text: `on it` });
    });

    // A restart since the refusal drops the sandbox's copy; the words are still on screen, so the press sends those.
    it(`sends the kept message's own words when the sandbox no longer keeps the turn`, async () => {
        const conversation = new Conversation(`c1`);
        const run = turnDaemon([{ kind: `delta`, text: `on it` }, { kind: `done` }]);
        daemon.mockImplementation((procedure, input, options) =>
            procedure === `agent.resume` ? Promise.reject(daemonRefusal(404, `no held turn`)) : run(procedure, input, options),
        );
        await conversation.turn.resendKept({ text: `fix the pipeline`, attachments: [] });

        expect(turnBodies().map((body) => body[`prompt`])).toEqual([`fix the pipeline`]);
    });

    // A held re-run uses the composer's current account selection, not the account that got refused, since a spent
    // allowance is one account's problem and the switcher is how the user moves off it.
    it(`re-runs the held turn on the account the composer has switched to`, async () => {
        const conversation = new Conversation(`c1`);
        daemon.mockImplementation(
            turnDaemon([
                { kind: `session`, sessionId: `s-1` },
                { kind: `error`, code: `rate_limit`, message: `Claude usage limit reached.`, held: { ran: true } },
                { kind: `done` },
            ]),
        );
        await conversation.turn.send(`ship the parser`, settings);
        expect(conversation.session.value).toMatchObject({ id: `s-1` });

        conversation.selection.apply({ kind: `selectAccount`, account: `with-room` });
        daemon.mockImplementation(
            turnDaemon([{ kind: `delta`, text: `on it` }, { kind: `done` }], {
                head: () => ({ prompt: withResumeNote(`ship the parser`, RESUME_NOTES.switched), startedAt: Date.now() }),
            }),
        );
        await expect(conversation.turn.continueTurn()).resolves.toBeUndefined();

        const press = daemon.mock.calls.find(([procedure]) => procedure === `agent.resume`)!;
        expect(wire(press[1])).toEqual({
            conversationId: `c1`,
            routing: { agent: `claude`, harness: `native`, account: `with-room`, model: `opus` },
        });
        // Reset the session when the credential changes so the daemon can seed a fresh one.
        expect(conversation.session.value).toBeUndefined();
        // Still one turn and one user row: a press is the same request again, not a new message.
        expect(turnBodies()).toHaveLength(1);
        expect(conversation.transcript.messages.value.filter((message) => message.role === `user`)).toMatchObject([{ text: `ship the parser` }]);
        expect(conversation.transcript.messages.value.at(-1)).toMatchObject({ role: `assistant`, text: `on it` });
    });

    // What an armed chat does through a spent allowance is the daemon's appointment now (runLimitRung), fired at the
    // provider's own reset rather than guessed at by a browser timer; turn-resume.integration.test.ts covers it.

    // A provider outage reads like a limit but isn't: no reset instant, an escalating wait, bounded tries. Renders as
    // a notice (the turn is coming back), with the wait naming an instant.
    it(`reads an outage as a wait with its own clock, not as a crash`, async () => {
        const conversation = new Conversation(`c1`);
        // Far-future so the re-attach probe this arms stays parked for the test's lifetime.
        const retryAt = Math.floor(Date.now() / 1000) + 3_600;
        daemon.mockImplementation(
            turnDaemon([
                {
                    kind: `error`,
                    code: `provider-outage`,
                    message: `API Error: 529 Overloaded.`,
                    autoResume: `scheduled`,
                    outage: { retryAt },
                    retries: { made: 1, max: 6 },
                },
                { kind: `done` },
            ]),
        );
        await conversation.turn.send(`hello`, settings);

        const notice = conversation.transcript.messages.value.at(-1)!;
        expect(notice.role).toBe(`notice`);
        expect(notice.text).toContain(`attempt 2 of 6`);
        // No second switch on the row: what happens next is one question, asked once, on the card above the composer.
        expect(notice.noticeAction).toBeUndefined();
        expect(conversation.failures.outageResume.value).toEqual({ retryAt, scheduled: true });
        expect(conversation.pickUp.value?.retries).toEqual({ made: 1, max: 6 });
        expect(conversation.error.value).toBeNull();
        expect(conversation.status.value).not.toBe(`error`);
        conversation.turn.abort();
    });

    // A rotated credential is re-minted and re-run by the daemon within a scheduler pass; the wait must be visible
    // and armed to catch the resumption, not just promised.
    it(`reads a rotated credential as a wait it is actually watching`, async () => {
        const conversation = new Conversation(`c1`);
        daemon.mockImplementation(
            turnDaemon([
                {
                    kind: `error`,
                    code: `claude-token-refused`,
                    message: `Failed to authenticate. API Error: 401 OAuth access token has been revoked`,
                    autoResume: `scheduled`,
                },
                { kind: `done` },
            ]),
        );
        await conversation.turn.send(`hello`, settings);

        const notice = conversation.transcript.messages.value.at(-1)!;
        expect(notice.role).toBe(`notice`);
        expect(notice.text).toContain(`being renewed`);
        // The notice names which wait it describes (`noticeWait`), and the conversation tracks that the wait is on.
        expect(notice.noticeWait).toBe(`credentialRenewal`);
        expect(conversation.failures.credentialRenewal.value).toEqual(expect.any(Object));
        expect(conversation.error.value).toBeNull();
        // Not a reauth: the account is fine, and lighting its badge would send the user to fix nothing.
        expect(providerAccounts.value[`claude`]?.some((account) => account.needsReauth === true)).not.toBe(true);
        conversation.turn.abort();
    });

    // Attach streams are pull: a resumed run only reaches a window that goes looking for it. The wait above must arm
    // that reattach probe on its own.
    it(`goes looking for the resumed run and renders it, without the user doing anything`, async () => {
        jest.useFakeTimers();
        try {
            const conversation = new Conversation(`c1`);
            daemon.mockImplementation(
                turnDaemon([{ kind: `error`, code: `claude-token-refused`, message: `401 revoked`, autoResume: `scheduled` }, { kind: `done` }]),
            );
            await conversation.turn.send(`refactor the store`, settings);
            expect(conversation.failures.credentialRenewal.value).toEqual(expect.any(Object));

            // The resumed request runs behind the resume note, on its own run id; the renewal notice above stays since
            // it
            // belongs to the run that failed.
            daemon.mockImplementation(
                turnDaemon([{ kind: `delta`, text: `Picking it back up.` }], {
                    head: () => ({ run: `r2`, prompt: withResumeNote(`refactor the store`, RESUME_NOTES.auth) }),
                }),
            );
            await advanceTimersByTimeAsync(2_000);

            // The resumed answer lands under the original question once the wait ends.
            expect(conversation.failures.credentialRenewal.value).toBeUndefined();
            expect(conversation.transcript.messages.value.map(({ role, text }) => ({ role, text }))).toEqual([
                { role: `user`, text: `refactor the store` },
                { role: `notice`, text: expect.stringContaining(`being renewed`) },
                // The resumed run opens on the daemon's line for the restart, never on the words again.
                { role: `notice`, text: expect.stringContaining(`sign-in renewed`) },
                { role: `assistant`, text: `Picking it back up.` },
            ]);
        } finally {
            jest.useRealTimers();
        }
    });

    it(`stops the renewal spinner when the resumed turn lands`, async () => {
        const conversation = new Conversation(`c1`);
        daemon.mockImplementation(
            turnDaemon([{ kind: `error`, code: `claude-token-refused`, message: `401 revoked`, autoResume: `scheduled` }, { kind: `done` }]),
        );
        await conversation.turn.send(`hello`, settings);
        expect(conversation.failures.credentialRenewal.value).toEqual(expect.any(Object));

        daemon.mockImplementation(turnDaemon([{ kind: `delta`, text: `back` }, { kind: `done` }]));
        await conversation.turn.send(`again`, settings);
        expect(conversation.failures.credentialRenewal.value).toBeUndefined();
    });

    // With nothing armed, the turn is not coming back on its own; a spinner here would promise something that isn't
    // happening.
    it(`asks for a reconnect when no renewal is armed`, async () => {
        const conversation = new Conversation(`c1`);
        conversation.selection.apply({ kind: `set`, picks: { account: `acct-1` } });
        providerAccounts.value = { ...providerAccounts.value, claude: [{ id: `acct-1`, label: `Claude`, connectedAt: 0 }] };
        daemon.mockImplementation(turnDaemon([{ kind: `error`, code: `claude-token-refused`, message: `401 revoked` }, { kind: `done` }]));
        await conversation.turn.send(`hello`, settings);

        const notice = conversation.transcript.messages.value.at(-1)!;
        expect(notice.text).toContain(`Reconnect`);
        expect(notice.noticeWait).toBeUndefined();
        expect(conversation.failures.credentialRenewal.value).toBeUndefined();
        expect(providerAccounts.value[`claude`]?.[0]?.needsReauth).toBe(true);
    });

    it(`says so plainly once the retries are spent`, async () => {
        const conversation = new Conversation(`c1`);
        // No `outage` block: the daemon's attempts are gone, so nothing is coming back.
        daemon.mockImplementation(
            turnDaemon([{ kind: `error`, code: `provider-outage`, message: `API Error: 500 Internal server error.` }, { kind: `done` }]),
        );
        await conversation.turn.send(`hello`, settings);

        // The red line is honest here, and nothing is armed to bring the turn back.
        expect(conversation.error.value).toContain(`500`);
        expect(conversation.failures.outageResume.value).toBeUndefined();
    });

    it(`refunds a failed free-trial message without arming generic outage recovery`, async () => {
        const conversation = new Conversation(`c1`);
        conversation.selection.apply({ kind: `set`, picks: { provider: `endpoint/free-trial` } });
        daemon.mockImplementation(
            turnDaemon([
                { kind: `error`, code: `trial-unavailable`, message: `Free trial temporarily unavailable, failed messages aren't counted.` },
                { kind: `done` },
            ]),
        );

        await conversation.turn.send(`hello`, { ...settings, agent: `endpoint/free-trial` });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(conversation.transcript.messages.value.at(-1)?.role).toBe(`notice`);
        expect(conversation.error.value).toBeNull();
        expect(conversation.failures.outageResume.value).toBeUndefined();
        expect(loadTrialStatusMock).toHaveBeenCalledTimes(1);
    });

    // A refused turn's words wait at the head of the daemon's queue, held; pressing the same nudge again lets them go
    // rather than stacking another copy behind them.
    it(`lets the held nudge go on a second Continue instead of saying it twice`, async () => {
        const conversation = new Conversation(`c1`);
        conversation.selection.apply({ kind: `set`, picks: { provider: `endpoint/free-trial` } });
        let turns = 0;
        // Built once, not per call: a fake minted inside the mock implementation would miss the POST that started the
        // run it serves.
        const refused = turnDaemon([
            { kind: `error`, code: `trial-unavailable`, message: `Free trial temporarily unavailable, failed messages aren't counted.` },
            { kind: `done` },
        ]);
        const landed = turnDaemon([{ kind: `delta`, text: `on it` }, { kind: `done` }]);
        daemon.mockImplementation((procedure: string, input: unknown, options?: CallOptions) => {
            if (procedure === `agent.run` || procedure === `agent.queueResume`) {
                turns += 1;
            }
            return turns <= 1 ? refused(procedure, input, options) : landed(procedure, input, options);
        });

        await conversation.turn.send(`Continue`, { ...settings, agent: `endpoint/free-trial` });
        await new Promise((resolve) => setTimeout(resolve, 0));
        // What every window's card then shows.
        conversation.queue.value = {
            items: [{ id: `m-1`, text: `Continue`, voice: `person`, queuedAt: 1, revision: 1 }],
            revision: 2,
            paused: `refused`,
        };

        await conversation.turn.say(`Continue`);
        await waitFor(() => expect(conversation.transcript.messages.value.at(-1)?.text).toBe(`on it`));
        expect(turnBodies()).toHaveLength(1);
        expect(daemon.mock.calls.filter(([procedure]) => procedure === `agent.queueResume`)).toHaveLength(1);
    });

    it(`offers turning outage auto-resume on when the daemon only remembered the turn`, async () => {
        const conversation = new Conversation(`c1`);
        const retryAt = Math.floor(Date.now() / 1000) + 3_600;
        daemon.mockImplementation(
            turnDaemon([
                {
                    kind: `error`,
                    code: `provider-outage`,
                    message: `API Error: 500 Internal server error.`,
                    autoResume: `available`,
                    outage: { retryAt },
                    retries: { made: 0, max: 6 },
                },
                { kind: `done` },
            ]),
        );
        await conversation.turn.send(`hello`, settings);

        expect(conversation.failures.outageResume.value).toEqual({ retryAt, scheduled: false });

        // Answering `retry` starts this window watching for the run the daemon will bring back; answering `wait`
        // stands that watch down. Nothing is written to the transcript either way — a toggle's state belongs on the
        // toggle, and six notices about arming and disarming were six rows nobody could act on.
        const rows = conversation.transcript.messages.value.length;
        conversation.failures.watchOutage(true);
        expect(conversation.failures.outageResume.value?.scheduled).toBe(true);
        conversation.failures.watchOutage(false);
        expect(conversation.failures.outageResume.value?.scheduled).toBe(false);
        expect(conversation.transcript.messages.value).toHaveLength(rows);
        conversation.turn.abort();
    });

    // The turn is alive here: a status, never a transcript line, and it must not outlive the turn it describes.
    it(`shows an in-turn provider retry as live status and drops it when the turn settles`, async () => {
        const conversation = new Conversation(`c1`);
        daemon.mockImplementation(
            turnDaemon([
                { kind: `provider_retry`, attempt: 3, maxAttempts: 300, nextAttemptAt: Date.now() + 45_000, status: 529 },
                { kind: `delta`, text: `back` },
                { kind: `done` },
            ]),
        );
        await conversation.turn.send(`hello`, settings);

        expect(conversation.turn.providerRetry.value).toBeUndefined();
        expect(conversation.transcript.messages.value.some((message) => message.role === `notice` && message.text.includes(`retry`))).toBe(false);
        expect(conversation.error.value).toBeNull();
    });

    it(`stores an account_usage frame against its account, stamped so staleness is comparable`, async () => {
        usageByAccount.value = {};
        const conversation = new Conversation(`c1`);
        daemon.mockImplementation(
            turnDaemon([
                {
                    kind: `account_usage`,
                    account: `acct-1`,
                    windows: [
                        { kind: `five_hour`, utilization: 12, resetsAt: 1_800_000, gates: `all` },
                        { kind: `seven_day`, utilization: 87, resetsAt: 2_000_000, gates: `all` },
                    ],
                },
                { kind: `done` },
            ]),
        );
        await conversation.turn.send(`hello`, settings);

        // Keyed by the serving account, not the conversation, and stamped with `measuredAt` so a later load can tell it
        // from the daemon's persisted reading.
        const stored = usageByAccount.value[`claude:acct-1`]!;
        expect(stored.windows).toEqual([
            { kind: `five_hour`, utilization: 12, resetsAt: 1_800_000, gates: `all` },
            { kind: `seven_day`, utilization: 87, resetsAt: 2_000_000, gates: `all` },
        ]);
        expect(stored.measuredAt).toBeGreaterThan(0);
        // The frame's envelope fields are not part of the snapshot.
        expect(stored).not.toHaveProperty(`kind`);
        expect(stored).not.toHaveProperty(`account`);
    });

    it(`ignores an account_usage frame the daemon could not attribute to an account`, async () => {
        usageByAccount.value = {};
        const conversation = new Conversation(`c1`);
        daemon.mockImplementation(
            turnDaemon([{ kind: `account_usage`, windows: [{ kind: `seven_day`, utilization: 5, gates: `all` }] }, { kind: `done` }]),
        );
        await conversation.turn.send(`hello`, settings);

        // An env-token turn has no account to key the snapshot by: better unknown than misattributed.
        expect(usageByAccount.value).toEqual({});
    });

    it(`does not let a rate_limit_info frame stand in for the account's headroom`, async () => {
        usageByAccount.value = {};
        const conversation = new Conversation(`c1`);
        // rate_limit_info names only the one window the provider treated as binding for that request; writing it into
        // the
        // headroom map would misattribute the account's overall usage.
        daemon.mockImplementation(
            turnDaemon([
                { kind: `rate_limit_info`, account: `acct-1`, status: `allowed`, utilization: 1, rateLimitType: `seven_day` },
                { kind: `done` },
            ]),
        );
        await conversation.turn.send(`hello`, settings);

        expect(usageByAccount.value).toEqual({});
    });

    it(`stop() records a notice and aborts without surfacing the abort as an error`, async () => {
        const conversation = new Conversation(`c1`);
        daemon.mockImplementation(turnDaemon([{ kind: `delta`, text: `partial` }], { stayOpen: true }));

        const turn = conversation.turn.send(`long task`, settings);
        await waitFor(() => expect(conversation.transcript.messages.value[1]?.text).toBe(`partial`));
        conversation.turn.stop();
        await turn;

        expect(conversation.error.value).toBeNull();
        expect(conversation.turn.streaming.value).toBe(false);
        expect(conversation.transcript.messages.value.at(-1)).toMatchObject({ role: `notice`, text: `Stopped.` });
    });

    it(`stop() cancels the cards a parked turn was waiting on, so the composer isn't wedged on a dead run`, async () => {
        const conversation = new Conversation(`c1`);
        const questions = [{ question: `Which?`, header: `Pick`, multiSelect: false, options: [{ label: `A`, description: `a` }] }];
        // Fed frame by frame, parking the stream on the first card like the daemon parks a turn, so several cards can
        // be
        // open when stop cancels them all through the run's own fold.
        const run = liveRun({ prompt: `go` });
        let controller!: ReadableStreamDefaultController<AttachFrame>;
        const body = new ReadableStream<AttachFrame>({
            start(c) {
                controller = c;
                c.enqueue(frameOf(run.head()));
            },
        });
        daemon.mockImplementation((procedure: string) => {
            if (procedure === `agent.attach`) {
                return Promise.resolve(body);
            }
            if (procedure === `agent.stop`) {
                for (const frame of run.ending(`stopped`)) {
                    controller.enqueue(frameOf(frame));
                }
                controller.enqueue(frameOf({ kind: `end` }));
                controller.close();
                return Promise.resolve({ ok: true });
            }
            return Promise.resolve({ delivered: `started`, run: `r1` });
        });

        const turn = conversation.turn.send(`go`, settings);
        for (const event of [
            { kind: `plan`, requestId: `d1`, text: `the plan` },
            { kind: `question`, requestId: `q1`, questions },
            { kind: `permission`, requestId: `p1`, toolName: `Bash` },
        ] satisfies AgentEvent[]) {
            for (const frame of run.frames(event)) {
                controller.enqueue(frameOf(frame));
            }
        }
        await waitFor(() => expect(conversation.transcript.awaitingDecision.value).toBe(true));
        conversation.turn.stop();
        await turn;

        expect(conversation.transcript.awaitingDecision.value).toBe(false);
        expect(conversation.transcript.pendingPlanMessage.value).toBeUndefined();
        expect(conversation.status.value).toBe(`idle`);
        const cards = conversation.transcript.messages.value.flatMap((message) =>
            [message.plan?.status, message.question?.status, message.permission?.status].filter((status) => status !== undefined),
        );
        expect(cards).toEqual([`cancelled`, `cancelled`, `cancelled`]);
    });

    it(`a fork copies the turns above the cut and seeds a fresh session from them`, async () => {
        const source = new Conversation(`c1`);
        daemon.mockImplementation(
            turnDaemon([
                { kind: `session`, sessionId: `s-1` },
                { kind: `delta`, text: `one` },
                { kind: `context_usage`, tokens: 500, contextWindow: 1000 },
            ]),
        );
        await source.turn.send(`first`, settings);
        daemon.mockImplementation(turnDaemon([{ kind: `delta`, text: `two` }]));
        await source.turn.send(`second`, settings);
        const index = source.transcript.messages.value.findIndex((message) => message.text === `second`);

        const fork = new Conversation(`c2`);
        seedFork(fork, source, index, `now`);
        daemon.mockImplementation(
            turnDaemon([
                { kind: `session`, sessionId: `s-2` },
                { kind: `delta`, text: `redone` },
            ]),
        );
        await fork.turn.send(`second, revised`, settings);

        // The fork carries the turns above the cut, then its own first turn and the answer to it.
        expect(fork.transcript.messages.value.map((message) => message.text)).toEqual([`first`, `one`, `second, revised`, `redone`]);
        // A fork is a new conversation daemon-side (no session id rides); it sends where it was cut from (`forkOf`,
        // record row count), and the daemon copies that prefix before running. The bubbles themselves never go up.
        const body = turnBodies()[2]!;
        expect(`sessionId` in body).toBe(false);
        expect(`history` in body).toBe(false);
        expect(body[`forkOf`]).toEqual({ conversationId: `c1`, keep: 2, files: `now` });
        expect(fork.session.value).toMatchObject({ id: `s-2`, provider: `claude` });
        expect(fork.conversationId).not.toBe(source.conversationId);
        // Named once. The copy has happened, so a later turn is an ordinary turn on an ordinary conversation.
        await fork.turn.send(`again`, settings);
        expect(`forkOf` in turnBodies()[3]!).toBe(false);
        // The point of forking: the source keeps its own transcript and session, untouched.
        expect(source.transcript.messages.value.map((message) => message.text)).toEqual([`first`, `one`, `second`, `two`]);
        expect(source.session.value).toMatchObject({ id: `s-1` });
        expect(source.contextUsage.value).toMatchObject({ tokens: 500, contextWindow: 1000 });
    });

    // `pendingForkOf` is the only record that this conversation is a fork until the daemon acks its first turn; it is
    // persisted in the tab snapshot and must survive a refused send rather than being spent.
    it(`keeps the fork linkage through a refused first send and spends it on the ack`, async () => {
        const source = new Conversation(`c1`);
        daemon.mockImplementation(
            turnDaemon([
                { kind: `session`, sessionId: `s-1` },
                { kind: `delta`, text: `one` },
            ]),
        );
        await source.turn.send(`first`, settings);

        const fork = new Conversation(`c2`);
        seedFork(fork, source, 2, `now`);
        // Where the tab snapshot reads it (snapshotTab) and a rebuilt tab puts it back (restoreTab).
        expect(fork.pendingForkOf.value).toEqual({ conversationId: `c1`, keep: 2, files: `now` });

        // Refused at the door: nothing ran daemon-side, so the linkage isn't spent; the words are back in the composer
        // and the retry still names the source.
        daemon.mockRejectedValue(daemonRefusal(400, `nope`));
        await fork.turn.send(`carry on differently`, settings);
        expect(fork.pendingForkOf.value).toEqual({ conversationId: `c1`, keep: 2, files: `now` });
        expect(fork.draft.value).toBe(`carry on differently`);

        // The user sends the words again, and the cut rides with them.
        daemon.mockImplementation(turnDaemon([{ kind: `session`, sessionId: `s-2` }]));
        await fork.turn.say(fork.draft.value);
        const retry = turnBodies().at(-1)!;
        expect(retry[`forkOf`]).toEqual({ conversationId: `c1`, keep: 2, files: `now` });
        // The ack is what spends it: from here the fork's record stands on its own.
        expect(fork.pendingForkOf.value).toBeUndefined();
    });

    it(`a fork taken at the first message starts empty and names itself from its own first message`, async () => {
        const source = new Conversation(`c1`);
        daemon.mockImplementation(
            turnDaemon([
                { kind: `session`, sessionId: `s-1` },
                { kind: `delta`, text: `hi!` },
            ]),
        );
        await source.turn.send(`original topic`, settings);
        expect(source.title.value).toBe(`Original topic`);

        const fork = new Conversation(`c2`);
        seedFork(fork, source, 0, `now`);
        expect(fork.transcript.messages.value).toEqual([]);
        daemon.mockImplementation(turnDaemon([{ kind: `session`, sessionId: `s-2` }]));
        await fork.turn.send(`new topic`, settings);

        // Each tab is findable by its own name rather than two tabs sharing one.
        expect(fork.title.value).toBe(`New topic`);
        expect(source.title.value).toBe(`Original topic`);
        // Nothing preceded the cut, so the fresh session gets neither a session id nor a history seed.
        const body = turnBodies()[1]!;
        expect(`sessionId` in body).toBe(false);
        expect(`history` in body).toBe(false);
    });

    // A notice this window drew (a provider switch, a rewind) exists nowhere in the daemon's record; one the daemon
    // wrote (a refusal, a self-resume) is a record row like any other and must be counted.
    it(`a fork counts the notices the daemon recorded and skips the ones drawn locally`, async () => {
        const source = new Conversation(`c1`);
        source.transcript.restoreMessages([
            { role: `user`, text: `ship the parser` },
            { role: `assistant`, text: `on it` },
            { role: `notice`, text: `Failed to authenticate. API Error: 401.` },
            { role: `notice`, text: `Claude sign-in renewed, this turn picked up where it left off.` },
            { role: `assistant`, text: `picking back up` },
        ]);
        // …and one this window wrote itself, which the record knows nothing about.
        source.selection.apply({ kind: `selectProvider`, provider: `codex` });
        expect(source.transcript.messages.value.at(-1)!.role).toBe(`notice`);

        const fork = new Conversation(`c2`);
        seedFork(fork, source, source.transcript.messages.value.length, `now`);
        daemon.mockImplementation(turnDaemon([{ kind: `session`, sessionId: `s-2` }]));
        await fork.turn.send(`carry on`, { ...settings, agent: `codex`, model: `` });
        // Five recorded rows: the switch notice at the end is this window's own and is not one of them.
        expect(turnBodies()[0]![`forkOf`]).toEqual({ conversationId: `c1`, keep: 5, files: `now` });
    });

    it(`a fork carries the source's provider selection and drops its pending switch notice`, async () => {
        const source = new Conversation(`c1`);
        daemon.mockImplementation(
            turnDaemon([
                { kind: `session`, sessionId: `s-1` },
                { kind: `delta`, text: `sure` },
            ]),
        );
        await source.turn.send(`first`, settings);
        source.selection.apply({ kind: `selectProvider`, provider: `codex` });
        expect(source.transcript.messages.value.at(-1)!.role).toBe(`notice`);

        // Branching before the notice leaves it behind: it belongs to the source's segment cut, not the fork.
        const fork = new Conversation(`c2`);
        seedFork(fork, source, 0, `now`);
        expect(fork.selection.provider.value).toBe(`codex`);
        expect(fork.transcript.messages.value.every((message) => message.role !== `notice`)).toBe(true);

        daemon.mockImplementation(turnDaemon([{ kind: `session`, sessionId: `thr-1` }]));
        await fork.turn.send(`first, revised`, { ...settings, agent: `codex`, model: `` });
        const body = turnBodies()[1]!;
        expect(body[`agent`]).toBe(`codex`);
        expect(`sessionId` in body).toBe(false);
    });
    it(`re-attaches from the seq cursor when the stream drops mid-turn and loses nothing`, async () => {
        const conversation = new Conversation(`c1`);
        const attachBodies: Record<string, unknown>[] = [];
        const run = liveRun();
        daemon.mockImplementation((procedure: string, input: unknown, options?: CallOptions) => {
            if (procedure === `agent.run`) {
                return Promise.resolve({ delivered: `started`, run: `r1` });
            }
            attachBodies.push(wire(input));
            const body =
                attachBodies.length === 1
                    ? // Two patches, then the connection breaks mid-run (no `end`).
                      chunkStream(
                          [run.head(), ...run.frames({ kind: `delta`, text: `Hello ` }), ...run.frames({ kind: `delta`, text: `wor` })],
                          `error`,
                      )
                    : // The resumed attach's head carries the rows whole, and the stream carries on from there.
                      chunkStream([run.head(), ...run.frames({ kind: `delta`, text: `ld` }), { kind: `end` }], `close`);
            return Promise.resolve(body);
        });

        await conversation.turn.send(`Hi`, settings);

        expect(attachBodies).toEqual([
            { conversationId: conversation.conversationId, run: `r1` },
            { conversationId: conversation.conversationId, run: `r1` },
        ]);
        expect(conversation.transcript.messages.value[1]).toMatchObject({ role: `assistant`, text: `Hello world` });
        expect(conversation.error.value).toBeNull();
    });

    it(`settles instead of misrendering when the resumed attach reports a different run`, async () => {
        const conversation = new Conversation(`c1`);
        let attaches = 0;
        const first = liveRun();
        const other = liveRun({ run: `r2`, prompt: `someone else's turn` });
        daemon.mockImplementation((procedure: string) => {
            if (procedure === `agent.run`) {
                return Promise.resolve({ delivered: `started`, run: `r1` });
            }
            attaches += 1;
            const body =
                attaches === 1
                    ? chunkStream([first.head(), ...first.frames({ kind: `delta`, text: `partial` })], `error`)
                    : // A newer turn is live by the time the tab reconnects: its rows must not land here.
                      chunkStream([other.head(), ...other.frames({ kind: `delta`, text: `other` }), { kind: `end` }], `close`);
            return Promise.resolve(body);
        });

        await conversation.turn.send(`Hi`, settings);

        expect(conversation.transcript.messages.value[1]).toMatchObject({ role: `assistant`, text: `partial` });
        expect(conversation.turn.streaming.value).toBe(false);
    });

    it(`reattach renders a daemon-side run it never initiated: its rows from the head, its facts replayed`, async () => {
        const conversation = new Conversation(`c1`);
        daemon.mockImplementation((procedure: string, input: unknown, options?: CallOptions) => {
            expect(procedure).toBe(`agent.attach`);
            const request = wire(input);
            expect(request).toEqual({ conversationId: conversation.conversationId });
            const body = new ReadableStream<AttachFrame>({
                start(controller) {
                    const rows: TranscriptRow[] = [userRow(`refactor the parser`, 1234, []), { role: `assistant`, text: `On it.` }];
                    controller.enqueue(frameOf(head({ startedAt: 1234, seq: 2, rows })));
                    // A fact is replayed to every attach of the run; its words are not, the head holds them.
                    controller.enqueue(frameOf({ kind: `fact`, seq: 1, fact: { kind: `session`, sessionId: `s-9` } }));
                    controller.enqueue(frameOf({ kind: `end` }));
                    controller.close();
                },
            });
            return Promise.resolve(body);
        });

        await expect(conversation.turn.reattach()).resolves.toBe(true);

        expect(conversation.transcript.messages.value.map(({ role, text }) => ({ role, text }))).toEqual([
            { role: `user`, text: `refactor the parser` },
            { role: `assistant`, text: `On it.` },
        ]);
        // The replayed fact armed the session exactly as it would have for the initiating window.
        expect(conversation.session.value).toMatchObject({ id: `s-9` });
        expect(conversation.turn.streaming.value).toBe(false);
    });

    // A send's own bubble is the row the run's head later replaces, so re-attaching to a run this window started is
    // idempotent, the same as for one it merely found (transcriptState.attachRun).
    it(`redraws a run its own send opened when attached to it again, rather than stacking a second copy`, async () => {
        const conversation = new Conversation(`c1`);
        daemon.mockImplementation(turnDaemon([{ kind: `delta`, text: `On it.` }, { kind: `done` }]));
        await conversation.turn.send(`refactor the parser`, settings);
        const ids = conversation.transcript.messages.value.map((message) => message.id);

        // The same run served again, as a reload's reattach does.
        await expect(conversation.turn.reattach()).resolves.toBe(true);

        expect(conversation.transcript.messages.value.map(({ role, text }) => ({ role, text }))).toEqual([
            { role: `user`, text: `refactor the parser` },
            { role: `assistant`, text: `On it.` },
        ]);
        // The same rows, under the same ids: nothing about them was redrawn from this window's point of view.
        expect(conversation.transcript.messages.value.map((message) => message.id)).toEqual(ids);
    });

    // The daemon settles a card's status on the row itself (request-status.ts), live and in the record alike, so a
    // restored card reads identically to a live one.
    it(`restores the cards a record kept, frozen with the decisions that settled them`, () => {
        const conversation = new Conversation(`c1`);
        const questions = [
            {
                question: `Which?`,
                header: `Pick`,
                multiSelect: true,
                options: [
                    { label: `A`, description: `a` },
                    { label: `B`, description: `b` },
                ],
            },
        ];
        conversation.transcript.restoreMessages([
            { role: `user`, text: `choose` },
            { role: `assistant`, text: ``, question: { requestId: `q1`, questions, status: `answered`, answers: { "Which?": [`A`, `B`] } } },
            { role: `assistant`, text: `Here is the plan.`, plan: { requestId: `p1`, text: `1. do it`, status: `cancelled` } },
            { role: `assistant`, text: ``, permission: { requestId: `perm1`, toolName: `Bash`, explain: `Runs the tests.`, status: `always` } },
        ]);
        const [, asked, planned, permitted] = conversation.transcript.messages.value;
        expect(asked?.question).toEqual({ requestId: `q1`, questions, status: `answered`, answers: { "Which?": [`A`, `B`] } });
        expect(planned?.plan).toEqual({ requestId: `p1`, text: `1. do it`, status: `cancelled` });
        expect(permitted?.permission).toEqual({ requestId: `perm1`, toolName: `Bash`, explain: `Runs the tests.`, status: `always` });
        // A record row per bubble, cards included: the count a fork copies a prefix of agrees with the daemon's.
        expect(recordedRows(conversation.transcript.messages.value)).toBe(4);
    });

    it(`restoreMessages keeps the task checklist on an assistant bubble`, () => {
        const conversation = new Conversation(`c1`);
        const todos = [
            { content: `step 1`, status: `completed` as const },
            { content: `step 2`, status: `in_progress` as const, activeForm: `Running step 2` },
        ];
        conversation.transcript.restoreMessages([
            { role: `user`, text: `run tasks` },
            { role: `assistant`, text: `Working on it`, todos },
        ]);
        expect(conversation.transcript.messages.value[1]?.todos).toEqual(todos);
    });

    // Attaching to a live run must add to a transcript already restored, not replace it.
    it(`reattach adds the live turn to the history already on screen instead of replacing it`, async () => {
        const conversation = new Conversation(`c1`);
        conversation.transcript.restoreMessages([
            { role: `user`, text: `start the migration` },
            { role: `assistant`, text: `Done with step one.` },
        ]);
        daemon.mockImplementation(turnDaemon([{ kind: `delta`, text: `Step two.` }], { head: () => ({ prompt: `Continue` }) }));

        await expect(conversation.turn.reattach()).resolves.toBe(true);

        expect(conversation.transcript.messages.value.map(({ role, text }) => ({ role, text }))).toEqual([
            { role: `user`, text: `start the migration` },
            { role: `assistant`, text: `Done with step one.` },
            { role: `user`, text: `Continue` },
            { role: `assistant`, text: `Step two.` },
        ]);
    });

    // The tail counts as this run only on a whole match; "Continue" must not swallow an earlier "Continue with the
    // tests".
    it(`reattach appends when the transcript's last prompt only looks like the running one`, async () => {
        const conversation = new Conversation(`c1`);
        conversation.transcript.restoreMessages([
            { role: `user`, text: `Continue with the tests` },
            { role: `assistant`, text: `All green.` },
        ]);
        daemon.mockImplementation(turnDaemon([], { head: () => ({ prompt: `Continue` }) }));

        await expect(conversation.turn.reattach()).resolves.toBe(true);

        expect(conversation.transcript.messages.value.map(({ role, text }) => ({ role, text }))).toEqual([
            { role: `user`, text: `Continue with the tests` },
            { role: `assistant`, text: `All green.` },
            { role: `user`, text: `Continue` },
        ]);
    });

    // A daemon-restarted run's prompt carries the user's words behind a resume note (RESUME_NOTES); stripped, it
    // matches the existing bubble so the run continues under the original question.
    it(`reattach continues the original prompt when the daemon resumed the turn`, async () => {
        const conversation = new Conversation(`c1`);
        conversation.transcript.restoreMessages([{ role: `user`, text: `refactor the store` }]);
        daemon.mockImplementation(
            turnDaemon([{ kind: `delta`, text: `Picking it back up.` }], {
                head: () => ({ prompt: withResumeNote(`refactor the store`, RESUME_NOTES.auth) }),
            }),
        );

        await expect(conversation.turn.reattach()).resolves.toBe(true);

        expect(conversation.transcript.messages.value.map(({ role, text }) => ({ role, text }))).toEqual([
            { role: `user`, text: `refactor the store` },
            { role: `notice`, text: expect.stringContaining(`sign-in renewed`) },
            { role: `assistant`, text: `Picking it back up.` },
        ]);
    });

    // An attach replays a run from its first frame; a resumed park's bubble sits under whatever was already there, so
    // reattaching to a run twice must redraw its answer, not duplicate it.
    it(`reattaching to a resumed park's run redraws its answer instead of stacking a second copy`, async () => {
        const conversation = new Conversation(`c1`);
        conversation.transcript.restoreMessages([{ role: `user`, text: `which shape should it be?` }]);
        const carried = withResumeNote(`The user answered: a mode of the board.`, RESUME_NOTES.answered);
        daemon.mockImplementation(turnDaemon([{ kind: `delta`, text: `That settles it.` }], { head: () => ({ run: `r2`, prompt: carried }) }));

        await expect(conversation.turn.reattach()).resolves.toBe(true);
        await expect(conversation.turn.reattach()).resolves.toBe(true);

        expect(conversation.transcript.messages.value.map(({ role, text }) => ({ role, text }))).toEqual([
            { role: `user`, text: `which shape should it be?` },
            // The answer the daemon carried in as its own bubble; the transcript hadn't shown it, and only one copy
            // survives.
            { role: `user`, text: `The user answered: a mode of the board.` },
            { role: `assistant`, text: `That settles it.` },
        ]);
    });

    // Reclaiming by run rather than position: a re-run's bubble sits above the dead run's own work, so reattaching
    // twice must replace only its own answer, not truncate to the bubble.
    it(`reattaching to a re-run replaces only its own answer, keeping the dead run's work above it`, async () => {
        const conversation = new Conversation(`c1`);
        conversation.transcript.restoreMessages([
            { role: `user`, text: `refactor the store` },
            { role: `assistant`, text: `Got as far as the reducer.` },
        ]);
        daemon.mockImplementation(
            turnDaemon([{ kind: `delta`, text: `Picking it back up.` }], {
                head: () => ({ run: `r2`, prompt: withResumeNote(`refactor the store`, RESUME_NOTES.restart) }),
            }),
        );

        await expect(conversation.turn.reattach()).resolves.toBe(true);
        await expect(conversation.turn.reattach()).resolves.toBe(true);

        expect(conversation.transcript.messages.value.map(({ role, text }) => ({ role, text }))).toEqual([
            { role: `user`, text: `refactor the store` },
            { role: `assistant`, text: `Got as far as the reducer.` },
            { role: `notice`, text: expect.stringContaining(`sandbox came back`) },
            { role: `assistant`, text: `Picking it back up.` },
        ]);
    });

    /* THE WHOLE CHAT, TWICE, AND THEN FIVE TIMES. A run stays attachable for a while after it settles, so a window that
   redrew from the record can still be handed that run's own rows back. They carry the run that wrote them, which is
   how the head lands over them rather than under. */
    it(`reattach reclaims the rows already on screen instead of drawing the run a second time`, async () => {
        const conversation = new Conversation(`c1`);
        const rows: TranscriptRow[] = [
            { ...userRow(`fix the limit reset`, 1_000, []), run: `r1` },
            { role: `assistant`, text: `Tracing the retries.`, run: `r1` },
        ];
        conversation.transcript.restoreMessages(rows);
        daemon.mockImplementation(turnDaemon([], { head: () => ({ rows: structuredClone(rows) }) }));

        await expect(conversation.turn.reattach()).resolves.toBe(true);

        expect(conversation.transcript.messages.value.map(({ role, text }) => ({ role, text }))).toEqual([
            { role: `user`, text: `fix the limit reset` },
            { role: `assistant`, text: `Tracing the retries.` },
        ]);
    });

    /* And the same run STILL GOING: what this window redrew is older than the run is now, so the head carries rows it has
   never seen under ones it is already showing. Both halves land where they belong, in one pass. */
    it(`reattach draws only the part of the run the transcript is not already showing`, async () => {
        const conversation = new Conversation(`c1`);
        const shown: TranscriptRow[] = [
            { ...userRow(`fix the limit reset`, 1_000, []), run: `r1` },
            { role: `assistant`, text: `Tracing the retries.`, run: `r1` },
        ];
        conversation.transcript.restoreMessages(shown);
        daemon.mockImplementation(turnDaemon([], { head: () => ({ rows: [...structuredClone(shown), { role: `assistant`, text: `Found it.` }] }) }));

        await expect(conversation.turn.reattach()).resolves.toBe(true);

        expect(conversation.transcript.messages.value.map(({ role, text }) => ({ role, text }))).toEqual([
            { role: `user`, text: `fix the limit reset` },
            { role: `assistant`, text: `Tracing the retries.` },
            { role: `assistant`, text: `Found it.` },
        ]);
    });

    /* THE BUG AS REPORTED: the same prompt again on every refresh. Each attach mirrors what it drew and the next paints
   that back before attaching again, so an alignment that misses does not merely double the chat, it adds a copy per
   reload — and the run's last row has grown every time, which is exactly when a match on content cannot land. */
    it(`keeps one copy of a growing run however many times it is reattached`, async () => {
        const conversation = new Conversation(`c1`);
        for (const answer of [`Tracing the retries.`, `Tracing the retries. Found it.`, `Tracing the retries. Found it. Fixed.`]) {
            const rows: TranscriptRow[] = [userRow(`fix the limit reset`, 1_000, []), { role: `assistant`, text: answer }];
            daemon.mockImplementation(turnDaemon([], { head: () => ({ rows: structuredClone(rows) }) }));
            await expect(conversation.turn.reattach()).resolves.toBe(true);
        }

        expect(conversation.transcript.messages.value.map(({ role, text }) => ({ role, text }))).toEqual([
            { role: `user`, text: `fix the limit reset` },
            { role: `assistant`, text: `Tracing the retries. Found it. Fixed.` },
        ]);
    });

    /* The daemon refused the turn before running any of it, so the message was never part of the conversation. */
    it(`leaves an undelivered message to the daemon when the Claude credential is revoked`, async () => {
        const conversation = new Conversation(`c1`);
        daemon.mockImplementation(
            turnDaemon([{ kind: `error`, code: `claude-reauth`, message: `Claude sign-in was revoked, reconnect the account.` }]),
        );

        await conversation.turn.send(`land the branch`, {
            agent: `claude`,
            harness: `native`,
            actsAs: undefined,
            startIn: undefined,
            model: `opus`,
            effort: `medium`,
            thinking: false,
            fast: false,
            account: `acct-dead`,
        });

        // The daemon keeps the words in the conversation's queue until the account is back; nothing of them stays here.
        expect(conversation.transcript.messages.value.map((message) => message.role)).toEqual([`notice`]);
        expect(conversation.draft.value).toBe(``);
        // Muted, not the red error line: the fix is one click away on the banner this raises.
        expect(conversation.error.value).toBeNull();
    });

    // The harness reads a leading `/` as an unknown command and discards the rest, so the model never sees it; the
    // daemon takes the words back into the conversation's queue, held like a revoked credential's.
    it(`leaves the words to the daemon when the harness ate them as an unknown slash command`, async () => {
        const conversation = new Conversation(`c1`);
        daemon.mockImplementation(
            turnDaemon([
                {
                    kind: `error`,
                    code: `unknown-command`,
                    message: "`/workspace` isn't a command this agent has, so it read your message as one and dropped the rest.",
                },
            ]),
        );

        await conversation.turn.send(`/workspace view does not remember the file tree`, {
            agent: `claude`,
            harness: `native`,
            actsAs: undefined,
            startIn: undefined,
            account: undefined,
            model: `opus`,
            effort: `medium`,
            thinking: false,
            fast: false,
        });

        // The bubble goes, and no copy lands in the composer: the daemon's queue holds the words, leading slash and all.
        expect(conversation.transcript.messages.value.map((message) => message.role)).toEqual([`notice`]);
        expect(conversation.draft.value).toBe(``);
        // Muted: sending again is the fix, and the daemon now knows the command list well enough to let it past.
        expect(conversation.error.value).toBeNull();
    });

    // The model is too small to hold the turn, and the daemon knows before sending, so it keeps the words in the
    // conversation's queue; muted like the refusals above.
    it(`leaves the words to the daemon when the model's own window cannot hold the turn`, async () => {
        const conversation = new Conversation(`c1`);
        daemon.mockImplementation(
            turnDaemon([
                {
                    kind: `error`,
                    code: `context-window-too-small`,
                    message: `This model accepts 16,384 tokens in one request and this turn needs about 22,004, so nothing was sent.`,
                },
            ]),
        );

        await conversation.turn.send(`Are you there?`, {
            agent: `endpoint/tiny`,
            harness: `native`,
            actsAs: undefined,
            startIn: undefined,
            account: undefined,
            model: `llama-3.2-3b`,
            effort: `medium`,
            thinking: false,
            fast: false,
        });

        expect(conversation.transcript.messages.value.map((message) => message.role)).toEqual([`notice`]);
        expect(conversation.draft.value).toBe(``);
        expect(conversation.error.value).toBeNull();
    });

    // A door-refused turn (no error frame) needs both halves handled explicitly: the daemon's own sentence surfaced
    // as the error, and the words back in the composer rather than lost or re-sent blindly.
    it(`says why the daemon refused the turn, and takes the undelivered message back`, async () => {
        const conversation = new Conversation(`c1`);
        daemon.mockRejectedValue(daemonRefusal(400, `invalid attachment path: ../../etc/passwd`));

        await conversation.turn.send(`redesign the settings page`, {
            agent: `claude`,
            harness: `native`,
            actsAs: undefined,
            startIn: undefined,
            account: undefined,
            model: `opus`,
            effort: `medium`,
            thinking: false,
            fast: false,
        });

        expect(conversation.error.value).toBe(
            `invalid attachment path: ../../etc/passwd Your message is back in the composer: send it again once that's sorted.`,
        );
        expect(conversation.draft.value).toBe(`redesign the settings page`);
        // Out of the transcript entirely: nothing about this send is part of the conversation, here or daemon-side.
        expect(conversation.transcript.messages.value).toEqual([]);
    });

    // A request that never completed (unreachable daemon, dropped tunnel) is neither a status nor a frame, and must
    // not be treated as a mid-turn crash: once its tries are spent, the words return to the composer rather than
    // sitting shown-but-unsent.
    it(`hands the words back when the request never reached the daemon`, async () => {
        const conversation = new Conversation(`c1`);
        const shot = { name: `setup.png`, path: `${STATE_DIR}/records/artifacts/attachments/a1/setup.png` };
        daemon.mockRejectedValue(new Error(`Your sandbox isn't reachable yet, finish setup so it registers its address.`));

        await conversation.turn.send(`the setup view is too scary`, settings, [shot]);

        expect(conversation.error.value).toBe(
            `Your sandbox isn't reachable yet, finish setup so it registers its address. Your message is back in the composer, send it again to deliver it.`,
        );
        // Back whole, attachment and all: the composer is the only place this survives.
        expect(conversation.draft.value).toBe(`the setup view is too scary`);
        expect(conversation.attachments.value.map(({ name, path, status }) => ({ name, path, status }))).toEqual([{ ...shot, status: `done` }]);
        // And out of the transcript: no daemon anywhere has a record of it.
        expect(conversation.transcript.messages.value).toEqual([]);
    });

    // A Stop on a send that never became a turn must not arm the continue offer: nothing is behind it to resume, and
    // it must not open a fresh session on the bare word "Continue".
    it(`stands the continue offer down when the stopped send never became a turn`, async () => {
        const conversation = new Conversation(`c1`);
        daemon.mockImplementation((procedure, input, options) => {
            // The stop never reaches the daemon either, so this window draws the ending itself.
            if (procedure === `agent.stop`) {
                return Promise.reject(daemonRefusal(404));
            }
            if (procedure !== `agent.run`) {
                return Promise.resolve({});
            }
            // Hangs exactly as a send into a stalled daemon does, and dies the way fetch does when Stop aborts it.
            return new Promise<never>((_resolve, reject) => {
                options?.signal?.addEventListener(`abort`, () => reject(new DOMException(`aborted`, `AbortError`)));
            });
        });

        const turn = conversation.turn.send(`the setup view is too scary`, settings);
        expect(conversation.turn.streaming.value).toBe(true);
        conversation.turn.stop();
        await turn;

        expect(conversation.pickUp.value).toBeUndefined();
        expect(conversation.draft.value).toBe(`the setup view is too scary`);
        // A Stop is the user's own doing, so it says so and nothing more: no red line over a send they cancelled.
        expect(conversation.transcript.messages.value.map((message) => [message.role, message.text])).toEqual([[`notice`, `Stopped.`]]);
        expect(conversation.error.value).toBeNull();
    });

    it(`replays the held message once the account is reconnected`, async () => {
        const conversation = new Conversation(`c1`);
        daemon.mockImplementation(
            turnDaemon([{ kind: `error`, code: `claude-reauth`, message: `Claude sign-in was revoked, reconnect the account.` }]),
        );
        await conversation.turn.send(`land the branch`, {
            agent: `claude`,
            harness: `native`,
            actsAs: undefined,
            startIn: undefined,
            model: `opus`,
            effort: `medium`,
            thinking: false,
            fast: false,
            account: `acct-dead`,
        });

        // The reconnect lands on the same account id (the daemon's one connect rule), so releasing the held words names
        // no account: they run where the conversation already runs.
        daemon.mockImplementation(turnDaemon([{ kind: `delta`, text: `Landed.` }], { head: () => ({ prompt: `land the branch` }) }));
        await conversation.turn.resume();

        const released = daemon.mock.calls.find(([procedure]) => procedure === `agent.queueResume`);
        expect(wire(released?.[1])).toMatchObject({ conversationId: `c1`, routing: { agent: `claude` } });
        expect(wire(released?.[1])[`routing`]).not.toHaveProperty(`account`);
        expect(conversation.transcript.messages.value.map(({ role, text }) => ({ role, text }))).toEqual([
            { role: `notice`, text: expect.stringContaining(`revoked`) as unknown as string },
            { role: `user`, text: `land the branch` },
            { role: `assistant`, text: `Landed.` },
        ]);
    });

    // A reconnect keeps the account id (the daemon's one connect rule), so nothing about the session ref changes and the
    // next send resumes it.
    it(`keeps the session resumable across a reconnect`, async () => {
        const conversation = new Conversation(`c1`);
        daemon.mockImplementation(turnDaemon([{ kind: `session`, sessionId: `s-1` }]));
        await conversation.turn.send(`hi`, {
            agent: `claude`,
            harness: `native`,
            actsAs: undefined,
            startIn: undefined,
            model: `opus`,
            effort: `medium`,
            thinking: false,
            fast: false,
            account: `acct-dead`,
        });

        await conversation.turn.send(`again`, {
            agent: `claude`,
            harness: `native`,
            actsAs: undefined,
            startIn: undefined,
            model: `opus`,
            effort: `medium`,
            thinking: false,
            fast: false,
            account: `acct-dead`,
        });

        const body = wire(daemon.mock.calls.at(-2)![1]);
        expect(body[`sessionId`]).toBe(`s-1`);
    });

    it(`reattach replays an already-answered question card as decided, not as a live prompt`, async () => {
        // A reload replays the run from seq 0, rebuilding the card from its own frame; without the resolution frame
        // too,
        // it comes back pending and offers Submit on an already-resolved requestId.
        const conversation = new Conversation(`c1`);
        const questions = [{ question: `Which?`, header: `Pick`, multiSelect: false, options: [{ label: `A`, description: `a` }] }];
        daemon.mockImplementation(
            turnDaemon(
                [
                    { kind: `question`, requestId: `q1`, questions },
                    { kind: `resolved`, requestId: `q1`, reply: { kind: `question`, requestId: `q1`, answers: { Which: [`A`] } } },
                    { kind: `delta`, text: `Doing A.` },
                ],
                { head: () => ({ prompt: `which one?`, startedAt: 1234 }) },
            ),
        );

        await expect(conversation.turn.reattach()).resolves.toBe(true);

        expect(conversation.transcript.messages.value[1]!.question).toMatchObject({ status: `answered`, answers: { Which: [`A`] } });
        // Nothing is parked, so the composer is free and no card is asking for an answer that was already given.
        expect(conversation.transcript.awaitingDecision.value).toBe(false);
    });

    it(`reattach reports false when nothing is running, leaving the transcript untouched`, async () => {
        const conversation = new Conversation(`c1`);
        daemon.mockRejectedValue(daemonRefusal(404));

        await expect(conversation.turn.reattach()).resolves.toBe(false);

        expect(conversation.transcript.messages.value).toHaveLength(0);
        expect(conversation.turn.streaming.value).toBe(false);
        expect(conversation.error.value).toBeNull();
    });

    it(`ignores empty prompts and re-entrant sends while streaming`, async () => {
        const conversation = new Conversation(`c1`);
        await conversation.turn.send(`   `, settings);
        expect(conversation.transcript.messages.value).toHaveLength(0);
        expect(daemon).not.toHaveBeenCalled();

        daemon.mockImplementation(turnDaemon([{ kind: `delta`, text: `x` }], { stayOpen: true }));
        const turn = conversation.turn.send(`real`, settings);
        await waitFor(() => expect(conversation.turn.streaming.value).toBe(true));
        await conversation.turn.send(`while busy`, settings);
        expect(conversation.transcript.messages.value.filter((message) => message.role === `user`)).toHaveLength(1);
        conversation.turn.stop();
        await turn;
    });

    it(`redraws a restored transcript with its thinking and tool cards`, () => {
        const conversation = new Conversation(`c1`);

        conversation.transcript.restoreMessages([
            { role: `user`, text: `fix it` },
            { role: `assistant`, text: `Reading.`, thinking: `hmm`, tools: [{ id: `t1`, name: `Read`, category: `read`, status: `completed` }] },
        ]);

        expect(conversation.transcript.messages.value).toHaveLength(2);
        expect(conversation.transcript.messages.value[1]).toMatchObject({
            role: `assistant`,
            text: `Reading.`,
            thinking: `hmm`,
            tools: [{ name: `Read`, status: `completed` }],
        });
        // Ids are minted locally and must stay unique, so a later streamed bubble can't collide with a restored one.
        expect(new Set(conversation.transcript.messages.value.map((message) => message.id)).size).toBe(2);
    });

    // Attachments are recovered from the stored prompt's note; the redrawn bubble shows them as named chips, not the
    // injected protocol text.
    it(`redraws a restored message's attachments as chips`, () => {
        const conversation = new Conversation(`c1`);

        conversation.transcript.restoreMessages([
            { role: `user`, text: `analyze this`, attachments: [`${STATE_DIR}/records/artifacts/attachments/uuid-1/image.png`] },
        ]);

        expect(conversation.transcript.messages.value[0]).toMatchObject({
            role: `user`,
            text: `analyze this`,
            attachments: [`.intentic/records/artifacts/attachments/uuid-1/image.png`],
        });
    });

    // A restored tab already carries its posture from the tab snapshot; history-menu defaults must not move an
    // isolated agent's next turn off its own worktree.
    it(`leaves an isolated conversation's posture alone when its transcript is restored`, () => {
        const conversation = new Conversation(`c1`);
        conversation.isolated.value = true;
        conversation.selection.apply({ kind: `set`, picks: { provider: `codex` } });

        conversation.transcript.restoreMessages([{ role: `user`, text: `hi` }]);

        expect(conversation.isolated.value).toBe(true);
        expect(conversation.selection.provider.value).toBe(`codex`);
    });
});

// A minimized or fully occluded window gets no requestAnimationFrame; the clock needs a fallback timer so the
// transcript doesn't go stale in it.
describe(`the transcript's clock`, () => {
    it(`applies frames on its own timer when the window never delivers one`, async () => {
        const conversation = new Conversation(`c-parked`);
        // Frames requested but never delivered, as with a minimized window.
        stubGlobal(`requestAnimationFrame`, () => 0);
        daemon.mockImplementation(turnDaemon([{ kind: `delta`, text: `hi` }], { stayOpen: true }));

        const turn = conversation.turn.send(`go`, settings);

        await waitFor(() => expect(conversation.transcript.messages.value.at(-1)).toMatchObject({ role: `assistant`, text: `hi` }), {
            timeout: 2_000,
        });

        conversation.turn.stop();
        await turn;
    });

    // The daemon's transcript index and the bubble's position are different numbers that diverge once a local notice
    // is drawn; rewinding must use the daemon's index, not the bubble's.
    it(`rewinds by the daemon's transcript index and truncates by the bubble's, then drops the session`, async () => {
        const conversation = new Conversation(`c-rewind`);
        daemon.mockImplementation(
            turnDaemon([
                { kind: `session`, sessionId: `s-1` },
                // index 0: the daemon has this turn's user message at the head of its record.
                { kind: `checkpoint`, id: `cp-1`, index: 0 },
                { kind: `delta`, text: `done` },
                { kind: `done` },
            ]),
        );
        await conversation.turn.send(`first`, settings);
        expect(conversation.session.value).toEqual(expect.any(Object));

        const user = conversation.transcript.messages.value[0];
        expect(user).toMatchObject({ role: `user`, checkpointId: `cp-1`, rewindIndex: 0 });

        daemon.mockResolvedValue({ snapshot: `cp-1`, dropped: 2 });
        expect(await conversation.transcript.rewindTo(user!)).toBe(true);

        expect(daemon).toHaveBeenLastCalledWith(
            `agent.rewind`,
            { conversationId: `c-rewind`, index: 0, messageId: user?.messageId },
            { context: { at: undefined } },
        );
        expect(user?.messageId).toEqual(expect.any(String));
        // Everything from the rewound message on is gone and the session drops; the notice is the only place that says
        // so, including that the workspace moved too.
        expect(conversation.transcript.messages.value).toEqual([
            expect.objectContaining({ role: `notice`, text: `Went back to here, 2 messages dropped and the files restored to this point.` }),
        ]);
        expect(conversation.session.value).toBeUndefined();
    });

    it(`leaves the tab untouched when the daemon refuses the rewind`, async () => {
        const conversation = new Conversation(`c-busy`);
        daemon.mockImplementation(
            turnDaemon([{ kind: `session`, sessionId: `s-1` }, { kind: `checkpoint`, id: `cp-1`, index: 0 }, { kind: `done` }]),
        );
        await conversation.turn.send(`first`, settings);
        const before = conversation.transcript.messages.value.length;

        daemon.mockRejectedValue(daemonRefusal(409));
        expect(await conversation.transcript.rewindTo(conversation.transcript.messages.value[0]!)).toBe(false);

        // A transcript cut against a workspace that never moved is the one state with no way back.
        expect(conversation.transcript.messages.value).toHaveLength(before);
        expect(conversation.session.value).toEqual(expect.any(Object));
        expect(conversation.error.value).toContain(`running a turn`);
    });

    // Another window rewound and a turn ran since this tab read the transcript: the position it names holds some other
    // message now, and the daemon refuses rather than restore the wrong point.
    it(`says the conversation moved on when the message is no longer where this tab saw it`, async () => {
        const conversation = new Conversation(`c-moved`);
        daemon.mockImplementation(
            turnDaemon([{ kind: `session`, sessionId: `s-1` }, { kind: `checkpoint`, id: `cp-1`, index: 0 }, { kind: `done` }]),
        );
        await conversation.turn.send(`first`, settings);
        const before = conversation.transcript.messages.value.length;

        daemon.mockRejectedValue(daemonRefusal(412));
        expect(await conversation.transcript.rewindTo(conversation.transcript.messages.value[0]!)).toBe(false);

        expect(conversation.transcript.messages.value).toHaveLength(before);
        expect(conversation.error.value).toBe(`This conversation has moved on since you opened it: reload it and try again.`);
    });
});

// TranscriptView.beginEdit/cancelEdit/submitEdit: editing a sent message. Arming destroys and sends nothing, so
// cancel costs nothing; only submit spends the rewind, and only if it lands does anything go out.
describe(`Conversation editing a sent message`, () => {
    // One turn, checkpointed, with the session live: the state every edit starts from.
    const settled = async (id: string): Promise<Conversation> => {
        const conversation = new Conversation(id);
        daemon.mockImplementation(
            turnDaemon([
                { kind: `session`, sessionId: `s-1` },
                { kind: `checkpoint`, id: `cp-1`, index: 0 },
                { kind: `delta`, text: `done` },
                { kind: `done` },
            ]),
        );
        await conversation.turn.send(`frist`, settings);
        return conversation;
    };

    it(`arms without touching the transcript, the files or the session`, async () => {
        const conversation = await settled(`c-edit-arm`);
        conversation.draft.value = `something half-written`;
        const before = [...conversation.transcript.messages.value];
        daemon.mockClear();

        expect(conversation.transcript.beginEdit(conversation.transcript.messages.value[0]!)).toBe(true);

        // Old words are in the box, the transcript untouched, and the daemon never asked: nothing yet to undo.
        expect(conversation.draft.value).toBe(`frist`);
        expect(conversation.transcript.messages.value).toEqual(before);
        expect(conversation.session.value).toEqual(expect.any(Object));
        expect(daemon).not.toHaveBeenCalled();
    });

    // Entering an edit must not eat a half-written draft, the one thing here the app cannot recover (see `unsent`).
    it(`gives the displaced draft back on cancel`, async () => {
        const conversation = await settled(`c-edit-cancel`);
        conversation.draft.value = `something half-written`;

        conversation.transcript.beginEdit(conversation.transcript.messages.value[0]!);
        conversation.draft.value = `retyped`;
        conversation.transcript.cancelEdit();

        expect(conversation.draft.value).toBe(`something half-written`);
        expect(conversation.transcript.editing.value).toBeUndefined();
    });

    it(`refuses to arm on a message with no state to go back to`, async () => {
        const conversation = new Conversation(`c-edit-uncheckpointed`);
        daemon.mockImplementation(turnDaemon([{ kind: `session`, sessionId: `s-1` }, { kind: `delta`, text: `hi` }, { kind: `done` }]));
        await conversation.turn.send(`first`, settings);

        // No checkpoint means no anchor: files can't be restored, so an edit here would start the replacement on the
        // work
        // it should discard.
        expect(conversation.transcript.messages.value[0]?.rewindIndex).toBeUndefined();
        expect(conversation.transcript.beginEdit(conversation.transcript.messages.value[0]!)).toBe(false);
        expect(conversation.transcript.editing.value).toBeUndefined();
    });

    // The rewind must go first and the send only if it lands; reversed, the replacement would run against a workspace
    // still holding the discarded turns.
    it(`rewinds to the message and sends the replacement in its place`, async () => {
        const conversation = await settled(`c-edit-send`);
        conversation.transcript.beginEdit(conversation.transcript.messages.value[0]!);
        conversation.draft.value = `first`;

        const calls: string[] = [];
        const turn = turnDaemon([{ kind: `delta`, text: `better` }, { kind: `done` }]);
        daemon.mockImplementation(async (procedure: string, input: unknown, options?: CallOptions) => {
            calls.push(procedure);
            return procedure === `agent.rewind` ? { snapshot: `cp-1`, dropped: 2 } : turn(procedure, input, options);
        });

        expect(await conversation.transcript.submitEdit(`first`)).toBe(true);

        // The rewind went first, and the turn only after it.
        expect(calls[0]).toBe(`agent.rewind`);
        expect(calls.slice(1).some((called) => called !== `agent.rewind`)).toBe(true);
        expect(conversation.transcript.editing.value).toBeUndefined();
        // The notice names the edit, not the rewind underneath it, so it doesn't read as an unrelated rewind plus a
        // fresh
        // prompt.
        expect(conversation.transcript.messages.value[0]).toMatchObject({
            role: `notice`,
            text: `Edited this message, 2 messages dropped and the files restored to this point.`,
        });
        expect(conversation.transcript.messages.value[1]).toMatchObject({ role: `user`, text: `first` });
    });

    // A refused rewind leaves the chat untouched, its reason shown, and the edit still armed so the press works once
    // the turn ends.
    it(`sends nothing and stays armed when the rewind is refused`, async () => {
        const conversation = await settled(`c-edit-refused`);
        conversation.transcript.beginEdit(conversation.transcript.messages.value[0]!);
        const before = [...conversation.transcript.messages.value];

        daemon.mockRejectedValue(daemonRefusal(409));
        expect(await conversation.transcript.submitEdit(`try again`)).toBe(false);

        expect(conversation.transcript.messages.value).toEqual(before);
        expect(conversation.transcript.editing.value).toEqual(expect.any(Object));
        expect(conversation.error.value).toContain(`running a turn`);
    });

    // Message ids restart from zero on every rebuild, so a replayed record can hand the same id to a different
    // message; an edit resolved by id alone would silently replace the wrong turn.
    it(`disarms when the transcript underneath it is replaced wholesale`, async () => {
        const conversation = await settled(`c-edit-replaced`);
        conversation.transcript.beginEdit(conversation.transcript.messages.value[0]!);
        expect(conversation.transcript.editing.value).toEqual(expect.any(Object));

        // A different record, whose first message carries the id the edit was armed on.
        conversation.transcript.restoreMessages([{ role: `user`, text: `a different conversation entirely` }]);
        daemon.mockClear();

        expect(conversation.transcript.editing.value).toBeUndefined();
        expect(await conversation.transcript.submitEdit(`replacement`)).toBe(false);
        expect(daemon).not.toHaveBeenCalled();
        expect(conversation.transcript.messages.value).toEqual([expect.objectContaining({ text: `a different conversation entirely` })]);
    });

    // A plain rewind also renumbers every surviving message, so an armed edit must disarm here too.
    it(`disarms when a plain rewind renumbers the messages under it`, async () => {
        const conversation = await settled(`c-edit-rewound`);
        conversation.transcript.beginEdit(conversation.transcript.messages.value[0]!);

        daemon.mockResolvedValue({ snapshot: `cp-1`, dropped: 2 });
        expect(await conversation.transcript.rewindTo(conversation.transcript.messages.value[0]!)).toBe(true);

        expect(conversation.transcript.editing.value).toBeUndefined();
        // And it is the REWIND's own sentence, not the edit's: nobody edited anything here.
        expect(conversation.transcript.messages.value[0]).toMatchObject({
            text: `Went back to here, 2 messages dropped and the files restored to this point.`,
        });
    });
});

// TranscriptView.placeAsAgent: the tab's half of agents.place. The daemon appends the row and drops the provider
// session; a refusal must move nothing here either.
describe(`Conversation placeAsAgent`, () => {
    it(`appends a marked agent bubble and drops the session, so the next send starts a fresh thread`, async () => {
        const conversation = new Conversation(`c-place`);
        daemon.mockImplementation(turnDaemon([{ kind: `session`, sessionId: `s-1` }, { kind: `delta`, text: `done` }, { kind: `done` }]));
        await conversation.turn.send(`first`, settings);
        expect(conversation.session.value).toEqual(expect.any(Object));

        daemon.mockResolvedValue({ ok: true });
        expect(await conversation.transcript.placeAsAgent(`I checked the tests.`)).toBe(true);

        expect(daemon).toHaveBeenLastCalledWith(`agents.place`, { id: `c-place`, text: `I checked the tests.` }, { context: { at: undefined } });
        // The bubble reads as the agent's, carrying the mark whose one audience is the human re-reading this.
        expect(conversation.transcript.messages.value.at(-1)).toMatchObject({ role: `assistant`, text: `I checked the tests.`, placed: true });
        // And the local session matches the daemon's forgotten one: the next send resumes nothing.
        expect(conversation.session.value).toBeUndefined();
    });

    it(`leaves the tab untouched when the daemon refuses the place`, async () => {
        const conversation = new Conversation(`c-place-busy`);
        daemon.mockImplementation(turnDaemon([{ kind: `session`, sessionId: `s-1` }, { kind: `done` }]));
        await conversation.turn.send(`first`, settings);
        const before = conversation.transcript.messages.value.length;

        daemon.mockRejectedValue(daemonRefusal(409));
        expect(await conversation.transcript.placeAsAgent(`planted`)).toBe(false);

        expect(conversation.transcript.messages.value).toHaveLength(before);
        expect(conversation.session.value).toEqual(expect.any(Object));
        expect(conversation.error.value).toContain(`running a turn`);
    });

    // A channel conversation's place can fail because the channel itself is unreachable; the daemon's sentence is the
    // only thing naming which audience missed it, so it surfaces verbatim.
    it(`surfaces the daemon's sentence when the channel delivery is refused`, async () => {
        const conversation = new Conversation(`c-place-channel`);
        daemon.mockImplementation(turnDaemon([{ kind: `session`, sessionId: `s-1` }, { kind: `done` }]));
        await conversation.turn.send(`first`, settings);
        const before = conversation.transcript.messages.value.length;

        const daemonMessage = `the discord gateway is not running, so the message cannot reach the channel`;
        daemon.mockRejectedValue(daemonRefusal(502, daemonMessage));
        expect(await conversation.transcript.placeAsAgent(`planted`)).toBe(false);

        expect(conversation.transcript.messages.value).toHaveLength(before);
        expect(conversation.error.value).toContain(`discord gateway`);
    });

    // The mark survives a reopen: the record's `placed` maps back onto the bubble a restored tab draws.
    it(`restores a placed row with its mark`, () => {
        const conversation = new Conversation(`c-place-restore`);
        conversation.transcript.restoreMessages([
            { role: `user`, text: `map the flow` },
            { role: `assistant`, text: `I checked the tests.`, placed: true },
        ]);
        expect(conversation.transcript.messages.value.at(-1)).toMatchObject({ role: `assistant`, text: `I checked the tests.`, placed: true });
        expect(conversation.transcript.messages.value[0]).not.toHaveProperty(`placed`);
    });
});

// ChatMessage.sentAt: the hover stamp. Three sources (sent here, already running on attach, restored from the
// record) must agree on the hour the user actually pressed send.
describe(`Conversation sent time`, () => {
    it(`stamps a message the user sends here with the moment it was sent`, async () => {
        const conversation = new Conversation(`c1`);
        daemon.mockImplementation(turnDaemon([{ kind: `delta`, text: `On it.` }, { kind: `done` }]));

        const before = Date.now();
        await conversation.turn.send(`Hi there`, settings);

        const sentAt = conversation.transcript.messages.value[0]?.sentAt;
        expect(sentAt).toBeGreaterThanOrEqual(before);
        expect(sentAt).toBeLessThanOrEqual(Date.now());
        // Only the user's row gets a stamp; nothing in the stream says when part of the answer was written, and a
        // guessed
        // time is worse than none.
        expect(conversation.transcript.messages.value[1]?.sentAt).toBeUndefined();
    });

    // A turn already running before this tab attached is drawn now but was sent then, so its bubble takes the run's
    // start time, not the attach moment.
    it(`takes the running turn's own start for a bubble drawn on reattach`, async () => {
        const conversation = new Conversation(`c1`);
        daemon.mockImplementation(
            turnDaemon([{ kind: `delta`, text: `On it.` }], { head: () => ({ prompt: `refactor the parser`, startedAt: 1234 }) }),
        );

        await expect(conversation.turn.reattach()).resolves.toBe(true);

        expect(conversation.transcript.messages.value[0]).toMatchObject({ role: `user`, text: `refactor the parser`, sentAt: 1234 });
    });

    // The daemon writes `sentAt` beside the words (TranscriptRow.sentAt); a redraw from the record must not re-date
    // them.
    it(`keeps the daemon's stamp when a stored transcript is restored`, () => {
        const conversation = new Conversation(`c1`);

        conversation.transcript.restoreMessages([
            { role: `user`, text: `start the migration`, sentAt: 1_767_225_600_000 },
            { role: `assistant`, text: `Done with step one.` },
        ]);

        expect(conversation.transcript.messages.value.map((message) => message.sentAt)).toEqual([1_767_225_600_000, undefined]);
    });

    // Conversation.box: a conversation homed in another sandbox. No leg (send/attach/stop) may point at the wrong
    // box. Asserted against each call's context, since nothing in the input says where it went.
    describe(`homed in another sandbox`, () => {
        const remote = (): Conversation => {
            const conversation = new Conversation(`c-elsewhere`);
            conversation.box.value = `sbx-there`;
            return conversation;
        };

        it(`starts the turn on that box's daemon and follows the run there`, async () => {
            const conversation = remote();
            daemon.mockImplementation(turnDaemon([{ kind: `delta`, text: `on it` }, { kind: `done` }]));

            await conversation.turn.send(`do it over there`, settings);

            expect(proceduresAimedAt(`sbx-there`)).toEqual([`agent.run`, `agent.attach`]);
            expect(proceduresAimedAt(undefined)).toEqual([]);
        });

        // `registered` normally latches on a roster frame; this browser streams only one sandbox, so without the ack
        // fallback a remote tab would stay a draft forever and show a phantom New-agent card.
        it(`counts as registered from the daemon's ack, since no roster frame here will ever say so`, async () => {
            const conversation = remote();
            daemon.mockImplementation(turnDaemon([{ kind: `done` }]));

            expect(conversation.registered.value).toBe(false);
            await conversation.turn.send(`start`, settings);
            expect(conversation.registered.value).toBe(true);
        });

        // A local conversation keeps the roster-frame latch; the ack alone isn't evidence when a proper stream exists.
        it(`leaves a local conversation's registration to the roster`, async () => {
            const conversation = new Conversation(`c-here`);
            daemon.mockImplementation(turnDaemon([{ kind: `done` }]));

            await conversation.turn.send(`start`, settings);

            expect(conversation.registered.value).toBe(false);
            expect(proceduresAimedAt(undefined)).toEqual([`agent.run`, `agent.attach`]);
        });

        // Stop is the side channel, and it has to reach the daemon actually running the turn.
        it(`stops the turn at the box running it`, async () => {
            const conversation = remote();
            daemon.mockImplementation(turnDaemon([{ kind: `delta`, text: `working` }], { stayOpen: true }));

            const sending = conversation.turn.send(`long one`, settings);
            await waitFor(() => expect(conversation.turn.streaming.value).toBe(true));
            conversation.turn.stop();
            await sending;

            expect(proceduresAimedAt(`sbx-there`)).toContain(`agent.stop`);
            expect(proceduresAimedAt(undefined)).toEqual([]);
        });
    });
});

// Paging back through a conversation longer than one window. The daemon answers a transcript read with the most
// recent turns and says where they start (sessions/transcript-record.ts); paging back must not cost what's
// already on screen.
describe(`older history`, () => {
    // The daemon's answer to `agents.transcript` with a `before`, as the typed client hands it back.
    const olderPage = (messages: TranscriptRow[], from: number, more: boolean): { messages: TranscriptRow[]; from: number; more: boolean } => ({
        messages,
        from,
        more,
    });

    const opened = (): Conversation => {
        const conversation = new Conversation(`c1`);
        conversation.transcript.restoreMessages(
            [
                { role: `user`, text: `turn 20` },
                { role: `assistant`, text: `answer 20` },
            ],
            { from: 40, more: true },
        );
        return conversation;
    };

    it(`opens on a window that knows it is one`, () => {
        const conversation = opened();
        expect(conversation.transcript.historyFrom.value).toBe(40);
        expect(conversation.transcript.historyMore.value).toBe(true);
    });

    // A conversation that fits in one window says so, and is the case that must offer nothing: most of them.
    it(`offers nothing to page back through when the record arrived whole`, async () => {
        const conversation = new Conversation(`c1`);
        conversation.transcript.restoreMessages([{ role: `user`, text: `hello` }], { from: 0, more: false });

        await conversation.transcript.loadOlder();

        expect(conversation.transcript.historyMore.value).toBe(false);
        expect(proceduresAimedAt(undefined)).toEqual([]);
    });

    it(`puts the older page above what is drawn and moves the cursor to it`, async () => {
        const conversation = opened();
        daemon.mockResolvedValue(
            olderPage(
                [
                    { role: `user`, text: `turn 19` },
                    { role: `assistant`, text: `answer 19` },
                ],
                38,
                true,
            ),
        );

        await conversation.transcript.loadOlder();

        expect(conversation.transcript.messages.value.map(({ text }) => text)).toEqual([`turn 19`, `answer 19`, `turn 20`, `answer 20`]);
        expect(conversation.transcript.historyFrom.value).toBe(38);
        expect(conversation.transcript.historyMore.value).toBe(true);
        expect(daemon.mock.calls).toEqual([[`agents.transcript`, { id: `c1`, before: 40 }, { context: { at: undefined } }]]);
    });

    // Ids are identity, not order; a prepended page must not hand an older bubble the id of one already on screen,
    // since a live patch addresses messages by id and a collision would misapply it.
    it(`gives the arriving rows ids of their own`, async () => {
        const conversation = opened();
        const standing = conversation.transcript.messages.value.map((message) => message.id);
        daemon.mockResolvedValue(
            olderPage(
                [
                    { role: `user`, text: `turn 19` },
                    { role: `assistant`, text: `answer 19` },
                ],
                38,
                true,
            ),
        );

        await conversation.transcript.loadOlder();

        const ids = conversation.transcript.messages.value.map((message) => message.id);
        expect(new Set(ids).size).toBe(ids.length);
        // And the rows that were already drawn keep the ids they had, so nothing addressing them goes stale.
        expect(ids.slice(2)).toEqual(standing);
    });

    // Reaching the beginning retires the offer, so the top of the record reads as the top of the record.
    it(`stops offering once the first page of the record lands`, async () => {
        const conversation = opened();
        daemon.mockResolvedValue(olderPage([{ role: `user`, text: `turn 1` }], 0, false));

        await conversation.transcript.loadOlder();

        expect(conversation.transcript.historyFrom.value).toBe(0);
        expect(conversation.transcript.historyMore.value).toBe(false);
    });

    // Two presses against one cursor are the same page twice; the second is refused rather than queued.
    it(`reads one page per cursor however many times it is asked`, async () => {
        const conversation = opened();
        daemon.mockResolvedValue(olderPage([{ role: `user`, text: `turn 19` }], 38, true));

        await Promise.all([conversation.transcript.loadOlder(), conversation.transcript.loadOlder()]);

        expect(daemon.mock.calls).toEqual([[`agents.transcript`, { id: `c1`, before: 40 }, { context: { at: undefined } }]]);
        expect(conversation.transcript.messages.value.map(({ text }) => text)).toEqual([`turn 19`, `turn 20`, `answer 20`]);
    });

    // A failed read costs nothing: the transcript stays as it was and the offer stands, so retrying is the same press
    // again.
    it(`leaves the transcript and the offer alone when the read fails`, async () => {
        const conversation = opened();
        daemon.mockRejectedValue(new Error(`tunnel closed`));

        await expect(conversation.transcript.loadOlder()).resolves.toBeUndefined();

        expect(conversation.transcript.messages.value.map(({ text }) => text)).toEqual([`turn 20`, `answer 20`]);
        expect(conversation.transcript.historyFrom.value).toBe(40);
        expect(conversation.transcript.historyMore.value).toBe(true);
        expect(conversation.transcript.loadingOlder.value).toBe(false);
    });

    // A redraw (rewind, runtime handoff) replaces the window, so the cursor must move with it; a stale `historyFrom`
    // would fetch rows that no longer sit above anything on screen.
    it(`re-aims the cursor when the transcript is redrawn under it`, () => {
        const conversation = opened();
        conversation.transcript.restoreMessages([{ role: `user`, text: `only turn` }], { from: 0, more: false });
        expect(conversation.transcript.historyFrom.value).toBe(0);
        expect(conversation.transcript.historyMore.value).toBe(false);
    });

    // A caller with no page to report can't vouch for where its rows sit, so the cursor reads "this is all of it"
    // rather than a stale one.
    it(`drops the cursor for a redraw that cannot say where its rows sit`, () => {
        const conversation = opened();
        conversation.transcript.restoreMessages([{ role: `user`, text: `from the mirror` }]);
        expect(conversation.transcript.historyMore.value).toBe(false);
    });
});

// An app errand whose words need a read first (a land conflict's fresh report). The turn opens at the call, so the chat
// shows the errand's row and the working line through that read rather than nothing; the read's answer decides
// whether anything is sent at all, and nothing about a turn that never went is left behind.
describe(`TurnClient.startErrand`, () => {
    const opening = errands().landConflict.opening;
    const prompt = `${opening}\n\nWhat blocked the land:\nroot\n  - a.ts`;
    // Every procedure this test's conversation called, in order.
    const asked = (): string[] => daemon.mock.calls.map(([procedure]) => procedure);

    it(`opens the turn under the errand's row before its words exist, then sends the words it composed`, async () => {
        const conversation = new Conversation(`c-errand`);
        daemon.mockImplementation(turnDaemon([{ kind: `done` }]));
        let answer: (words: string) => void = () => undefined;
        const taken = conversation.turn.startErrand(opening, () => new Promise((settle) => (answer = settle)));

        // Before the read answers: the row the transcript folds by its opening, a running turn, and nothing sent.
        expect(conversation.transcript.messages.value.map(({ role, text }) => ({ role, text }))).toEqual([{ role: `user`, text: opening }]);
        expect(conversation.turn.streaming.value).toBe(true);
        expect(conversation.turn.turnStartedAt.value).toBeGreaterThan(0);
        expect(asked()).toEqual([]);

        answer(prompt);

        expect(await taken).toBe(true);
        expect(turnBodies().map((body) => body[`prompt`])).toEqual([prompt]);
        await waitFor(() => expect(conversation.turn.streaming.value).toBe(false));
        expect(conversation.transcript.messages.value[0]).toMatchObject({ role: `user`, text: prompt });
    });

    it(`takes the turn back with nothing sent when the read leaves nothing to ask`, async () => {
        const conversation = new Conversation(`c-errand`);
        daemon.mockImplementation(turnDaemon([]));

        expect(await conversation.turn.startErrand(opening, async () => undefined)).toBe(false);

        expect(conversation.transcript.messages.value).toEqual([]);
        expect(conversation.turn.streaming.value).toBe(false);
        expect(conversation.draft.value).toBe(``);
        expect(asked()).toEqual([]);
    });

    // The daemon has never heard of a turn still composing, so there is nothing there to cancel: a Stop request would be
    // a round trip answering "nothing running", and the local turn would outlive the press until it came back.
    it(`ends a Stop pressed while composing here, aborting the read and asking the daemon nothing`, async () => {
        const conversation = new Conversation(`c-errand`);
        daemon.mockImplementation(turnDaemon([]));
        const reads: AbortSignal[] = [];
        const taken = conversation.turn.startErrand(
            opening,
            (signal) =>
                new Promise((_settle, fail) => {
                    reads.push(signal);
                    signal.addEventListener(`abort`, () => fail(new DOMException(`aborted`, `AbortError`)));
                }),
        );

        conversation.turn.stop();

        expect(await taken).toBe(false);
        expect(reads.map((signal) => signal.aborted)).toEqual([true]);
        expect(asked()).toEqual([]);
        expect(conversation.transcript.messages.value).toEqual([]);
        expect(conversation.turn.streaming.value).toBe(false);
        expect(conversation.error.value).toBeNull();
        // A stopped errand leaves no words to send again: nothing of the user's was ever in it.
        expect(conversation.draft.value).toBe(``);
    });

    // Not every read honours an abort (a re-judging land already on its way, a transport that keeps going): the Stop is
    // the reader's, so it ends the turn in the frame it was pressed rather than whenever that read gets round to it.
    it(`ends a Stop pressed while composing at once, even over a read that ignores the abort`, async () => {
        const conversation = new Conversation(`c-errand`);
        daemon.mockImplementation(turnDaemon([]));
        let finish: (words: string) => void = () => undefined;
        const taken = conversation.turn.startErrand(opening, () => new Promise((settle) => (finish = settle)));

        conversation.turn.stop();

        expect(await taken).toBe(false);
        expect(conversation.turn.streaming.value).toBe(false);
        expect(conversation.transcript.messages.value).toEqual([]);
        // Its late answer names a turn that is already gone, so nothing is sent on it.
        finish(prompt);
        await Promise.resolve();
        expect(asked()).toEqual([]);
        expect(conversation.transcript.messages.value).toEqual([]);
    });

    // The caller owns this sentence (the board's strip, the review's error line); the chat's own error line would be a
    // second copy of it under a row that is already gone.
    it(`hands a failed read to the caller and takes the turn back without an error of its own`, async () => {
        const conversation = new Conversation(`c-errand`);

        await expect(
            conversation.turn.startErrand(opening, async () => {
                throw new Error(`the report could not be read`);
            }),
        ).rejects.toThrow(`the report could not be read`);

        expect(conversation.transcript.messages.value).toEqual([]);
        expect(conversation.turn.streaming.value).toBe(false);
        expect(conversation.error.value).toBeNull();
    });

    it(`answers false when the daemon turns the composed turn away, which the chat explains itself`, async () => {
        const conversation = new Conversation(`c-errand`);
        daemon.mockImplementation(async (procedure) => {
            if (procedure === `agent.run`) {
                throw daemonRefusal(400, `No account here can run this.`);
            }
            return {};
        });

        expect(await conversation.turn.startErrand(opening, async () => prompt)).toBe(false);

        expect(conversation.turn.streaming.value).toBe(false);
        expect(conversation.error.value).toContain(`No account here can run this.`);
    });
});
