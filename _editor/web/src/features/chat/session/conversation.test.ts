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
} from "@intentic/sandbox-contract";
import { TranscriptFold, userRow } from "@intentic/sandbox-contract/transcript-fold";
import { watch } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Conversation } from "./conversation";
import { providerAccounts, selectedAccountId, usageByAccount } from "../accounts/providerAccounts";
import { turnDefaults } from "../run/turnDefaults";
import { resolvePrompt } from "../../agents/review/conflictResolution";
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

// sandboxError mocks the real one's refusal-message parsing, without sandboxClient's app-wide singletons. reachSpy
// records which sandbox each call targeted, since that argument is invisible in the request path.
const { reachSpy } = vi.hoisted(() => ({ reachSpy: vi.fn<(at: string | undefined, path: string) => void>() }));
vi.mock("../../sandbox/client/sandboxClient", () => {
    const sandboxRequest = vi.fn();
    return {
        sandboxRequest,
        // sandboxRequestVia on the real client's terms: `undefined` reach is the active box. Delegates to the shared
        // spy
        // and records the reach.
        sandboxRequestVia: (at: string | undefined, path: string, init?: RequestInit) => {
            reachSpy(at, path);
            return init === undefined ? sandboxRequest(path) : sandboxRequest(path, init);
        },
        sandboxError: async (response: Response) => new Error(((await response.json()) as { message: string }).message),
    };
});
const { sandboxRequest } = await import("../../sandbox/client/sandboxClient");
const sandboxRequestMock = vi.mocked(sandboxRequest);
// Every path this conversation addressed at a given box, in order.
const pathsAimedAt = (at: string | undefined): string[] => reachSpy.mock.calls.filter(([box]) => box === at).map(([, path]) => path);

// Stubs useChat-catalog's reload so a model-invalid error doesn't pull in the whole chat store. vi.hoisted so the
// mock factory can see the spy.
const { loadProviderModelsMock, loadTrialStatusMock } = vi.hoisted(() => ({
    loadProviderModelsMock: vi.fn(async () => {}),
    loadTrialStatusMock: vi.fn(async () => {}),
}));
vi.mock("../models/useChat-catalog", () => ({ loadProviderModels: loadProviderModelsMock, loadTrialStatus: loadTrialStatusMock }));

// turnDefaults is a module singleton; reseed before each test.
const seedTurnDefaults = (): void => {
    turnDefaults.models.value = { claude: `opus`, codex: ``, grok: `` };
    turnDefaults.provider.value = `claude`;
};

// selectAccount writes a sandbox-wide preference (selectedAccountId), not per-conversation; save and restore it so
// one test's switch doesn't leak into the next.
const accountPicks = { ...selectedAccountId.value };

// The typewriter drains via requestAnimationFrame; run frames synchronously so deltas land immediately.
beforeEach(() => {
    runsMinted = 0;
    seedTurnDefaults();
    vi.stubGlobal(`requestAnimationFrame`, (callback: FrameRequestCallback): number => {
        callback(0);
        return 0;
    });
    vi.stubGlobal(`cancelAnimationFrame`, () => {});
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    seedTurnDefaults();
    selectedAccountId.value = { ...accountPicks };
});

// One `data:` SSE frame, as the daemon's attach stream emits envelopes.
const encoder = new TextEncoder();
const sseFrame = (payload: unknown): Uint8Array => encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);

// Run id counter shared across every fake daemon in a test, so runs from different fakes get different ids; reset
// each test.
let runsMinted = 0;

// Mocks the daemon's turn protocol (ack, attach replay via TranscriptFold, stop/reply) for `sandboxRequest`.
// `head`, a thunk read per attach, overrides a resumed run's id, prompt and start time.
interface LiveRun {
    readonly controller: ReadableStreamDefaultController<Uint8Array>;
    readonly fold: TranscriptFold;
    seq: number;
    readonly queue: AgentEvent[];
}
const sseResponse = (
    events: AgentEvent[],
    options?: { stayOpen?: boolean; head?: () => Partial<{ run: string; prompt: string; rows: TranscriptRow[]; startedAt: number }> },
): ((path: string, init?: RequestInit) => Promise<Response>) => {
    // The turn the last POST /agent asked for: the head's opening row is built from it.
    let requested: { readonly prompt: string; readonly attachments: readonly string[] } | undefined;
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
    const ok = (): Promise<Response> => Promise.resolve({ ok: true, json: () => Promise.resolve({ run: runId }) } as Response);
    const emit = (state: LiveRun, patches: ReturnType<TranscriptFold[`apply`]>): void => {
        for (const patch of patches) {
            state.controller.enqueue(sseFrame({ kind: `patch`, seq: (state.seq += 1), patch }));
        }
    };
    const end = (state: LiveRun, ending: `settled` | `stopped`): void => {
        live = undefined;
        emit(state, state.fold.finish(ending));
        state.controller.enqueue(sseFrame({ kind: `end` }));
        state.controller.close();
    };
    // Stream the queued events until they run out, or a card parks the turn on the user.
    const serve = (state: LiveRun): void => {
        while (state.queue.length > 0) {
            const event = state.queue.shift()!;
            emit(state, state.fold.apply(event));
            if (isTurnFact(event)) {
                state.controller.enqueue(sseFrame({ kind: `fact`, seq: (state.seq += 1), fact: event }));
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
    return (path, init) => {
        const body = typeof init?.body === `string` ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
        if (path === `/agent`) {
            startTurn();
            requested = { prompt: String(body?.[`prompt`] ?? ``), attachments: (body?.[`attachments`] as string[] | undefined) ?? [] };
            return ok();
        }
        // Resume runs the held turn as a new turn on its own prompt copy; the head that follows opens its own run
        // rather
        // than replacing the refused attempt's rows.
        if (path === `/agent/resume`) {
            startTurn();
            return ok();
        }
        if (path === `/agent/stop`) {
            if (live !== undefined) {
                end(live, `stopped`);
            } else if (requested !== undefined) {
                stopRequested = true;
            } else {
                return Promise.resolve({ ok: false, status: 404 } as Response);
            }
            return ok();
        }
        if (path === `/agent/reply` && live !== undefined) {
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
        if (path !== `/agent/attach`) {
            return ok();
        }
        const overrides = options?.head?.() ?? {};
        const run = overrides.run ?? runId;
        const startedAt = overrides.startedAt ?? Date.now();
        const opening =
            overrides.rows ??
            (overrides.prompt === undefined
                ? openingOf(requested?.prompt ?? `hi`, startedAt, requested?.attachments ?? [])
                : openingOf(overrides.prompt, startedAt));
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                // Re-attach to a served run: the head already carries its rows, so nothing is left to fold in.
                const replay = served === undefined;
                const fold = served ?? new TranscriptFold(opening);
                served = fold;
                controller.enqueue(sseFrame({ kind: `attached`, run, startedAt, seq: 0, rows: structuredClone(fold.rows) }));
                const state: LiveRun = { controller, fold, seq: 0, queue: replay ? [...events] : [] };
                live = state;
                init?.signal?.addEventListener(`abort`, () => {
                    if (live === state) {
                        live = undefined;
                    }
                    controller.error(new DOMException(`aborted`, `AbortError`));
                });
                serve(state);
            },
        });
        return Promise.resolve({ ok: true, body: stream } as Response);
    };
};

// A run's opening rows, matching the daemon's openingRows (turn-transcript.ts): a resumed run opens on its notice,
// an answered park opens on the answer under a note, otherwise the prompt itself.
const openingOf = (prompt: string, sentAt: number, attachments: readonly string[] = []): TranscriptRow[] => {
    const resume = resumeDisclosure(prompt);
    if (resume?.kind === `notice`) {
        return [{ role: `notice`, text: resume.text }];
    }
    const row = userRow(withoutResumeNote(prompt), sentAt, attachments);
    return [resume?.kind === `note` ? { ...row, notes: [resume.note] } : row];
};

// The head frame of an attach stream: the run's identity and its rows so far.
const head = (overrides?: Partial<{ run: string; prompt: string; startedAt: number; seq: number; rows: TranscriptRow[] }>): AttachHead => ({
    kind: `attached`,
    run: overrides?.run ?? `r1`,
    startedAt: overrides?.startedAt ?? 0,
    seq: overrides?.seq ?? 0,
    rows: overrides?.rows ?? openingOf(overrides?.prompt ?? `hi`, overrides?.startedAt ?? 0),
});

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

// Parsed bodies of the turn-start (`/agent`) calls; attach/control posts interleave, so assert through this
// rather than raw call indexes.
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
    tierHold: false,
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

    it(`adopts the account the daemon served an unpinned turn on, so the next send resumes the session`, async () => {
        const conversation = new Conversation(`c-unpinned`);
        expect(conversation.account.value).toBeUndefined();
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `session`, sessionId: `s-1`, account: `with-room` }, { kind: `done` }]));

        await conversation.send(`hi`, settings);

        expect(conversation.session.value).toEqual({ id: `s-1`, provider: `claude`, account: `with-room`, harness: `native` });
        expect(conversation.account.value).toBe(`with-room`);
    });

    it(`leaves a pin the user made alone when the daemon reports the session on another account`, async () => {
        const conversation = new Conversation(`c-pinned`);
        conversation.account.value = `acct-1`;
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `session`, sessionId: `s-1`, account: `acct-2` }, { kind: `done` }]));

        await conversation.send(`hi`, { ...settings, account: `acct-1` });

        expect(conversation.session.value?.account).toBe(`acct-2`);
        expect(conversation.account.value).toBe(`acct-1`);
    });

    // Driven off a stalled clock rather than the file's synchronous RAF stub, and tool calls rather than deltas, since
    // a delta only reaches `messages` when the clock ticks and would hide the difference under test.
    it(`applies a burst of frames in one write, so render cost does not scale with frame count`, async () => {
        const runWith = async (calls: number): Promise<{ writes: number; tools: number }> => {
            vi.stubGlobal(`requestAnimationFrame`, (): number => 0);
            const conversation = new Conversation(`c1`);
            let writes = 0;
            // messages is what the renderer reads; `flush: sync` counts actual writes, not batched scheduler passes.
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
        // Codex's ChatGPT-account auth rejects a named model: an empty selection is omitted from the wire.
        expect(`model` in firstBody).toBe(false);

        conversation.selectProvider(`claude`);
        expect(conversation.messages.value.at(-1)!.role).toBe(`notice`);

        // An omitted sessionId is the whole signal that this is a fresh session; the daemon reseeds the replacement
        // itself.
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

        await conversation.send(`second`, settings);
        const secondBody = turnBodies()[1]!;
        expect(secondBody[`sessionId`]).toBe(`s-1`);
        expect(`history` in secondBody).toBe(false);
    });

    it(`says what a same-provider model swap costs, where it used to say nothing at all`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `session`, sessionId: `s-1` }]));
        await conversation.send(`first`, settings);

        conversation.selectModel({ provider: `claude`, value: `haiku` });
        const notice = conversation.messages.value.at(-1)!;
        expect(notice.role).toBe(`notice`);
        expect(notice.text).toContain(`Switched to`);
        expect(notice.text).not.toContain(`fresh session`);

        await conversation.send(`second`, { ...settings, model: `haiku` });
        const secondBody = turnBodies()[1]!;
        expect(secondBody[`sessionId`]).toBe(`s-1`);
        expect(secondBody[`model`]).toBe(`haiku`);
    });

    it(`says nothing about a model picked before the chat has run anything`, async () => {
        const conversation = new Conversation(`c1`);
        // No turn sent yet, so no cost exists for a divider to report.
        conversation.selectModel({ provider: `claude`, value: `haiku` });
        expect(conversation.messages.value).toEqual([]);
    });

    it(`retracts the model divider once the pick goes back to what the last turn ran on`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `session`, sessionId: `s-1` }]));
        await conversation.send(`first`, settings);

        conversation.selectModel({ provider: `claude`, value: `haiku` });
        expect(conversation.messages.value.at(-1)!.role).toBe(`notice`);
        // Landing back on the original pick costs nothing, so it says nothing, the same rule as the provider divider.
        conversation.selectModel({ provider: `claude`, value: `opus` });
        expect(conversation.messages.value.every((message) => message.role !== `notice`)).toBe(true);
    });

    // A catalog read that no longer lists this chat's pick moves it off (useChat-catalog); the pick is the user's, so
    // the move is a loan, not a decision. Displacing one-way is what spent an unchosen model's allowance for the rest
    // of a conversation whenever a routed channel de-listed a model it was out of capacity for.
    it(`owes back the model a thin catalog moved this chat off, and hands it back when it returns`, async () => {
        const conversation = new Conversation(`c1`);
        conversation.selectModel({ provider: `claude`, value: `opus` });
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `session`, sessionId: `s-1` }]));
        await conversation.send(`first`, settings);

        conversation.displaceModel(`haiku`);
        expect(conversation.model.value).toBe(`haiku`);
        expect(conversation.displacedModel.value).toBe(`opus`);
        // Said out loud like any other swap: the next message would run on a model the user never picked.
        expect(conversation.messages.value.at(-1)!.text).toContain(`Switched to`);

        conversation.restoreModel();
        expect(conversation.model.value).toBe(`opus`);
        expect(conversation.displacedModel.value).toBeUndefined();
        // Back on what the last turn ran, so the divider it raised goes with it.
        expect(conversation.messages.value.every((message) => message.role !== `notice`)).toBe(true);
    });

    it(`drops the debt the moment the user picks a model of their own`, () => {
        const conversation = new Conversation(`c1`);
        conversation.selectModel({ provider: `claude`, value: `opus` });
        conversation.displaceModel(`haiku`);

        conversation.selectModel({ provider: `claude`, value: `sonnet` });
        expect(conversation.displacedModel.value).toBeUndefined();

        conversation.restoreModel();
        // A restore has nothing to give back once the user has chosen: their pick stands.
        expect(conversation.model.value).toBe(`sonnet`);
    });

    it(`forgets a displaced model when the chat moves to another provider`, () => {
        const conversation = new Conversation(`c1`);
        conversation.selectModel({ provider: `claude`, value: `opus` });
        conversation.displaceModel(`haiku`);

        // The owed id belongs to Claude's catalog; nothing on Codex can honour it.
        conversation.selectProvider(`codex`);
        expect(conversation.displacedModel.value).toBeUndefined();
    });

    it(`names the allowance the new model spends, when the plan meters it and we have a reading`, async () => {
        usageByAccount.value = {};
        const conversation = new Conversation(`c1`);
        conversation.account.value = `acct-1`;
        sandboxRequestMock.mockImplementation(
            sseResponse([
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
        await conversation.send(`first`, { ...settings, account: `acct-1` });

        conversation.selectModel({ provider: `claude`, value: `claude-opus-4-6` });
        // Rounded once, by the same projection the usage meters use.
        expect(conversation.messages.value.at(-1)!.text).toContain(`Opus 61% used`);
    });

    it(`holds a divider for a model swapped mid-turn until the turn settles`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `delta`, text: `working` }], { stayOpen: true }));
        const turn = conversation.send(`go`, settings);
        await vi.waitFor(() => expect(conversation.streaming.value).toBe(true));

        // Allowed mid-stream (retires nothing), but the transcript tail belongs to the streaming turn; a divider there
        // would read as part of the answer.
        conversation.selectModel({ provider: `claude`, value: `haiku` });
        expect(conversation.messages.value.every((message) => message.role !== `notice`)).toBe(true);

        conversation.stop();
        await turn;
        // Settled: the tail is the composer's again, so the notice now describes the next message.
        expect(conversation.messages.value.some((message) => message.role === `notice` && message.text.includes(`Switched to`))).toBe(true);
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

    // A parked turn is `streaming` too (the run is alive), so a mid-turn guard on that flag also blocked switching
    // while waiting on a card; a refused allowance needs an account with headroom right then.
    it(`takes an account switch while a turn waits on a card, and holds its divider until the turn settles`, async () => {
        const conversation = new Conversation(`c1`);
        const questions = [{ question: `Which?`, header: `Pick`, multiSelect: false, options: [{ label: `A`, description: `a` }] }];
        sandboxRequestMock.mockImplementation(
            sseResponse(
                [
                    { kind: `session`, sessionId: `s-1` },
                    { kind: `question`, requestId: `q1`, questions },
                ],
                { stayOpen: true },
            ),
        );
        const turn = conversation.send(`ask me`, settings);
        await vi.waitFor(() => expect(conversation.awaitingDecision.value).toBe(true));

        conversation.selectAccount(`with-room`);
        expect(conversation.account.value).toBe(`with-room`);
        // Nothing drawn yet: the tail belongs to the card; a divider there would sit between the question and the
        // answer.
        expect(conversation.messages.value.every((message) => message.role !== `notice`)).toBe(true);

        conversation.stop();
        await turn;

        // Settled: the tail is the composer's again; the notice says the next message starts a fresh session (a new
        // account is serving).
        expect(conversation.messages.value.some((message) => message.role === `notice` && message.text.includes(`fresh session`))).toBe(true);

        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `done` }]));
        await conversation.send(`go on`, conversation.turnSettings());
        const secondBody = turnBodies()[1]!;
        expect(secondBody[`account`]).toBe(`with-room`);
        expect(`sessionId` in secondBody).toBe(false);
    });

    // `generating` is mid-answer with no card on screen; a switch there would name an account that isn't paying for
    // the turn being watched.
    it(`ignores an account switch while the model is generating`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `delta`, text: `working` }], { stayOpen: true }));
        const turn = conversation.send(`go`, settings);
        await vi.waitFor(() => expect(conversation.streaming.value).toBe(true));

        conversation.selectAccount(`with-room`);
        expect(conversation.account.value).toBeUndefined();

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
        conversation.modePick.value = `acceptEdits`;

        conversation.selectProvider(`codex`);
        expect(conversation.mode.value).toBe(`bypassPermissions`);

        // Claude Code honours modes directly; the pick was never overwritten, so it returns untouched.
        conversation.selectHarness(`claude-code`);
        expect(conversation.mode.value).toBe(`acceptEdits`);
        expect(conversation.capabilities.value.permissions).toBe(`modes`);

        // Native reads as autonomous again; `plan`, which every runtime has (emulated or not), rides through unchanged.
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

        // Switching to Codex clears a Claude-only model to the account default and clamps a Claude-only effort.
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
            tierHold: false,
        });
        const body = turnBodies()[0]!;
        expect(body[`agent`]).toBe(`codex`);
        expect(`model` in body).toBe(false);

        // A mid-chat pick switches the selection (no lock) and marks the pending cut with a notice.
        conversation.selectProvider(`claude`);
        expect(conversation.provider.value).toBe(`claude`);
        expect(conversation.messages.value.at(-1)!.role).toBe(`notice`);
    });

    // The persona is resolved per turn (turnSettings), not fixed at conversation start, so one chat can send as
    // nobody then as a named persona. An attended chat sends no `actsAs` at all.
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
                // Interim snapshot (live output), then the terminal status: content replaces each time.
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

        // One bubble per prose block, carrying the tools that ran after it, so cards sit inline instead of all hoisted
        // above one paragraph.
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

    // A steer absorbed mid-turn produces no `usage` boundary; the model just keeps writing, so the reply opens a new
    // bubble below the steer rather than continuing the one above.
    it(`steers mid-turn: the message lands where the turn took it and the answer opens below it`, async () => {
        const conversation = new Conversation(`c1`);
        const run = liveRun({ prompt: `2+3?` });
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({
            start(c) {
                controller = c;
                controller.enqueue(sseFrame(run.head()));
            },
        });
        sandboxRequestMock.mockImplementation((path: string) => {
            if (path === `/agent`) {
                return Promise.resolve({ ok: true, json: () => Promise.resolve({ run: `r1` }) } as Response);
            }
            return Promise.resolve(path === `/agent/attach` ? ({ ok: true, body } as Response) : ({ ok: true } as Response));
        });
        const emit = (event: AgentEvent): void => {
            for (const frame of run.frames(event)) {
                controller.enqueue(sseFrame(frame));
            }
        };

        const turn = conversation.send(`2+3?`, settings);
        emit({ kind: `delta`, text: `5` });
        await vi.waitFor(() => expect(conversation.messages.value[1]?.text).toBe(`5`));

        await conversation.enqueue(`2+6?`);
        // The daemon took it, so it left the queue, and the run's own frame is what draws it.
        expect(conversation.queued.value).toHaveLength(0);
        emit({ kind: `steer`, text: `2+6?`, sentAt: 1_767_225_600_000 });
        await vi.waitFor(() => expect(conversation.messages.value).toHaveLength(3));

        // Absorbed mid-turn: no usage boundary, so the model's words open a new bubble below.
        emit({ kind: `delta`, text: `8` });
        await vi.waitFor(() => expect(conversation.messages.value[3]?.text).toBe(`8`));
        emit({ kind: `usage`, costUsd: 0.1 });
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
        // The daemon's stamp, not this window's clock: the bubble must not jump when the record replaces it.
        expect(conversation.messages.value[2]!.sentAt).toBe(1_767_225_600_000);
    });

    it(`draws a steer that another window sent, off the run's own frames`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(
            sseResponse([
                { kind: `delta`, text: `looking` },
                { kind: `steer`, text: `check the tests too`, sentAt: 1_767_225_600_000 },
                { kind: `delta`, text: `will do` },
                { kind: `done` },
            ]),
        );

        await conversation.send(`have a look`, settings);

        expect(conversation.messages.value.map(({ role, text }) => ({ role, text }))).toEqual([
            { role: `user`, text: `have a look` },
            { role: `assistant`, text: `looking` },
            { role: `user`, text: `check the tests too` },
            { role: `assistant`, text: `will do` },
        ]);
        // Nothing was typed here, so nothing was queued here either.
        expect(conversation.queued.value).toHaveLength(0);
    });

    it(`sends a steered message's attachments and editor context with it, so a mid-turn file isn't a lesser message`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(
            sseResponse(
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

        const turn = conversation.send(`start`, settings);
        await vi.waitFor(() => expect(conversation.streaming.value).toBe(true));
        await conversation.enqueue(`look at this`, [{ name: `shot.png`, path: `.intentic/records/artifacts/attachments/u1/shot.png` }], {
            file: `src/app.ts`,
        });

        const steer = sandboxRequestMock.mock.calls.find(([path]) => path === `/agent/steer`);
        expect(JSON.parse(steer![1]!.body as string)).toMatchObject({
            text: `look at this`,
            attachments: [`.intentic/records/artifacts/attachments/u1/shot.png`],
            editorContext: { file: `src/app.ts` },
        });
        // The bubble carries the attachments too; the chip is named from the path the frame carries, as a restored one
        // is.
        await vi.waitFor(() =>
            expect(conversation.messages.value.at(-1)).toMatchObject({
                role: `user`,
                text: `look at this`,
                attachments: [`.intentic/records/artifacts/attachments/u1/shot.png`],
            }),
        );

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
        // A native codex/grok/ACP turn has no steering queue, so the daemon answers 404; the message must survive and
        // go
        // out on its own.
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

        // The turn ends on its own: the queue goes out as the next turn.
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
        await conversation.enqueue(`also the tests`, [{ name: `spec.md`, path: `${STATE_DIR}/records/artifacts/attachments/u1/spec.md` }]);
        await conversation.enqueue(`and the docs`);
        controller.enqueue(sseFrame({ kind: `end` }));
        controller.close();
        await turn;

        // Two thoughts about the same work are one request, not a turn each.
        await vi.waitFor(() => expect(turnBodies()).toHaveLength(2));
        expect(turnBodies()[1]).toMatchObject({
            prompt: `also the tests\n\nand the docs`,
            attachments: [`.intentic/records/artifacts/attachments/u1/spec.md`],
        });
    });

    it(`holds the queue when the user stops the turn, then sends it with their next message`, async () => {
        const conversation = new Conversation(`c1`);
        const followUp = sseResponse([{ kind: `done` }]);
        const parked = sseResponse([{ kind: `delta`, text: `working` }], { stayOpen: true });
        // One fake per turn: a stop must reach the run it's stopping, since the daemon ending that run's stream is what
        // the window waits for.
        let turns = 0;
        sandboxRequestMock.mockImplementation((path: string, init?: RequestInit) => {
            if (path === `/agent/steer`) {
                return Promise.resolve({ ok: false, status: 404 } as Response);
            }
            if (path === `/agent`) {
                turns += 1;
            }
            return turns <= 1 ? parked(path, init) : followUp(path, init);
        });

        const turn = conversation.send(`start`, settings);
        await vi.waitFor(() => expect(conversation.streaming.value).toBe(true));
        await conversation.enqueue(`and the docs`);
        conversation.stop();
        await turn;

        // Stopping the agent is not a request for another turn: the message waits where the user can see it.
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
            if (path === `/agent/stop`) {
                // The stop's two halves held apart: the daemon cancels the run (ending the attach) at once, but only
                // confirms
                // /agent/stop when released.
                void parked(path, init);
                return stopped;
            }
            const serving = attaches === 0 ? parked : completed;
            if (path === `/agent/attach`) {
                attaches += 1;
            }
            return serving(path, init);
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

        const turn = conversation.send(`make a plan`, settings);
        await vi.waitFor(() => expect(conversation.awaitingDecision.value).toBe(true));

        const [, planMessage] = conversation.messages.value;
        expect(planMessage).toMatchObject({ text: `intro`, plan: { requestId: `d1`, text: `the plan`, status: `pending` } });

        await conversation.decidePlan(planMessage!, true);
        expect(sandboxRequestMock).toHaveBeenLastCalledWith(`/agent/reply`, expect.objectContaining({ method: `POST` }));
        await turn;

        // The verdict is the daemon's own line; what comes next opens a fresh bubble rather than typing into the
        // card's.
        expect(conversation.messages.value.slice(1).map(({ role, text }) => ({ role, text }))).toEqual([
            { role: `assistant`, text: `intro` },
            { role: `notice`, text: `Plan approved.` },
            { role: `assistant`, text: `after approval` },
        ]);
        expect(conversation.messages.value[1]?.plan).toMatchObject({ status: `approved` });
        expect(conversation.awaitingDecision.value).toBe(false);
    });

    // Files staged against a plan card travel as `@`-paths in the reply's single text field, same as against a
    // message.
    it(`sends a plan rejection's staged files as @-paths and keeps them on the feedback bubble`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `plan`, requestId: `d1`, text: `the plan` }]));
        const turn = conversation.send(`make a plan`, settings);
        await vi.waitFor(() => expect(conversation.awaitingDecision.value).toBe(true));
        const planMessage = conversation.messages.value.find((message) => message.plan !== undefined);

        await conversation.decidePlan(planMessage!, false, `this bit is wrong`, [
            { name: `shot.png`, path: `${STATE_DIR}/records/artifacts/attachments/a1/shot.png` },
        ]);

        const [, body] = sandboxRequestMock.mock.calls.at(-1) as [string, RequestInit];
        expect(JSON.parse(String(body.body))).toMatchObject({
            kind: `plan`,
            approve: false,
            feedback: `this bit is wrong\n@.intentic/records/artifacts/attachments/a1/shot.png`,
        });
        await turn;
        // The feedback is the daemon's row: the user's words as sent, with the upload's chip on them.
        expect(conversation.messages.value.at(-1)).toMatchObject({
            role: `user`,
            text: `this bit is wrong\n@.intentic/records/artifacts/attachments/a1/shot.png`,
            attachments: [`.intentic/records/artifacts/attachments/a1/shot.png`],
        });
    });

    // A screenshot with nothing typed is a whole answer on its own.
    it(`sends an attachment-only plan rejection`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `plan`, requestId: `d1`, text: `the plan` }]));
        const turn = conversation.send(`make a plan`, settings);
        await vi.waitFor(() => expect(conversation.awaitingDecision.value).toBe(true));
        const planMessage = conversation.messages.value.find((message) => message.plan !== undefined);

        await conversation.decidePlan(planMessage!, false, ``, [
            { name: `shot.png`, path: `${STATE_DIR}/records/artifacts/attachments/a1/shot.png` },
        ]);

        const [, body] = sandboxRequestMock.mock.calls.at(-1) as [string, RequestInit];
        expect(JSON.parse(String(body.body))).toMatchObject({ feedback: `@.intentic/records/artifacts/attachments/a1/shot.png` });
        await turn;
        expect(conversation.messages.value.at(-1)).toMatchObject({
            role: `user`,
            text: `@.intentic/records/artifacts/attachments/a1/shot.png`,
            attachments: [`.intentic/records/artifacts/attachments/a1/shot.png`],
        });
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

        // The composer follows the running turn, but the pick for the next turn is untouched; an agent entering plan
        // mode
        // must not cost the user their permissions.
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

        const turn = conversation.send(`ask me`, settings);
        await vi.waitFor(() => expect(conversation.awaitingDecision.value).toBe(true));

        const questionMessage = conversation.messages.value[1]!;
        expect(questionMessage.question).toMatchObject({ requestId: `q1`, status: `pending` });

        await conversation.answerQuestion(questionMessage, { "Which?": [`A`] });
        expect(sandboxRequestMock).toHaveBeenLastCalledWith(`/agent/reply`, expect.objectContaining({ method: `POST` }));
        await turn;
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
        // One request does both halves: the daemon ends the turn where the dismissal lands, with no separate stop
        // behind
        // it.
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
        // An allow is the turn carrying on with the user's blessing: nothing to stop.
        await conversation.decidePermission(cards()[0]!, `once`);
        expect(conversation.streaming.value).toBe(true);
        expect(sandboxRequestMock.mock.calls.map(([path]) => path)).not.toContain(`/agent/stop`);

        // The turn was parked on the first card and only asks the second once that answer un-parks it.
        await vi.waitFor(() => expect(cards()).toHaveLength(2));
        await conversation.decidePermission(cards()[1]!, `deny`);
        await turn;

        expect(sandboxRequestMock.mock.calls.map(([path]) => path)).toContain(`/agent/stop`);
        expect(cards().map((card) => card.permission!.status)).toEqual([`allowed`, `denied`]);
        expect(conversation.streaming.value).toBe(false);
        expect(conversation.messages.value.at(-1)).toMatchObject({ role: `notice`, text: `Stopped.` });
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
        const stream = sseResponse([{ kind: `permission`, requestId: `p1`, toolName: `Bash` }], { stayOpen: true });
        sandboxRequestMock.mockImplementation(async (path, init) => {
            if (path === `/agent/reply`) {
                await inFlight;
                return { ok: true } as Response;
            }
            return stream(path, init);
        });

        const turn = conversation.send(`run it`, settings);
        await vi.waitFor(() => expect(conversation.awaitingDecision.value).toBe(true));
        const card = conversation.messages.value.find((message) => message.permission !== undefined)!;

        const allow = conversation.decidePermission(card, `once`);
        // Not awaited between the two: the first reply has not come back yet.
        const deny = conversation.decidePermission(card, `deny`);
        release();
        await Promise.all([allow, deny]);

        const replies = sandboxRequestMock.mock.calls.filter(([path]) => path === `/agent/reply`);
        expect(replies).toHaveLength(1);
        expect(conversation.error.value).toBeNull();
        // The card reads as the first press said (allow); the turn carries on.
        expect(conversation.messages.value.find((message) => message.permission !== undefined)?.permission?.status).toBe(`allowed`);

        conversation.stop();
        await turn;
    });

    // The press-lock guard covers only the window a reply is in flight for, not a card's whole life.
    it(`lets a fresh card be answered after the one before it has landed`, async () => {
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
        const cards = (): ChatMessage[] => conversation.messages.value.filter((message) => message.permission !== undefined);

        await conversation.decidePermission(cards()[0]!, `once`);
        // The second card is the turn carrying on past the first answer, so it only exists once that one landed.
        await vi.waitFor(() => expect(cards()).toHaveLength(2));
        await conversation.decidePermission(cards()[1]!, `once`);

        expect(sandboxRequestMock.mock.calls.filter(([path]) => path === `/agent/reply`)).toHaveLength(2);
        expect(cards().map((card) => card.permission!.status)).toEqual([`allowed`, `allowed`]);

        conversation.stop();
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
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `credential_offer`, requestId: `c1`, offer }], { stayOpen: true }));

        const turn = conversation.send(`migrate the db`, settings);
        await vi.waitFor(() => expect(conversation.awaitingDecision.value).toBe(true));

        const card = (): ChatMessage => conversation.messages.value.find((message) => message.credentialOffer !== undefined)!;
        expect(card().credentialOffer).toMatchObject({ requestId: `c1`, status: `pending`, offer: { approvers: [`bob@corp.com`] } });

        await conversation.decideCredentialOffer(card(), true);
        expect(sandboxRequestMock).toHaveBeenLastCalledWith(`/agent/reply`, expect.objectContaining({ method: `POST` }));
        expect(card().credentialOffer).toMatchObject({ status: `approved` });
        // Releasing is not an ending: the exit the turn was parked on carries on.
        expect(conversation.streaming.value).toBe(true);
        await conversation.stop();
        await turn;
    });

    it(`a replayed release card freezes from the resolved frame and wears the approver's name`, async () => {
        const conversation = new Conversation(`c1`);
        const offer = { subject: `reddit`, kind: `capability` as const, lane: `session` as const, approvers: [`bob@corp.com`], scope: `conversation` as const };
        sandboxRequestMock.mockImplementation(
            sseResponse([
                { kind: `credential_offer`, requestId: `c1`, offer },
                { kind: `resolved`, requestId: `c1`, reply: { kind: `credential_offer`, requestId: `c1`, approve: true } },
                { kind: `credential_receipt`, requestId: `c1`, outcome: `released`, approvedBy: `bob@corp.com` },
            ]),
        );

        await conversation.send(`post it`, settings);

        const card = conversation.messages.value.find((message) => message.credentialOffer !== undefined)!;
        expect(card.credentialOffer).toMatchObject({ status: `approved`, receipt: { outcome: `released`, approvedBy: `bob@corp.com` } });
    });

    // Connect does not predict the outcome: the card moves to `connecting` and a capability_outcome frame says how it
    // ended. "Not now" leaves the turn running; both travel the same /agent/reply channel.
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

    it(`surfaces daemon error facts and ignores unfamiliar frames`, async () => {
        const conversation = new Conversation(`c1`);
        const run = liveRun();
        sandboxRequestMock.mockImplementation((path: string) => {
            if (path !== `/agent/attach`) {
                return Promise.resolve({ ok: true, json: () => Promise.resolve({ run: `r1` }) } as Response);
            }
            const frames = [
                run.head(),
                { kind: `future-thing`, seq: 1, payload: 1 },
                ...run.frames({ kind: `error`, message: `boom` }),
                { kind: `end` },
            ];
            return Promise.resolve({ ok: true, body: chunkStream(frames, `close`) } as Response);
        });

        await conversation.send(`hi`, settings);

        expect(conversation.error.value).toBe(`boom`);
        expect(conversation.status.value).toBe(`error`);
        // The unknown frame left no trace: the user's row and the daemon's line about the failure.
        expect(conversation.messages.value.map((message) => message.role)).toEqual([`user`, `notice`]);
    });

    // An uncoded failure names nothing to fix, so continuing is simply the rest of the work. A named code means
    // something needs fixing first, so no continue offer rides under it.
    it(`offers to continue after a failure nobody can act on, and never after one that names a fix`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `error`, message: `agent did not complete (error_during_execution)` }]));
        await conversation.send(`ship the parser`, settings);
        expect(conversation.pickUp.value).toEqual({ reason: `stopped` });

        // The offer stands down at the start of the next turn, not its end, so it can't be pressed twice into two
        // turns.
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `delta`, text: `carrying on` }, { kind: `done` }]));
        await conversation.send(CONTINUATIONS.plain, settings);
        expect(conversation.pickUp.value).toBeUndefined();

        for (const code of [`subscription-required`, `agent-busy`, `claude-not-entitled`] as const) {
            sandboxRequestMock.mockImplementation(sseResponse([{ kind: `error`, code, message: `nope` }]));
            await conversation.send(`again`, settings);
            expect(conversation.error.value, code).toBe(`nope`);
            expect(conversation.pickUp.value, code).toBeUndefined();
        }
    });

    it(`continues itself after a turn that stopped short, once its wait is up`, async () => {
        vi.useFakeTimers();
        try {
            const conversation = new Conversation(`c1`);
            conversation.setAutoContinue(true);
            sandboxRequestMock.mockImplementation(sseResponse([{ kind: `error`, message: `agent did not complete` }]));
            await conversation.send(`ship the parser`, settings);

            // Scheduled, not sent immediately: the wait gives a person a chance to intervene.
            expect(conversation.pickUp.value).toEqual({ reason: `stopped` });
            expect(conversation.autoContinueAt.value).toBeGreaterThan(Date.now());
            expect(turnBodies()).toHaveLength(1);

            sandboxRequestMock.mockImplementation(sseResponse([{ kind: `delta`, text: `carrying on` }, { kind: `done` }]));
            await vi.advanceTimersByTimeAsync(6_000);

            expect(turnBodies().map((body) => body[`prompt`])).toEqual([`ship the parser`, CONTINUATIONS.plain]);
            expect(conversation.autoContinueAt.value).toBeUndefined();
            expect(conversation.pickUp.value).toBeUndefined();
        } finally {
            vi.useRealTimers();
        }
    });

    // Arming auto-continue in front of an already-stopped turn takes that stop too, rather than waiting for the next
    // one.
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

    // A user Stop must never be auto-continued: it is the opposite of what they asked. Waits for the agent's own
    // text, not `streaming` (true before the daemon has even taken the turn).
    it(`stays out of the way of a turn the user stopped`, async () => {
        vi.useFakeTimers();
        try {
            const conversation = new Conversation(`c1`);
            conversation.setAutoContinue(true);
            sandboxRequestMock.mockImplementation(sseResponse([{ kind: `delta`, text: `working` }], { stayOpen: true }));
            const turn = conversation.send(`ship the parser`, settings);
            await vi.waitFor(() => expect(conversation.messages.value.some((message) => message.text === `working`)).toBe(true));
            await conversation.stop();
            await turn;

            expect(conversation.pickUp.value).toEqual({ reason: `stopped` });
            expect(conversation.autoContinueAt.value).toBeUndefined();
            await vi.advanceTimersByTimeAsync(60_000);
            expect(turnBodies()).toHaveLength(1);
        } finally {
            vi.useRealTimers();
        }
    });

    // Turns that die in seconds mean something is actually wrong; retrying unattended forever would make that
    // expensive, so each wait grows and it gives up after three, saying why.
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

            // The fourth stop is declined: auto-continue turns itself off and says so.
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

    // A turn that ran long enough to get somewhere resets the backoff ladder, rather than growing the wait
    // indefinitely.
    it(`resets the backoff after a turn that got somewhere`, async () => {
        vi.useFakeTimers();
        try {
            const conversation = new Conversation(`c1`);
            conversation.setAutoContinue(true);
            const instant = sseResponse([{ kind: `error`, message: `agent did not complete` }]);
            sandboxRequestMock.mockImplementation(instant);
            await conversation.send(`ship the parser`, settings);
            // Advances exactly the scheduled wait, so the next delay is read precisely rather than
            // delay-minus-overshoot.
            await vi.advanceTimersByTimeAsync(5_000);
            // The second stop is on the ladder's second rung, having bought nothing.
            expect(conversation.autoContinueAt.value! - Date.now()).toBe(15_000);

            // Moves the clock inside the request to simulate a turn that worked a while before stopping, the one seam a
            // canned stream has for duration.
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

    // A bare "continue" after a denied tool reads as "run it anyway", so the continuation must name the refusal. It
    // must also fold into the turn, so pressing it matches typing the words.
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

        expect(conversation.pickUp.value).toEqual({ reason: `stopped` });
        const text = continuationFor(conversation.messages.value);
        expect(text).toBe(CONTINUATIONS.afterDenial);
        // Allowing the same tool instead leaves the ordinary sentence: there is no refusal to carry on without.
        expect(continuationFor([{ id: 1, role: `user`, text: `hi`, permission: { requestId: `p1`, toolName: `Bash`, status: `allowed` } }])).toBe(
            CONTINUATIONS.plain,
        );

        // Both continuation sentences fold into the turn, so the prompt defining the work keeps the pin.
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

        // The daemon reseeds a lost session itself when it can; this path fires only for the one runtime whose sessions
        // it can't see.
        sandboxRequestMock.mockImplementation(
            sseResponse([
                { kind: `error`, code: `session-not-found`, message: `The agent restarted and cannot resume this chat's session.` },
                { kind: `done` },
            ]),
        );
        await conversation.send(`second`, settings);

        expect(conversation.session.value).toBeUndefined();
        // Shows the runtime's own sentence rather than guessing a cause it cannot know.
        expect(conversation.messages.value.at(-1)).toMatchObject({
            role: `notice`,
            text: `The agent restarted and cannot resume this chat's session.`,
        });
        expect(conversation.error.value).toBeNull();
        expect(conversation.status.value).not.toBe(`error`);

        // The next send carries no dead session id; the daemon reseeds the replacement from its own record of this
        // conversation.
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
        // Reaches the client only when the daemon's in-turn self-heal failed too: xAI rejected the model and named no
        // alternative.
        const xaiMessage = `xAI returned no available models for your account.`;
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `error`, code: `grok-model-invalid`, message: xaiMessage }, { kind: `done` }]));
        await conversation.send(`hi`, { ...settings, agent: `grok`, model: `grok-code-fast-1` });
        // The catalog reload is a fire-and-forget dynamic import; let its microtasks drain before asserting it.
        await new Promise((resolve) => setTimeout(resolve, 0));

        // The daemon's message surfaces both as the error ref and as a transcript notice; the catalog reload refreshes
        // the picker.
        expect(conversation.error.value).toBe(xaiMessage);
        expect(conversation.messages.value.at(-1)).toMatchObject({ role: `notice`, text: xaiMessage });
        expect(loadProviderModelsMock).toHaveBeenCalledWith(`grok`);
    });

    it(`surfaces a codex-model-invalid error and reloads the Codex catalog`, async () => {
        loadProviderModelsMock.mockClear();
        const conversation = new Conversation(`c1`);
        conversation.provider.value = `codex`;
        conversation.model.value = `gpt-5-codex`;
        // Codex has no in-turn self-heal, so the rejection always lands here; the reload repoints the picker to the
        // daemon's live default.
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

    // A model the subscription plan doesn't cover, not a bad name or a dead provider; the daemon drops it from the
    // catalog. The words are held since the endpoint refused before any token was spent.
    it(`holds the message and reloads the catalog when the plan does not cover the model`, async () => {
        loadProviderModelsMock.mockClear();
        const conversation = new Conversation(`c1`);
        conversation.provider.value = `kimi`;
        conversation.model.value = `kimi-k2.7-code-highspeed`;
        const refusal = `Your current subscription does not have access to kimi-for-coding-highspeed. Upgrade to higher-tier Kimi Code plans.`;
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `error`, code: `model-unavailable`, message: refusal }, { kind: `done` }]));
        await conversation.send(`hi`, { ...settings, agent: `kimi`, model: `kimi-k2.7-code-highspeed` });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(conversation.error.value).toContain(`does not have access`);
        expect(loadProviderModelsMock).toHaveBeenCalledWith(`kimi`);
        // The prompt returns to the queue rather than sitting unanswered in the transcript, as any refusal that ran
        // nothing does.
        expect(conversation.queued.value.map((message) => message.text)).toEqual([`hi`]);
        expect(conversation.messages.value.some((message) => message.role === `user`)).toBe(false);
    });

    it(`renders a codex-advisory as a muted notice under the answer the turn actually produced`, async () => {
        const conversation = new Conversation(`c1`);
        conversation.provider.value = `codex`;
        // Codex warns when its CLI has no metadata for a model the subscription serves, then runs the turn anyway; this
        // is not a failure.
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
        // The turn's own answer still arrives: the advisory annotates it rather than replacing it.
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

    // A spent allowance names its reset instant and leaves the turn pickable from it; nothing re-runs automatically
    // even if the daemon sends an `autoResume` verdict.
    it(`names the reset instant on a usage limit, and leaves the turn pickable from it`, async () => {
        const conversation = new Conversation(`c1`);
        const resetsAt = Math.floor(Date.now() / 1000) + 3_600;
        sandboxRequestMock.mockImplementation(
            sseResponse([
                // `available`: the daemon would fire the held turn at reset, but this conversation hasn't armed that;
                // this is the
                // default.
                { kind: `error`, code: `rate_limit`, message: `Claude usage limit reached.`, resetsAt, autoResume: `available` },
                { kind: `done` },
            ]),
        );
        await conversation.send(`hello`, settings);

        const notice = conversation.messages.value.at(-1)!;
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

    // Once armed, the daemon fires the held turn at the published reset hour, and the chat must say so instead of
    // still offering a press. `automatic` marks it, same as an armed outage, and keeps local auto-continue's hands off.
    it(`reports a scheduled send when the conversation is armed for the reset`, async () => {
        const conversation = new Conversation(`c1`);
        const resetsAt = Math.floor(Date.now() / 1000) + 3_600;
        sandboxRequestMock.mockImplementation(
            sseResponse([
                {
                    kind: `error`,
                    code: `rate_limit`,
                    message: `Claude usage limit reached.`,
                    resetsAt,
                    autoResume: `scheduled`,
                    held: { ran: false },
                },
                { kind: `done` },
            ]),
        );
        await conversation.send(`hello`, settings);

        expect(conversation.pickUp.value).toEqual({
            reason: `limit`,
            readyAt: resetsAt * 1_000,
            held: { ran: false },
            automatic: { at: resetsAt * 1_000 },
        });
        // Still a notice rather than the red line: an armed wait is the least alarming state this failure has.
        expect(conversation.error.value).toBeNull();
        expect(conversation.messages.value.at(-1)!.text).toContain(`sends it again`);
    });

    // An allowance the daemon can't date still offers the press immediately: there's nothing to wait for and the
    // provider's own sentence already says to retry. A guessed countdown would be worse than none.
    it(`offers an undated usage limit straight away`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(
            sseResponse([{ kind: `error`, code: `rate_limit`, message: `Kimi usage limit reached.` }, { kind: `done` }]),
        );
        await conversation.send(`hello`, settings);

        expect(conversation.pickUp.value).toEqual({ reason: `limit` });
    });

    it(`re-runs the held turn on a press instead of appending anything to the chat`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(
            sseResponse([{ kind: `error`, code: `rate_limit`, message: `Claude usage limit reached.`, held: { ran: false } }, { kind: `done` }]),
        );
        await conversation.send(`ship the parser`, settings);

        expect(conversation.pickUp.value).toEqual({ reason: `limit`, held: { ran: false } });

        // The re-run's own run: the same words, behind a note explaining why they're back.
        sandboxRequestMock.mockImplementation(
            sseResponse([{ kind: `delta`, text: `on it` }, { kind: `done` }], {
                head: () => ({ prompt: withResumeNote(`ship the parser`, RESUME_NOTES.refused), startedAt: Date.now() }),
            }),
        );
        // Undefined: nothing was said, so there is nothing for the composer's recall ring to take.
        await expect(conversation.continueTurn()).resolves.toBeUndefined();

        expect(sandboxRequestMock.mock.calls.map(([path]) => path)).toContain(`/agent/resume`);
        // No second turn started: /agent is what saying something costs, and nothing was said.
        expect(turnBodies()).toHaveLength(1);
        // One user row, still their own words: the note came off and the bubble was reused, not repeated.
        expect(conversation.messages.value.filter((message) => message.role === `user`)).toMatchObject([{ text: `ship the parser` }]);
        expect(conversation.messages.value.at(-1)).toMatchObject({ role: `assistant`, text: `on it` });
    });

    it(`keeps one user row through four presses against an allowance that keeps refusing`, async () => {
        const conversation = new Conversation(`c1`);
        const refuse = (prompt?: string): ReturnType<typeof sseResponse> =>
            sseResponse([{ kind: `error`, code: `rate_limit`, message: `Claude usage limit reached.`, held: { ran: false } }, { kind: `done` }], {
                head: () => ({ startedAt: Date.now(), ...(prompt === undefined ? {} : { prompt }) }),
            });
        sandboxRequestMock.mockImplementation(refuse());
        await conversation.send(`ship the parser`, settings);

        sandboxRequestMock.mockImplementation(refuse(withResumeNote(`ship the parser`, RESUME_NOTES.refused)));
        for (let press = 0; press < 4; press += 1) {
            await conversation.continueTurn();
        }

        expect(turnBodies()).toHaveLength(1);
        expect(conversation.messages.value.filter((message) => message.role === `user`)).toMatchObject([{ text: `ship the parser` }]);
        // Still offering the press, because the turn is still held: a re-run refused is a re-run to make again.
        expect(conversation.pickUp.value).toEqual({ reason: `limit`, held: { ran: false } });
    });

    // If the daemon isn't actually holding the turn (a restart between refusal and press), the press must not become
    // dead: it falls back to sending an ordinary "carry on" turn.
    it(`falls back to saying carry on when the held turn has gone`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(
            sseResponse([{ kind: `error`, code: `rate_limit`, message: `Claude usage limit reached.`, held: { ran: true } }, { kind: `done` }]),
        );
        await conversation.send(`ship the parser`, settings);

        const refusedResume = sseResponse([{ kind: `delta`, text: `carrying on` }, { kind: `done` }]);
        sandboxRequestMock.mockImplementation((path, init) =>
            path === `/agent/resume`
                ? Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ message: `no held turn` }) } as Response)
                : refusedResume(path, init),
        );
        await expect(conversation.continueTurn()).resolves.toBe(CONTINUATIONS.plain);

        expect(turnBodies().map((body) => body[`prompt`])).toEqual([`ship the parser`, CONTINUATIONS.plain]);
    });

    // A held re-run uses the composer's current account selection, not the account that got refused, since a spent
    // allowance is one account's problem and the switcher is how the user moves off it.
    it(`re-runs the held turn on the account the composer has switched to`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(
            sseResponse([
                { kind: `session`, sessionId: `s-1` },
                { kind: `error`, code: `rate_limit`, message: `Claude usage limit reached.`, held: { ran: true } },
                { kind: `done` },
            ]),
        );
        await conversation.send(`ship the parser`, settings);
        expect(conversation.session.value).toMatchObject({ id: `s-1` });

        conversation.selectAccount(`with-room`);
        sandboxRequestMock.mockImplementation(
            sseResponse([{ kind: `delta`, text: `on it` }, { kind: `done` }], {
                head: () => ({ prompt: withResumeNote(`ship the parser`, RESUME_NOTES.switched), startedAt: Date.now() }),
            }),
        );
        await expect(conversation.continueTurn()).resolves.toBeUndefined();

        const press = sandboxRequestMock.mock.calls.find(([path]) => path === `/agent/resume`)!;
        expect(JSON.parse(press[1]!.body as string)).toEqual({
            conversationId: `c1`,
            routing: { agent: `claude`, harness: `native`, account: `with-room`, model: `opus` },
        });
        // A session belongs to the credential that minted it; switching accounts drops it so the daemon can seed a
        // fresh
        // one.
        expect(conversation.session.value).toBeUndefined();
        // Still one turn and one user row: a press is the same request again, not a new message.
        expect(turnBodies()).toHaveLength(1);
        expect(conversation.messages.value.filter((message) => message.role === `user`)).toMatchObject([{ text: `ship the parser` }]);
        expect(conversation.messages.value.at(-1)).toMatchObject({ role: `assistant`, text: `on it` });
    });

    // An interval ladder alone fails here: every rung before the quota reopens is a guaranteed miss. The named reset
    // instant is a floor under the wait, so an armed chat sleeps through it.
    it(`waits for the reset before continuing itself through a spent allowance`, async () => {
        vi.useFakeTimers();
        try {
            const conversation = new Conversation(`c1`);
            conversation.setAutoContinue(true);
            const resetsAt = Math.floor(Date.now() / 1000) + 3_600;
            sandboxRequestMock.mockImplementation(
                sseResponse([{ kind: `error`, code: `rate_limit`, message: `Claude usage limit reached.`, resetsAt }, { kind: `done` }]),
            );
            await conversation.send(`ship the parser`, settings);

            // Scheduled for the reset, not for the front of the ladder.
            expect(conversation.autoContinueAt.value).toBe(resetsAt * 1_000);
            sandboxRequestMock.mockImplementation(sseResponse([{ kind: `delta`, text: `carrying on` }, { kind: `done` }]));
            // A rung's worth of waiting buys nothing: the allowance is what the chat is waiting on.
            await vi.advanceTimersByTimeAsync(60_000);
            expect(turnBodies()).toHaveLength(1);

            await vi.advanceTimersByTimeAsync(3_600_000);
            expect(turnBodies().map((body) => body[`prompt`])).toEqual([`ship the parser`, CONTINUATIONS.plain]);
        } finally {
            vi.useRealTimers();
        }
    });

    // An unknown reset backs off by rung count regardless of how long each refusal takes, growing to a one-day
    // ceiling instead of resetting on wall time or retrying forever.
    it(`backs an unknown usage reset off from seconds to a daily probe even when every refusal is slow`, async () => {
        vi.useFakeTimers();
        try {
            const conversation = new Conversation(`c1`);
            conversation.setAutoContinue(true);
            const refused = { kind: `error`, code: `rate_limit`, message: `Provider usage limit reached.` } as const;
            sandboxRequestMock.mockImplementation(
                sseResponse([refused, { kind: `done` }], {
                    // Slow refusal, not progress.
                    head: () => ({ startedAt: Date.now() - 60_000 }),
                }),
            );

            const waits: number[] = [];
            for (let attempt = 0; attempt < 10; attempt += 1) {
                await conversation.send(attempt === 0 ? `ship the parser` : CONTINUATIONS.plain, settings);
                waits.push(conversation.autoContinueAt.value! - Date.now());
            }

            expect(waits).toEqual([
                5_000,
                15_000,
                45_000,
                5 * 60_000,
                30 * 60_000,
                2 * 60 * 60_000,
                6 * 60 * 60_000,
                12 * 60 * 60_000,
                24 * 60 * 60_000,
                24 * 60 * 60_000,
            ]);
            expect(conversation.autoContinue.value).toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    // Unattended, appending "Continue" on each short rung would pile up messages; re-running the held turn instead
    // costs refused requests without touching the transcript.
    it(`re-runs the held turn when it continues itself, then moves beyond the short retry rungs`, async () => {
        vi.useFakeTimers();
        try {
            const conversation = new Conversation(`c1`);
            conversation.setAutoContinue(true);
            const refused = { kind: `error`, code: `rate_limit`, message: `Claude usage limit reached.`, held: { ran: false } } as const;
            sandboxRequestMock.mockImplementation(sseResponse([refused, { kind: `done` }]));
            await conversation.send(`ship the parser`, settings);

            sandboxRequestMock.mockImplementation(
                sseResponse([refused, { kind: `done` }], {
                    head: () => ({ prompt: withResumeNote(`ship the parser`, RESUME_NOTES.refused), startedAt: Date.now() }),
                }),
            );
            // The short end of the ladder: 5s, 15s, 45s, then the next retry is five minutes away.
            await vi.advanceTimersByTimeAsync(70_000);

            expect(sandboxRequestMock.mock.calls.filter(([path]) => path === `/agent/resume`)).toHaveLength(3);
            expect(turnBodies()).toHaveLength(1);
            expect(conversation.messages.value.filter((message) => message.role === `user`)).toMatchObject([{ text: `ship the parser` }]);
            expect(conversation.autoContinue.value).toBe(true);
            expect(conversation.autoContinueAt.value! - Date.now()).toBe(295_000);
        } finally {
            vi.useRealTimers();
        }
    });

    // A provider outage reads like a limit but isn't: no reset instant, an escalating wait, bounded tries. Renders as
    // a notice (the turn is coming back), with the wait naming an instant.
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

    // A rotated credential is re-minted and re-run by the daemon within a scheduler pass; the wait must be visible
    // and armed to catch the resumption, not just promised.
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
        // The notice names which wait it describes (`noticeWait`), and the conversation tracks that the wait is on.
        expect(notice.noticeWait).toBe(`credentialRenewal`);
        expect(conversation.failures.credentialRenewal.value).toEqual(expect.any(Object));
        expect(conversation.error.value).toBeNull();
        // Not a reauth: the account is fine, and lighting its badge would send the user to fix nothing.
        expect(providerAccounts.value[`claude`]?.some((account) => account.needsReauth === true)).not.toBe(true);
        conversation.abort();
    });

    // Attach streams are pull: a resumed run only reaches a window that goes looking for it. The wait above must arm
    // that reattach probe on its own.
    it(`goes looking for the resumed run and renders it, without the user doing anything`, async () => {
        vi.useFakeTimers();
        try {
            const conversation = new Conversation(`c1`);
            sandboxRequestMock.mockImplementation(
                sseResponse([{ kind: `error`, code: `claude-token-refused`, message: `401 revoked`, autoResume: `scheduled` }, { kind: `done` }]),
            );
            await conversation.send(`refactor the store`, settings);
            expect(conversation.failures.credentialRenewal.value).toEqual(expect.any(Object));

            // The resumed request runs behind the resume note, on its own run id; the renewal notice above stays since
            // it
            // belongs to the run that failed.
            sandboxRequestMock.mockImplementation(
                sseResponse([{ kind: `delta`, text: `Picking it back up.` }], {
                    head: () => ({ run: `r2`, prompt: withResumeNote(`refactor the store`, RESUME_NOTES.auth) }),
                }),
            );
            await vi.advanceTimersByTimeAsync(2_000);

            // The resumed answer lands under the original question once the wait ends.
            expect(conversation.failures.credentialRenewal.value).toBeUndefined();
            expect(conversation.messages.value.map(({ role, text }) => ({ role, text }))).toEqual([
                { role: `user`, text: `refactor the store` },
                { role: `notice`, text: expect.stringContaining(`being renewed`) },
                // The resumed run opens on the daemon's line for the restart, never on the words again.
                { role: `notice`, text: expect.stringContaining(`sign-in renewed`) },
                { role: `assistant`, text: `Picking it back up.` },
            ]);
        } finally {
            vi.useRealTimers();
        }
    });

    it(`stops the renewal spinner when the resumed turn lands`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(
            sseResponse([{ kind: `error`, code: `claude-token-refused`, message: `401 revoked`, autoResume: `scheduled` }, { kind: `done` }]),
        );
        await conversation.send(`hello`, settings);
        expect(conversation.failures.credentialRenewal.value).toEqual(expect.any(Object));

        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `delta`, text: `back` }, { kind: `done` }]));
        await conversation.send(`again`, settings);
        expect(conversation.failures.credentialRenewal.value).toBeUndefined();
    });

    // With nothing armed, the turn is not coming back on its own; a spinner here would promise something that isn't
    // happening.
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

        // The red line is honest here, and the typed words return to the queue rather than being lost.
        expect(conversation.error.value).toContain(`500`);
        expect(conversation.failures.outageResume.value).toBeUndefined();
        expect(conversation.queued.value.some((message) => message.text === `hello`)).toBe(true);
    });

    it(`holds and refunds a failed free-trial message without arming generic outage recovery`, async () => {
        const conversation = new Conversation(`c1`);
        conversation.provider.value = `endpoint/free-trial`;
        sandboxRequestMock.mockImplementation(
            sseResponse([
                { kind: `error`, code: `trial-unavailable`, message: `Free trial temporarily unavailable, failed messages aren't counted.` },
                { kind: `done` },
            ]),
        );

        await conversation.send(`hello`, { ...settings, agent: `endpoint/free-trial` });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(conversation.queued.value.map((message) => message.text)).toContain(`hello`);
        expect(conversation.messages.value.at(-1)?.role).toBe(`notice`);
        expect(conversation.error.value).toBeNull();
        expect(conversation.failures.outageResume.value).toBeUndefined();
        expect(loadTrialStatusMock).toHaveBeenCalledTimes(1);
    });

    // A refused turn returns its words to the queue, which flushes as one message; repeated presses must retry that
    // held message rather than stacking another copy in front of it.
    it(`retries the held nudge on a second Continue instead of stacking another copy of it`, async () => {
        const conversation = new Conversation(`c1`);
        conversation.provider.value = `endpoint/free-trial`;
        const trialSettings = { ...settings, agent: `endpoint/free-trial` } as const;
        let turns = 0;
        // Built once, not per call: a fake minted inside the mock implementation would miss the POST that started the
        // run
        // it serves.
        const refused = sseResponse([
            { kind: `error`, code: `trial-unavailable`, message: `Free trial temporarily unavailable, failed messages aren't counted.` },
            { kind: `done` },
        ]);
        const landed = sseResponse([{ kind: `delta`, text: `on it` }, { kind: `done` }]);
        sandboxRequestMock.mockImplementation((path: string, init?: RequestInit) => {
            if (path === `/agent`) {
                turns += 1;
            }
            return turns <= 2 ? refused(path, init) : landed(path, init);
        });

        await conversation.send(`Continue`, trialSettings);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(conversation.queued.value.map((message) => message.text)).toEqual([`Continue`]);

        // A repeat press retries the held message rather than adding a second one; the queue doesn't grow while it
        // keeps
        // bouncing.
        await conversation.enqueue(`Continue`);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(turnBodies()[1]).toMatchObject({ prompt: `Continue` });
        expect(conversation.queued.value.map((message) => message.text)).toEqual([`Continue`]);

        // A third press lands the turn, still on the one word.
        await conversation.enqueue(`Continue`);
        await vi.waitFor(() => expect(conversation.messages.value.at(-1)?.text).toBe(`on it`));
        expect(turnBodies()[2]).toMatchObject({ prompt: `Continue` });
        expect(conversation.messages.value.filter((message) => message.role === `user`)).toMatchObject([{ text: `Continue` }]);
    });

    // A press landing while the turn is failing meets the words coming back from the other side, since the flush
    // already emptied the queue by the time they return. Steering is refused here, so the two collide.
    it(`hands back a refused nudge as the one already pressed, not as a second copy in front of it`, async () => {
        const conversation = new Conversation(`c1`);
        const run = liveRun({ prompt: `Continue` });
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({
            start(c) {
                controller = c;
                c.enqueue(sseFrame(run.head()));
            },
        });
        sandboxRequestMock.mockImplementation((path: string) => {
            if (path === `/agent/attach`) {
                return Promise.resolve({ ok: true, body } as Response);
            }
            if (path === `/agent/steer`) {
                return Promise.resolve({ ok: false, status: 404 } as Response);
            }
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ run: `r1` }) } as Response);
        });

        const turn = conversation.send(`Continue`, settings);
        // Pressed again while it hangs: unsteerable, so it waits in the queue.
        await conversation.enqueue(`Continue`);
        expect(conversation.queued.value).toHaveLength(1);
        for (const frame of run.frames({ kind: `error`, code: `trial-unavailable`, message: `Free trial temporarily unavailable.` })) {
            controller.enqueue(sseFrame(frame));
        }
        controller.enqueue(sseFrame({ kind: `end` }));
        controller.close();
        await turn;
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(conversation.queued.value.map((message) => message.text)).toEqual([`Continue`]);
    });

    // A held message plus a follow-up nudge are two separate things said; the queue carries both.
    it(`keeps a nudge written behind a real message that never left`, async () => {
        const conversation = new Conversation(`c1`);
        let turns = 0;
        const refused = sseResponse([{ kind: `error`, code: `trial-unavailable`, message: `Free trial temporarily unavailable.` }, { kind: `done` }]);
        const landed = sseResponse([{ kind: `delta`, text: `on it` }, { kind: `done` }]);
        sandboxRequestMock.mockImplementation((path: string, init?: RequestInit) => {
            if (path === `/agent`) {
                turns += 1;
            }
            return turns <= 1 ? refused(path, init) : landed(path, init);
        });

        await conversation.send(`fix the tests`, settings);
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(conversation.queued.value.map((message) => message.text)).toEqual([`fix the tests`]);

        await conversation.enqueue(`go ahead`);
        await vi.waitFor(() => expect(conversation.messages.value.at(-1)?.text).toBe(`on it`));
        expect(turnBodies()[1]).toMatchObject({ prompt: `fix the tests\n\ngo ahead` });
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
        // Nothing is armed, so no opt-out is offered: there is nothing to opt out of yet.
        expect(conversation.messages.value.at(-1)!.noticeAction).toBeUndefined();

        // Arming this conversation arms the turn that bounced, daemon-side; the notice states the scope (this chat
        // only,
        // distinct from the sandbox-wide default).
        conversation.failures.armOutageResume();
        expect(conversation.failures.outageResume.value?.scheduled).toBe(true);
        expect(conversation.messages.value.at(-1)!.text).toContain(`Only this chat`);

        // Disarming stops the countdown, restores the offer (still re-armable), and stands the resume-hunting probe
        // down.
        const armed = conversation.messages.value.at(-1)!.text;
        conversation.failures.disarmOutageResume();
        expect(conversation.failures.outageResume.value?.scheduled).toBe(false);
        expect(conversation.messages.value.at(-1)!.text).not.toEqual(armed);
        expect(conversation.messages.value.at(-1)!.text).toContain(`no longer`);
        conversation.abort();
    });

    // The turn is alive here: a status, never a transcript line, and it must not outlive the turn it describes.
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
        usageByAccount.value = {};
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(
            sseResponse([
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
        await conversation.send(`hello`, settings);

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
        sandboxRequestMock.mockImplementation(
            sseResponse([{ kind: `account_usage`, windows: [{ kind: `seven_day`, utilization: 5, gates: `all` }] }, { kind: `done` }]),
        );
        await conversation.send(`hello`, settings);

        // An env-token turn has no account to key the snapshot by: better unknown than misattributed.
        expect(usageByAccount.value).toEqual({});
    });

    it(`does not let a rate_limit_info frame stand in for the account's headroom`, async () => {
        usageByAccount.value = {};
        const conversation = new Conversation(`c1`);
        // rate_limit_info names only the one window the provider treated as binding for that request; writing it into
        // the
        // headroom map would misattribute the account's overall usage.
        sandboxRequestMock.mockImplementation(
            sseResponse([
                { kind: `rate_limit_info`, account: `acct-1`, status: `allowed`, utilization: 1, rateLimitType: `seven_day` },
                { kind: `done` },
            ]),
        );
        await conversation.send(`hello`, settings);

        expect(usageByAccount.value).toEqual({});
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
        // Fed frame by frame, parking the stream on the first card like the daemon parks a turn, so several cards can
        // be
        // open when stop cancels them all through the run's own fold.
        const run = liveRun({ prompt: `go` });
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const body = new ReadableStream<Uint8Array>({
            start(c) {
                controller = c;
                c.enqueue(sseFrame(run.head()));
            },
        });
        sandboxRequestMock.mockImplementation((path: string) => {
            if (path === `/agent/attach`) {
                return Promise.resolve({ ok: true, body } as Response);
            }
            if (path === `/agent/stop`) {
                for (const frame of run.ending(`stopped`)) {
                    controller.enqueue(sseFrame(frame));
                }
                controller.enqueue(sseFrame({ kind: `end` }));
                controller.close();
                return Promise.resolve({ ok: true } as Response);
            }
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ run: `r1` }) } as Response);
        });

        const turn = conversation.send(`go`, settings);
        for (const event of [
            { kind: `plan`, requestId: `d1`, text: `the plan` },
            { kind: `question`, requestId: `q1`, questions },
            { kind: `permission`, requestId: `p1`, toolName: `Bash` },
        ] satisfies AgentEvent[]) {
            for (const frame of run.frames(event)) {
                controller.enqueue(sseFrame(frame));
            }
        }
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
        // A fork is a new conversation daemon-side (no session id rides); it sends where it was cut from (`forkOf`,
        // record row count), and the daemon copies that prefix before running. The bubbles themselves never go up.
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

    // `pendingForkOf` is the only record that this conversation is a fork until the daemon acks its first turn; it is
    // persisted in the tab snapshot and must survive a refused send rather than being spent.
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

        // Refused at the door: nothing ran daemon-side, so the linkage isn't spent; the words are held and the retry
        // still names the source.
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

    // A notice this window drew (a provider switch, a rewind) exists nowhere in the daemon's record; one the daemon
    // wrote (a refusal, a self-resume) is a record row like any other and must be counted.
    it(`a fork counts the notices the daemon recorded and skips the ones drawn locally`, async () => {
        const source = new Conversation(`c1`);
        source.restoreMessages([
            { role: `user`, text: `ship the parser` },
            { role: `assistant`, text: `on it` },
            { role: `notice`, text: `Failed to authenticate. API Error: 401.` },
            { role: `notice`, text: `Claude sign-in renewed, this turn picked up where it left off.` },
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

        // Branching before the notice leaves it behind: it belongs to the source's segment cut, not the fork.
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
        const run = liveRun();
        sandboxRequestMock.mockImplementation((path: string, init?: RequestInit) => {
            if (path === `/agent`) {
                return Promise.resolve({ ok: true, json: () => Promise.resolve({ run: `r1` }) } as Response);
            }
            attachBodies.push(JSON.parse(init!.body as string) as Record<string, unknown>);
            const body =
                attachBodies.length === 1
                    ? // Two patches, then the connection breaks mid-run (no `end`).
                      chunkStream(
                          [run.head(), ...run.frames({ kind: `delta`, text: `Hello ` }), ...run.frames({ kind: `delta`, text: `wor` })],
                          `error`,
                      )
                    : // The resumed attach's head carries the rows whole, and the stream carries on from there.
                      chunkStream([run.head(), ...run.frames({ kind: `delta`, text: `ld` }), { kind: `end` }], `close`);
            return Promise.resolve({ ok: true, body } as Response);
        });

        await conversation.send(`Hi`, settings);

        expect(attachBodies).toEqual([
            { conversationId: conversation.conversationId, run: `r1` },
            { conversationId: conversation.conversationId, run: `r1` },
        ]);
        expect(conversation.messages.value[1]).toMatchObject({ role: `assistant`, text: `Hello world` });
        expect(conversation.error.value).toBeNull();
    });

    it(`settles instead of misrendering when the resumed attach reports a different run`, async () => {
        const conversation = new Conversation(`c1`);
        let attaches = 0;
        const first = liveRun();
        const other = liveRun({ run: `r2`, prompt: `someone else's turn` });
        sandboxRequestMock.mockImplementation((path: string) => {
            if (path === `/agent`) {
                return Promise.resolve({ ok: true, json: () => Promise.resolve({ run: `r1` }) } as Response);
            }
            attaches += 1;
            const body =
                attaches === 1
                    ? chunkStream([first.head(), ...first.frames({ kind: `delta`, text: `partial` })], `error`)
                    : // A newer turn is live by the time the tab reconnects: its rows must not land here.
                      chunkStream([other.head(), ...other.frames({ kind: `delta`, text: `other` }), { kind: `end` }], `close`);
            return Promise.resolve({ ok: true, body } as Response);
        });

        await conversation.send(`Hi`, settings);

        expect(conversation.messages.value[1]).toMatchObject({ role: `assistant`, text: `partial` });
        expect(conversation.streaming.value).toBe(false);
    });

    it(`reattach renders a daemon-side run it never initiated: its rows from the head, its facts replayed`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation((path: string, init?: RequestInit) => {
            expect(path).toBe(`/agent/attach`);
            const request = JSON.parse(init!.body as string) as Record<string, unknown>;
            expect(request).toEqual({ conversationId: conversation.conversationId });
            const body = new ReadableStream<Uint8Array>({
                start(controller) {
                    const rows: TranscriptRow[] = [userRow(`refactor the parser`, 1234, []), { role: `assistant`, text: `On it.` }];
                    controller.enqueue(sseFrame(head({ startedAt: 1234, seq: 2, rows })));
                    // A fact is replayed to every attach of the run; its words are not, the head holds them.
                    controller.enqueue(sseFrame({ kind: `fact`, seq: 1, fact: { kind: `session`, sessionId: `s-9` } }));
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
        // The replayed fact armed the session exactly as it would have for the initiating window.
        expect(conversation.session.value).toMatchObject({ id: `s-9` });
        expect(conversation.streaming.value).toBe(false);
    });

    // A send's own bubble is the row the run's head later replaces, so re-attaching to a run this window started is
    // idempotent, the same as for one it merely found (transcriptState.attachRun).
    it(`redraws a run its own send opened when attached to it again, rather than stacking a second copy`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `delta`, text: `On it.` }, { kind: `done` }]));
        await conversation.send(`refactor the parser`, settings);
        const ids = conversation.messages.value.map((message) => message.id);

        // The same run served again, as a reload's reattach does.
        await expect(conversation.reattach()).resolves.toBe(true);

        expect(conversation.messages.value.map(({ role, text }) => ({ role, text }))).toEqual([
            { role: `user`, text: `refactor the parser` },
            { role: `assistant`, text: `On it.` },
        ]);
        // The same rows, under the same ids: nothing about them was redrawn from this window's point of view.
        expect(conversation.messages.value.map((message) => message.id)).toEqual(ids);
    });

    // The daemon settles a card's status on the row itself (card-status.ts), live and in the record alike, so a
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
        conversation.restoreMessages([
            { role: `user`, text: `choose` },
            { role: `assistant`, text: ``, question: { requestId: `q1`, questions, status: `answered`, answers: { "Which?": [`A`, `B`] } } },
            { role: `assistant`, text: `Here is the plan.`, plan: { requestId: `p1`, text: `1. do it`, status: `cancelled` } },
            { role: `assistant`, text: ``, permission: { requestId: `perm1`, toolName: `Bash`, explain: `Runs the tests.`, status: `always` } },
        ]);
        const [, asked, planned, permitted] = conversation.messages.value;
        expect(asked?.question).toEqual({ requestId: `q1`, questions, status: `answered`, answers: { "Which?": [`A`, `B`] } });
        expect(planned?.plan).toEqual({ requestId: `p1`, text: `1. do it`, status: `cancelled` });
        expect(permitted?.permission).toEqual({ requestId: `perm1`, toolName: `Bash`, explain: `Runs the tests.`, status: `always` });
        // A record row per bubble, cards included: the count a fork copies a prefix of agrees with the daemon's.
        expect(recordedRows(conversation.messages.value)).toBe(4);
    });

    it(`restoreMessages keeps the task checklist on an assistant bubble`, () => {
        const conversation = new Conversation(`c1`);
        const todos = [
            { content: `step 1`, status: `completed` as const },
            { content: `step 2`, status: `in_progress` as const, activeForm: `Running step 2` },
        ];
        conversation.restoreMessages([
            { role: `user`, text: `run tasks` },
            { role: `assistant`, text: `Working on it`, todos },
        ]);
        expect(conversation.messages.value[1]?.todos).toEqual(todos);
    });

    // Attaching to a live run must add to a transcript already restored, not replace it.
    it(`reattach adds the live turn to the history already on screen instead of replacing it`, async () => {
        const conversation = new Conversation(`c1`);
        conversation.restoreMessages([
            { role: `user`, text: `start the migration` },
            { role: `assistant`, text: `Done with step one.` },
        ]);
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `delta`, text: `Step two.` }], { head: () => ({ prompt: `Continue` }) }));

        await expect(conversation.reattach()).resolves.toBe(true);

        expect(conversation.messages.value.map(({ role, text }) => ({ role, text }))).toEqual([
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
        conversation.restoreMessages([
            { role: `user`, text: `Continue with the tests` },
            { role: `assistant`, text: `All green.` },
        ]);
        sandboxRequestMock.mockImplementation(sseResponse([], { head: () => ({ prompt: `Continue` }) }));

        await expect(conversation.reattach()).resolves.toBe(true);

        expect(conversation.messages.value.map(({ role, text }) => ({ role, text }))).toEqual([
            { role: `user`, text: `Continue with the tests` },
            { role: `assistant`, text: `All green.` },
            { role: `user`, text: `Continue` },
        ]);
    });

    // A daemon-restarted run's prompt carries the user's words behind a resume note (RESUME_NOTES); stripped, it
    // matches the existing bubble so the run continues under the original question.
    it(`reattach continues the original prompt when the daemon resumed the turn`, async () => {
        const conversation = new Conversation(`c1`);
        conversation.restoreMessages([{ role: `user`, text: `refactor the store` }]);
        sandboxRequestMock.mockImplementation(
            sseResponse([{ kind: `delta`, text: `Picking it back up.` }], {
                head: () => ({ prompt: withResumeNote(`refactor the store`, RESUME_NOTES.auth) }),
            }),
        );

        await expect(conversation.reattach()).resolves.toBe(true);

        expect(conversation.messages.value.map(({ role, text }) => ({ role, text }))).toEqual([
            { role: `user`, text: `refactor the store` },
            { role: `notice`, text: expect.stringContaining(`sign-in renewed`) },
            { role: `assistant`, text: `Picking it back up.` },
        ]);
    });

    // An attach replays a run from its first frame; a resumed park's bubble sits under whatever was already there, so
    // reattaching to a run twice must redraw its answer, not duplicate it.
    it(`reattaching to a resumed park's run redraws its answer instead of stacking a second copy`, async () => {
        const conversation = new Conversation(`c1`);
        conversation.restoreMessages([{ role: `user`, text: `which shape should it be?` }]);
        const carried = withResumeNote(`The user answered: a mode of the board.`, RESUME_NOTES.answered);
        sandboxRequestMock.mockImplementation(
            sseResponse([{ kind: `delta`, text: `That settles it.` }], { head: () => ({ run: `r2`, prompt: carried }) }),
        );

        await expect(conversation.reattach()).resolves.toBe(true);
        await expect(conversation.reattach()).resolves.toBe(true);

        expect(conversation.messages.value.map(({ role, text }) => ({ role, text }))).toEqual([
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
        conversation.restoreMessages([
            { role: `user`, text: `refactor the store` },
            { role: `assistant`, text: `Got as far as the reducer.` },
        ]);
        sandboxRequestMock.mockImplementation(
            sseResponse([{ kind: `delta`, text: `Picking it back up.` }], {
                head: () => ({ run: `r2`, prompt: withResumeNote(`refactor the store`, RESUME_NOTES.restart) }),
            }),
        );

        await expect(conversation.reattach()).resolves.toBe(true);
        await expect(conversation.reattach()).resolves.toBe(true);

        expect(conversation.messages.value.map(({ role, text }) => ({ role, text }))).toEqual([
            { role: `user`, text: `refactor the store` },
            { role: `assistant`, text: `Got as far as the reducer.` },
            { role: `notice`, text: expect.stringContaining(`sandbox came back`) },
            { role: `assistant`, text: `Picking it back up.` },
        ]);
    });

    /* THE WHOLE CHAT, TWICE, AND THEN FIVE TIMES. What a window holds for a run is remembered by RUN ID, and
     * three ordinary things drop that memory while keeping the messages: the mirror paint (transcriptClock's
     * adopt), a redraw from the daemon's record (rebuild), and a window that simply never attached to this run
     * before, which is every popped-out window. The rows then arrive from a run this state has no base for, so
     * they land at the END of a transcript that is already showing them.
     *
     * A single-turn conversation is where it reads worst, because that run's rows ARE the whole chat: the
     * prompt and every answer under it, drawn again below itself, once per hydrate that got in. */
    it(`reattach reclaims the rows already on screen instead of drawing the run a second time`, async () => {
        const conversation = new Conversation(`c1`);
        const rows: TranscriptRow[] = [userRow(`fix the limit reset`, 1_000, []), { role: `assistant`, text: `Tracing the retries.` }];
        conversation.restoreMessages(rows);
        sandboxRequestMock.mockImplementation(sseResponse([], { head: () => ({ rows: structuredClone(rows) }) }));

        await expect(conversation.reattach()).resolves.toBe(true);

        expect(conversation.messages.value.map(({ role, text }) => ({ role, text }))).toEqual([
            { role: `user`, text: `fix the limit reset` },
            { role: `assistant`, text: `Tracing the retries.` },
        ]);
    });

    /* And the same run STILL GOING: the record holds what settled, the head carries that plus what has landed
     * since, so the reclaim has to take the tail it recognises and let the rest through. */
    it(`reattach draws only the part of the run the transcript is not already showing`, async () => {
        const conversation = new Conversation(`c1`);
        const shown: TranscriptRow[] = [userRow(`fix the limit reset`, 1_000, []), { role: `assistant`, text: `Tracing the retries.` }];
        conversation.restoreMessages(shown);
        sandboxRequestMock.mockImplementation(
            sseResponse([], { head: () => ({ rows: [...structuredClone(shown), { role: `assistant`, text: `Found it.` }] }) }),
        );

        await expect(conversation.reattach()).resolves.toBe(true);

        expect(conversation.messages.value.map(({ role, text }) => ({ role, text }))).toEqual([
            { role: `user`, text: `fix the limit reset` },
            { role: `assistant`, text: `Tracing the retries.` },
            { role: `assistant`, text: `Found it.` },
        ]);
    });

    /* The daemon refused the turn before running any of it, so the message was never part of the conversation.
     * It comes back OUT of the transcript and into the queue, which is what makes reconnecting replay it,
     * rather than leaving the user to retype it into every chat the revocation hit. */
    it(`holds an undelivered message in the queue when the Claude credential is revoked`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(
            sseResponse([{ kind: `error`, code: `claude-reauth`, message: `Claude sign-in was revoked, reconnect the account.` }]),
        );

        await conversation.send(`land the branch`, {
            agent: `claude`,
            harness: `native`,
            actsAs: undefined,
            model: `opus`,
            effort: `medium`,
            thinking: false,
            fast: false,
            tierHold: false,
            account: `acct-dead`,
        });

        expect(conversation.messages.value.map((message) => message.role)).toEqual([`notice`]);
        expect(conversation.queued.value.map((message) => message.text)).toEqual([`land the branch`]);
        // Muted, not the red error line: the fix is one click away on the banner this raises.
        expect(conversation.error.value).toBeNull();
    });

    // The harness reads a leading `/` as an unknown command and discards the rest, so the model never sees it and the
    // daemon has no record; this window's bubble is the only copy, held like a revoked credential.
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
            tierHold: false,
        });

        expect(conversation.messages.value.map((message) => message.role)).toEqual([`notice`]);
        // Held verbatim, leading slash and all: retyping it is exactly what the user should not have to do.
        expect(conversation.queued.value.map((message) => message.text)).toEqual([`/workspace view does not remember the file tree`]);
        // Muted: sending again is the fix, and the daemon now knows the command list well enough to let it past.
        expect(conversation.error.value).toBeNull();
    });

    // The model is too small to hold the turn, and the daemon knows before sending, so the words stay in this
    // window; held and muted like the refusals above.
    it(`holds the message when the model's own window cannot hold the turn`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(
            sseResponse([
                {
                    kind: `error`,
                    code: `context-window-too-small`,
                    message: `This model accepts 16,384 tokens in one request and this turn needs about 22,004, so nothing was sent.`,
                },
            ]),
        );

        await conversation.send(`Are you there?`, {
            agent: `endpoint/tiny`,
            harness: `native`,
            actsAs: undefined,
            account: undefined,
            model: `llama-3.2-3b`,
            effort: `medium`,
            thinking: false,
            fast: false,
            tierHold: false,
        });

        expect(conversation.messages.value.map((message) => message.role)).toEqual([`notice`]);
        expect(conversation.queued.value.map((message) => message.text)).toEqual([`Are you there?`]);
        expect(conversation.error.value).toBeNull();
    });

    // A door-refused turn (no error frame) needs both halves handled explicitly: the daemon's own sentence surfaced
    // as the error, and the words held in the queue rather than lost or re-sent blindly.
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
            tierHold: false,
        });

        expect(conversation.error.value).toBe(
            `invalid attachment path: ../../etc/passwd Your message is held below: send it again once that's sorted.`,
        );
        expect(conversation.queued.value.map((message) => message.text)).toEqual([`redesign the settings page`]);
        // Out of the transcript entirely: nothing about this send is part of the conversation, here or daemon-side.
        expect(conversation.messages.value).toEqual([]);
    });

    // A 409 means a turn is already running, so these words belong to it as steering; the queue must stay free to
    // flush once it settles.
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
            tierHold: false,
        });

        expect(conversation.error.value).toContain(`turn`);
        expect(conversation.error.value).toContain(`running`);
        expect(conversation.queued.value).toEqual([]);
    });

    // A request that never completed (unreachable daemon, dropped tunnel) is neither a status nor a frame, and must
    // not be treated as a mid-turn crash: the words return to the queue rather than sitting shown-but-unsent.
    it(`hands the words back when the request never reached the daemon`, async () => {
        const conversation = new Conversation(`c1`);
        const shot = { name: `setup.png`, path: `${STATE_DIR}/records/artifacts/attachments/a1/setup.png` };
        sandboxRequestMock.mockRejectedValue(new Error(`Your sandbox isn't reachable yet, finish setup so it registers its address.`));

        await conversation.send(`the setup view is too scary`, settings, [shot]);

        expect(conversation.error.value).toBe(
            `Your sandbox isn't reachable yet, finish setup so it registers its address. Your message is held below, send it again to deliver it.`,
        );
        // Held whole, attachment and all: the queue is the only place this survives.
        expect(conversation.queued.value.map((message) => [message.text, message.attachments])).toEqual([[`the setup view is too scary`, [shot]]]);
        // And out of the transcript: no daemon anywhere has a record of it.
        expect(conversation.messages.value).toEqual([]);
    });

    // A Stop on a send that never became a turn must not arm the continue offer: nothing is behind it to resume, and
    // it must not open a fresh session on the bare word "Continue".
    it(`stands the continue offer down when the stopped send never became a turn`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation((path, init) => {
            // No run to cancel since the send never became one; the daemon's 404 is what sends the stop back to this
            // window.
            if (path === `/agent/stop`) {
                return Promise.resolve({ ok: false, status: 404 } as Response);
            }
            if (path !== `/agent`) {
                return Promise.resolve({ ok: true, json: () => Promise.resolve({}) } as Response);
            }
            // Hangs exactly as a send into a stalled daemon does, and dies the way fetch does when Stop aborts it.
            return new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener(`abort`, () => reject(new DOMException(`aborted`, `AbortError`)));
            });
        });

        const turn = conversation.send(`the setup view is too scary`, settings);
        expect(conversation.streaming.value).toBe(true);
        conversation.stop();
        await turn;

        expect(conversation.pickUp.value).toBeUndefined();
        expect(conversation.queued.value.map((message) => message.text)).toEqual([`the setup view is too scary`]);
        // A Stop is the user's own doing, so it says so and nothing more: no red line over a send they cancelled.
        expect(conversation.messages.value.map((message) => [message.role, message.text])).toEqual([[`notice`, `Stopped.`]]);
        expect(conversation.error.value).toBeNull();
    });

    it(`replays the held message once the account is reconnected`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(
            sseResponse([{ kind: `error`, code: `claude-reauth`, message: `Claude sign-in was revoked, reconnect the account.` }]),
        );
        await conversation.send(`land the branch`, {
            agent: `claude`,
            harness: `native`,
            actsAs: undefined,
            model: `opus`,
            effort: `medium`,
            thinking: false,
            fast: false,
            tierHold: false,
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

    // A reconnect mints a new account id; leaving the old one on the session ref would read as a deliberate switch
    // and retire a session that still resumes fine.
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
            tierHold: false,
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
            tierHold: false,
            account: `acct-new`,
        });

        const body = JSON.parse(sandboxRequestMock.mock.calls.at(-2)![1]!.body as string) as Record<string, unknown>;
        expect(body[`sessionId`]).toBe(`s-1`);
    });

    it(`reattach replays an already-answered question card as decided, not as a live prompt`, async () => {
        // A reload replays the run from seq 0, rebuilding the card from its own frame; without the resolution frame
        // too,
        // it comes back pending and offers Submit on an already-resolved requestId.
        const conversation = new Conversation(`c1`);
        const questions = [{ question: `Which?`, header: `Pick`, multiSelect: false, options: [{ label: `A`, description: `a` }] }];
        sandboxRequestMock.mockImplementation(
            sseResponse(
                [
                    { kind: `question`, requestId: `q1`, questions },
                    { kind: `resolved`, requestId: `q1`, reply: { kind: `question`, requestId: `q1`, answers: { Which: [`A`] } } },
                    { kind: `delta`, text: `Doing A.` },
                ],
                { head: () => ({ prompt: `which one?`, startedAt: 1234 }) },
            ),
        );

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

        expect(conversation.error.value).toContain(`turn`);
        expect(conversation.error.value).toContain(`running`);
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

    // Attachments are recovered from the stored prompt's note; the redrawn bubble shows them as named chips, not the
    // injected protocol text.
    it(`redraws a restored message's attachments as chips`, () => {
        const conversation = new Conversation(`c1`);

        conversation.restoreMessages([
            { role: `user`, text: `analyze this`, attachments: [`${STATE_DIR}/records/artifacts/attachments/uuid-1/image.png`] },
        ]);

        expect(conversation.messages.value[0]).toMatchObject({
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
        conversation.provider.value = `codex`;

        conversation.restoreMessages([{ role: `user`, text: `hi` }]);

        expect(conversation.isolated.value).toBe(true);
        expect(conversation.provider.value).toBe(`codex`);
    });
});

// A minimized or fully occluded window gets no requestAnimationFrame; the clock needs a fallback timer so the
// transcript doesn't go stale in it.
describe(`the transcript's clock`, () => {
    it(`applies frames on its own timer when the window never delivers one`, async () => {
        const conversation = new Conversation(`c-parked`);
        // Frames requested but never delivered, as with a minimized window.
        vi.stubGlobal(`requestAnimationFrame`, () => 0);
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `delta`, text: `hi` }], { stayOpen: true }));

        const turn = conversation.send(`go`, settings);

        await vi.waitFor(() => expect(conversation.messages.value.at(-1)).toMatchObject({ role: `assistant`, text: `hi` }), { timeout: 2_000 });

        conversation.stop();
        await turn;
    });

    // The daemon's transcript index and the bubble's position are different numbers that diverge once a local notice
    // is drawn; rewinding must use the daemon's index, not the bubble's.
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
        expect(conversation.session.value).toEqual(expect.any(Object));

        const user = conversation.messages.value[0];
        expect(user).toMatchObject({ role: `user`, checkpointId: `cp-1`, rewindIndex: 0 });

        sandboxRequestMock.mockImplementation(async () => new Response(JSON.stringify({ snapshot: `cp-1`, dropped: 2 }), { status: 200 }));
        expect(await conversation.rewindTo(user!)).toBe(true);

        const [path, init] = sandboxRequestMock.mock.calls.at(-1)!;
        expect(path).toBe(`/agent/rewind`);
        expect(JSON.parse(init!.body as string)).toEqual({ conversationId: `c-rewind`, index: 0 });
        // Everything from the rewound message on is gone and the session drops; the notice is the only place that says
        // so, including that the workspace moved too.
        expect(conversation.messages.value).toEqual([
            expect.objectContaining({ role: `notice`, text: `Went back to here, 2 messages dropped and the files restored to this point.` }),
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
        expect(conversation.session.value).toEqual(expect.any(Object));
        expect(conversation.error.value).toContain(`running a turn`);
    });
});

// Conversation.beginEdit/cancelEdit/submitEdit: editing a sent message. Arming destroys and sends nothing, so
// cancel costs nothing; only submit spends the rewind, and only if it lands does anything go out.
describe(`Conversation editing a sent message`, () => {
    // One turn, checkpointed, with the session live: the state every edit starts from.
    const settled = async (id: string): Promise<Conversation> => {
        const conversation = new Conversation(id);
        sandboxRequestMock.mockImplementation(
            sseResponse([
                { kind: `session`, sessionId: `s-1` },
                { kind: `checkpoint`, id: `cp-1`, index: 0 },
                { kind: `delta`, text: `done` },
                { kind: `done` },
            ]),
        );
        await conversation.send(`frist`, settings);
        return conversation;
    };

    it(`arms without touching the transcript, the files or the session`, async () => {
        const conversation = await settled(`c-edit-arm`);
        conversation.draft.value = `something half-written`;
        const before = [...conversation.messages.value];
        sandboxRequestMock.mockClear();

        expect(conversation.beginEdit(conversation.messages.value[0]!)).toBe(true);

        // Old words are in the box, the transcript untouched, and the daemon never asked: nothing yet to undo.
        expect(conversation.draft.value).toBe(`frist`);
        expect(conversation.messages.value).toEqual(before);
        expect(conversation.session.value).toEqual(expect.any(Object));
        expect(sandboxRequestMock).not.toHaveBeenCalled();
    });

    // Entering an edit must not eat a half-written draft, the one thing here the app cannot recover (see `unsent`).
    it(`gives the displaced draft back on cancel`, async () => {
        const conversation = await settled(`c-edit-cancel`);
        conversation.draft.value = `something half-written`;

        conversation.beginEdit(conversation.messages.value[0]!);
        conversation.draft.value = `retyped`;
        conversation.cancelEdit();

        expect(conversation.draft.value).toBe(`something half-written`);
        expect(conversation.editing.value).toBeUndefined();
    });

    it(`refuses to arm on a message with no state to go back to`, async () => {
        const conversation = new Conversation(`c-edit-unanchored`);
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `session`, sessionId: `s-1` }, { kind: `delta`, text: `hi` }, { kind: `done` }]));
        await conversation.send(`first`, settings);

        // No checkpoint means no anchor: files can't be restored, so an edit here would start the replacement on the
        // work
        // it should discard.
        expect(conversation.messages.value[0]?.rewindIndex).toBeUndefined();
        expect(conversation.beginEdit(conversation.messages.value[0]!)).toBe(false);
        expect(conversation.editing.value).toBeUndefined();
    });

    // The rewind must go first and the send only if it lands; reversed, the replacement would run against a workspace
    // still holding the discarded turns.
    it(`rewinds to the message and sends the replacement in its place`, async () => {
        const conversation = await settled(`c-edit-send`);
        conversation.beginEdit(conversation.messages.value[0]!);
        conversation.draft.value = `first`;

        const calls: string[] = [];
        const turn = sseResponse([{ kind: `delta`, text: `better` }, { kind: `done` }]);
        sandboxRequestMock.mockImplementation(async (path: string, init?: RequestInit) => {
            calls.push(path);
            return path === `/agent/rewind` ? new Response(JSON.stringify({ snapshot: `cp-1`, dropped: 2 }), { status: 200 }) : turn(path, init);
        });

        expect(await conversation.submitEdit(`first`)).toBe(true);

        // The rewind went first, and the turn only after it.
        expect(calls[0]).toBe(`/agent/rewind`);
        expect(calls.slice(1).some((path) => path !== `/agent/rewind`)).toBe(true);
        expect(conversation.editing.value).toBeUndefined();
        // The notice names the edit, not the rewind underneath it, so it doesn't read as an unrelated rewind plus a
        // fresh
        // prompt.
        expect(conversation.messages.value[0]).toMatchObject({
            role: `notice`,
            text: `Edited this message, 2 messages dropped and the files restored to this point.`,
        });
        expect(conversation.messages.value[1]).toMatchObject({ role: `user`, text: `first` });
    });

    // A refused rewind leaves the chat untouched, its reason shown, and the edit still armed so the press works once
    // the turn ends.
    it(`sends nothing and stays armed when the rewind is refused`, async () => {
        const conversation = await settled(`c-edit-refused`);
        conversation.beginEdit(conversation.messages.value[0]!);
        const before = [...conversation.messages.value];

        sandboxRequestMock.mockImplementation(async () => new Response(`busy`, { status: 409 }));
        expect(await conversation.submitEdit(`try again`)).toBe(false);

        expect(conversation.messages.value).toEqual(before);
        expect(conversation.editing.value).toEqual(expect.any(Object));
        expect(conversation.error.value).toContain(`running a turn`);
    });

    // Message ids restart from zero on every rebuild, so a replayed record can hand the same id to a different
    // message; an edit resolved by id alone would silently replace the wrong turn.
    it(`disarms when the transcript underneath it is replaced wholesale`, async () => {
        const conversation = await settled(`c-edit-replaced`);
        conversation.beginEdit(conversation.messages.value[0]!);
        expect(conversation.editing.value).toEqual(expect.any(Object));

        // A different record, whose first message carries the id the edit was armed on.
        conversation.restoreMessages([{ role: `user`, text: `a different conversation entirely` }]);
        sandboxRequestMock.mockClear();

        expect(conversation.editing.value).toBeUndefined();
        expect(await conversation.submitEdit(`replacement`)).toBe(false);
        expect(sandboxRequestMock).not.toHaveBeenCalled();
        expect(conversation.messages.value).toEqual([expect.objectContaining({ text: `a different conversation entirely` })]);
    });

    // A plain rewind also renumbers every surviving message, so an armed edit must disarm here too.
    it(`disarms when a plain rewind renumbers the messages under it`, async () => {
        const conversation = await settled(`c-edit-rewound`);
        conversation.beginEdit(conversation.messages.value[0]!);

        sandboxRequestMock.mockImplementation(async () => new Response(JSON.stringify({ snapshot: `cp-1`, dropped: 2 }), { status: 200 }));
        expect(await conversation.rewindTo(conversation.messages.value[0]!)).toBe(true);

        expect(conversation.editing.value).toBeUndefined();
        // And it is the REWIND's own sentence, not the edit's: nobody edited anything here.
        expect(conversation.messages.value[0]).toMatchObject({
            text: `Went back to here, 2 messages dropped and the files restored to this point.`,
        });
    });
});

// Conversation.placeAsAgent: the tab's half of agents.place. The daemon appends the row and drops the provider
// session; a refusal must move nothing here either.
describe(`Conversation placeAsAgent`, () => {
    it(`appends a marked agent bubble and drops the session, so the next send starts a fresh thread`, async () => {
        const conversation = new Conversation(`c-place`);
        sandboxRequestMock.mockImplementation(
            sseResponse([{ kind: `session`, sessionId: `s-1` }, { kind: `delta`, text: `done` }, { kind: `done` }]),
        );
        await conversation.send(`first`, settings);
        expect(conversation.session.value).toEqual(expect.any(Object));

        sandboxRequestMock.mockImplementation(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
        expect(await conversation.placeAsAgent(`I checked the tests.`)).toBe(true);

        const [path, init] = sandboxRequestMock.mock.calls.at(-1)!;
        expect(path).toBe(`/agents/c-place/place`);
        expect(JSON.parse(init!.body as string)).toEqual({ text: `I checked the tests.` });
        // The bubble reads as the agent's, carrying the mark whose one audience is the human re-reading this.
        expect(conversation.messages.value.at(-1)).toMatchObject({ role: `assistant`, text: `I checked the tests.`, placed: true });
        // And the local session matches the daemon's forgotten one: the next send resumes nothing.
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
        expect(conversation.session.value).toEqual(expect.any(Object));
        expect(conversation.error.value).toContain(`running a turn`);
    });

    // A channel conversation's place can fail because the channel itself is unreachable; the daemon's sentence is the
    // only thing naming which audience missed it, so it surfaces verbatim.
    it(`surfaces the daemon's sentence when the channel delivery is refused`, async () => {
        const conversation = new Conversation(`c-place-channel`);
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `session`, sessionId: `s-1` }, { kind: `done` }]));
        await conversation.send(`first`, settings);
        const before = conversation.messages.value.length;

        const daemonMessage = `the discord gateway is not running, so the message cannot reach the channel`;
        sandboxRequestMock.mockImplementation(async () => new Response(JSON.stringify({ message: daemonMessage }), { status: 502 }));
        expect(await conversation.placeAsAgent(`planted`)).toBe(false);

        expect(conversation.messages.value).toHaveLength(before);
        expect(conversation.error.value).toContain(`discord gateway`);
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

// ChatMessage.sentAt: the hover stamp. Three sources (sent here, already running on attach, restored from the
// record) must agree on the hour the user actually pressed send.
describe(`Conversation sent time`, () => {
    it(`stamps a message the user sends here with the moment it was sent`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(sseResponse([{ kind: `delta`, text: `On it.` }, { kind: `done` }]));

        const before = Date.now();
        await conversation.send(`Hi there`, settings);

        const sentAt = conversation.messages.value[0]?.sentAt;
        expect(sentAt).toBeGreaterThanOrEqual(before);
        expect(sentAt).toBeLessThanOrEqual(Date.now());
        // Only the user's row gets a stamp; nothing in the stream says when part of the answer was written, and a
        // guessed
        // time is worse than none.
        expect(conversation.messages.value[1]?.sentAt).toBeUndefined();
    });

    // A turn already running before this tab attached is drawn now but was sent then, so its bubble takes the run's
    // start time, not the attach moment.
    it(`takes the running turn's own start for a bubble drawn on reattach`, async () => {
        const conversation = new Conversation(`c1`);
        sandboxRequestMock.mockImplementation(
            sseResponse([{ kind: `delta`, text: `On it.` }], { head: () => ({ prompt: `refactor the parser`, startedAt: 1234 }) }),
        );

        await expect(conversation.reattach()).resolves.toBe(true);

        expect(conversation.messages.value[0]).toMatchObject({ role: `user`, text: `refactor the parser`, sentAt: 1234 });
    });

    // The daemon writes `sentAt` beside the words (TranscriptRow.sentAt); a redraw from the record must not re-date
    // them.
    it(`keeps the daemon's stamp when a stored transcript is restored`, () => {
        const conversation = new Conversation(`c1`);

        conversation.restoreMessages([
            { role: `user`, text: `start the migration`, sentAt: 1_767_225_600_000 },
            { role: `assistant`, text: `Done with step one.` },
        ]);

        expect(conversation.messages.value.map((message) => message.sentAt)).toEqual([1_767_225_600_000, undefined]);
    });

    // Conversation.box: a conversation homed in another sandbox. No leg (send/attach/stop) may point at the wrong
    // box. Asserted against the reach argument, since that's invisible in the path itself.
    describe(`homed in another sandbox`, () => {
        const remote = (): Conversation => {
            const conversation = new Conversation(`c-elsewhere`);
            conversation.box.value = `sbx-there`;
            return conversation;
        };

        it(`starts the turn on that box's daemon and follows the run there`, async () => {
            const conversation = remote();
            sandboxRequestMock.mockImplementation(sseResponse([{ kind: `delta`, text: `on it` }, { kind: `done` }]));

            await conversation.send(`do it over there`, settings);

            expect(pathsAimedAt(`sbx-there`)).toEqual([`/agent`, `/agent/attach`]);
            expect(pathsAimedAt(undefined)).toEqual([]);
        });

        // `registered` normally latches on a roster frame; this browser streams only one sandbox, so without the ack
        // fallback a remote tab would stay a draft forever and show a phantom New-agent card.
        it(`counts as registered from the daemon's ack, since no roster frame here will ever say so`, async () => {
            const conversation = remote();
            sandboxRequestMock.mockImplementation(sseResponse([{ kind: `done` }]));

            expect(conversation.registered.value).toBe(false);
            await conversation.send(`start`, settings);
            expect(conversation.registered.value).toBe(true);
        });

        // A local conversation keeps the roster-frame latch; the ack alone isn't evidence when a proper stream exists.
        it(`leaves a local conversation's registration to the roster`, async () => {
            const conversation = new Conversation(`c-here`);
            sandboxRequestMock.mockImplementation(sseResponse([{ kind: `done` }]));

            await conversation.send(`start`, settings);

            expect(conversation.registered.value).toBe(false);
            expect(pathsAimedAt(undefined)).toEqual([`/agent`, `/agent/attach`]);
        });

        // Stop is the side channel, and it has to reach the daemon actually running the turn.
        it(`stops the turn at the box running it`, async () => {
            const conversation = remote();
            sandboxRequestMock.mockImplementation(sseResponse([{ kind: `delta`, text: `working` }], { stayOpen: true }));

            const sending = conversation.send(`long one`, settings);
            await vi.waitFor(() => expect(conversation.streaming.value).toBe(true));
            conversation.stop();
            await sending;

            expect(pathsAimedAt(`sbx-there`)).toContain(`/agent/stop`);
            expect(pathsAimedAt(undefined)).toEqual([]);
        });
    });
});

// Paging back through a conversation longer than one window. The daemon answers a transcript read with the most
// recent turns and says where they start (sessions/transcript-record.ts); paging back must not cost what's
// already on screen.
describe(`older history`, () => {
    // The daemon's answer to `GET /agents/{id}/transcript?before=N`, as the fetch layer reads it.
    const olderPage = (messages: readonly TranscriptRow[], from: number, more: boolean): Response =>
        new Response(JSON.stringify({ messages, from, more }), { status: 200, headers: { "content-type": `application/json` } });

    const opened = (): Conversation => {
        const conversation = new Conversation(`c1`);
        conversation.restoreMessages([{ role: `user`, text: `turn 20` }, { role: `assistant`, text: `answer 20` }], { from: 40, more: true });
        return conversation;
    };

    it(`opens on a window that knows it is one`, () => {
        const conversation = opened();
        expect(conversation.historyFrom.value).toBe(40);
        expect(conversation.historyMore.value).toBe(true);
    });

    // A conversation that fits in one window says so, and is the case that must offer nothing: most of them.
    it(`offers nothing to page back through when the record arrived whole`, async () => {
        const conversation = new Conversation(`c1`);
        conversation.restoreMessages([{ role: `user`, text: `hello` }], { from: 0, more: false });

        await conversation.loadOlder();

        expect(conversation.historyMore.value).toBe(false);
        expect(pathsAimedAt(undefined)).toEqual([]);
    });

    it(`puts the older page above what is drawn and moves the cursor to it`, async () => {
        const conversation = opened();
        sandboxRequestMock.mockResolvedValue(olderPage([{ role: `user`, text: `turn 19` }, { role: `assistant`, text: `answer 19` }], 38, true));

        await conversation.loadOlder();

        expect(conversation.messages.value.map(({ text }) => text)).toEqual([`turn 19`, `answer 19`, `turn 20`, `answer 20`]);
        expect(conversation.historyFrom.value).toBe(38);
        expect(conversation.historyMore.value).toBe(true);
        expect(pathsAimedAt(undefined)).toEqual([`/agents/c1/transcript?before=40`]);
    });

    // Ids are identity, not order; a prepended page must not hand an older bubble the id of one already on screen,
    // since a live patch addresses messages by id and a collision would misapply it.
    it(`gives the arriving rows ids of their own`, async () => {
        const conversation = opened();
        const standing = conversation.messages.value.map((message) => message.id);
        sandboxRequestMock.mockResolvedValue(olderPage([{ role: `user`, text: `turn 19` }, { role: `assistant`, text: `answer 19` }], 38, true));

        await conversation.loadOlder();

        const ids = conversation.messages.value.map((message) => message.id);
        expect(new Set(ids).size).toBe(ids.length);
        // And the rows that were already drawn keep the ids they had, so nothing addressing them goes stale.
        expect(ids.slice(2)).toEqual(standing);
    });

    // Reaching the beginning retires the offer, so the top of the record reads as the top of the record.
    it(`stops offering once the first page of the record lands`, async () => {
        const conversation = opened();
        sandboxRequestMock.mockResolvedValue(olderPage([{ role: `user`, text: `turn 1` }], 0, false));

        await conversation.loadOlder();

        expect(conversation.historyFrom.value).toBe(0);
        expect(conversation.historyMore.value).toBe(false);
    });

    // Two presses against one cursor are the same page twice; the second is refused rather than queued.
    it(`reads one page per cursor however many times it is asked`, async () => {
        const conversation = opened();
        sandboxRequestMock.mockResolvedValue(olderPage([{ role: `user`, text: `turn 19` }], 38, true));

        await Promise.all([conversation.loadOlder(), conversation.loadOlder()]);

        expect(pathsAimedAt(undefined)).toEqual([`/agents/c1/transcript?before=40`]);
        expect(conversation.messages.value.map(({ text }) => text)).toEqual([`turn 19`, `turn 20`, `answer 20`]);
    });

    // A failed read costs nothing: the transcript stays as it was and the offer stands, so retrying is the same press
    // again.
    it(`leaves the transcript and the offer alone when the read fails`, async () => {
        const conversation = opened();
        sandboxRequestMock.mockRejectedValue(new Error(`tunnel closed`));

        await expect(conversation.loadOlder()).resolves.toBeUndefined();

        expect(conversation.messages.value.map(({ text }) => text)).toEqual([`turn 20`, `answer 20`]);
        expect(conversation.historyFrom.value).toBe(40);
        expect(conversation.historyMore.value).toBe(true);
        expect(conversation.loadingOlder.value).toBe(false);
    });

    // A redraw (rewind, runtime handoff) replaces the window, so the cursor must move with it; a stale `historyFrom`
    // would fetch rows that no longer sit above anything on screen.
    it(`re-aims the cursor when the transcript is redrawn under it`, () => {
        const conversation = opened();
        conversation.restoreMessages([{ role: `user`, text: `only turn` }], { from: 0, more: false });
        expect(conversation.historyFrom.value).toBe(0);
        expect(conversation.historyMore.value).toBe(false);
    });

    // A caller with no page to report can't vouch for where its rows sit, so the cursor reads "this is all of it"
    // rather than a stale one.
    it(`drops the cursor for a redraw that cannot say where its rows sit`, () => {
        const conversation = opened();
        conversation.restoreMessages([{ role: `user`, text: `from the mirror` }]);
        expect(conversation.historyMore.value).toBe(false);
    });
});
