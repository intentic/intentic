import type { OpenCodeClient } from "@opencode/client";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { realYield } from "@intentic/testing/bun";
import { turnWatchdog } from "../decorators/turn-watchdog.js";
import { FORM_DISMISSED, FORM_UNRENDERABLE } from "./opencode-forms.js";
import type { EventOf } from "./opencode-frames.js";
import {
    answerForm,
    BACKGROUND_WAIT_MS,
    FOREGROUND_SHELL_MAX_MS,
    handover,
    heardBefore,
    noteCall,
    noteExecution,
    noteInbox,
    noteOutside,
    readBack,
    sendSteer,
    settling,
    type TurnAsk,
    turnProgress,
    turnQueue,
    type TurnReading,
} from "./opencode-turn.js";

// The waiting half of reading an OpenCode turn, against a faked client and clock: how long silence may last while a
// shell runs or is left behind, the steers it sends, the forms it puts on a card, the retries it hands over, and what it
// reads back after the server's stream reopened. Event shapes follow opencode 2.0.26.

const START = 1_700_000_000_000;
const TIMEOUTS = { inactivityMs: 120_000, maxTurnMs: 30 * 60_000 };

afterEach(() => {
    jest.useRealTimers();
    jest.setSystemTime();
});

const durable = (sessionID: string, seq: number) => ({ aggregateID: sessionID, seq, version: 1 as const });
const callStarted = (id: string, name: string): EventOf<"session.tool.input.started"> => ({
    id: `evt_in_${id}`,
    created: 1,
    type: "session.tool.input.started",
    durable: durable("s1", 1),
    data: { sessionID: "s1", assistantMessageID: "m1", id, name },
});
const called = (id: string, input: Record<string, unknown>): EventOf<"session.tool.called"> => ({
    id: `evt_called_${id}`,
    created: 2,
    type: "session.tool.called",
    durable: durable("s1", 2),
    data: { sessionID: "s1", assistantMessageID: "m1", id, input, executed: false },
});
const started = (sessionID: string): EventOf<"session.execution.started"> => ({
    id: `evt_started_${sessionID}`,
    created: 3,
    type: "session.execution.started",
    durable: durable(sessionID, 3),
    data: { sessionID },
});
const succeeded = (sessionID: string, seq = 4): EventOf<"session.execution.succeeded"> => ({
    id: `evt_done_${sessionID}_${String(seq)}`,
    created: 4,
    type: "session.execution.succeeded",
    durable: durable(sessionID, seq),
    data: { sessionID },
});
const delivered = (inboxID: string): EventOf<"session.inbox.delivered"> => ({
    id: `evt_delivered_${inboxID}`,
    created: 5,
    type: "session.inbox.delivered",
    durable: durable("s1", 5),
    data: { sessionID: "s1", inboxID },
});

describe("a shell call", () => {
    // A foreground command says nothing between its start and its end; read as silence, a long build would end the turn.
    test("in the foreground keeps the silence window open past its own time limit", () => {
        jest.setSystemTime(START);
        const clock = turnWatchdog(TIMEOUTS);
        const progress = turnProgress();

        noteCall(progress, callStarted("c1", "shell"), clock);
        noteCall(progress, called("c1", { command: "pnpm build", timeout: 600_000 }), clock);

        expect(clock.remaining()).toBe(600_000 + TIMEOUTS.inactivityMs);
    });

    test("with no limit of its own gets the tool's default, and one asking for none is still bounded", () => {
        jest.setSystemTime(START);
        const plain = turnWatchdog(TIMEOUTS);
        const progress = turnProgress();
        noteCall(progress, callStarted("c1", "shell"), plain);
        noteCall(progress, called("c1", { command: "make" }), plain);
        expect(plain.remaining()).toBe(120_000 + TIMEOUTS.inactivityMs);

        const unbounded = turnWatchdog(TIMEOUTS);
        noteCall(progress, callStarted("c2", "shell"), unbounded);
        noteCall(progress, called("c2", { command: "tail -f log", timeout: 0 }), unbounded);
        expect(unbounded.remaining()).toBe(FOREGROUND_SHELL_MAX_MS + TIMEOUTS.inactivityMs);
    });

    // Every event the turn reads restarts the silence window; the hold is put back after each until the call ends.
    test("in the foreground holds the window through the events that follow it, until its own ending", () => {
        jest.setSystemTime(START);
        const clock = turnWatchdog(TIMEOUTS);
        const progress = turnProgress();
        noteCall(progress, callStarted("c1", "shell"), clock);
        noteCall(progress, called("c1", { command: "pnpm build", timeout: 600_000 }), clock);

        const progressed: EventOf<"session.tool.progress"> = {
            id: "evt_progress",
            created: 3,
            type: "session.tool.progress",
            data: { sessionID: "s1", assistantMessageID: "m1", id: "c1", metadata: { shellID: "sh_1" } },
        };
        clock.touch();
        noteCall(progress, progressed, clock);
        expect(clock.remaining()).toBe(600_000 + TIMEOUTS.inactivityMs);

        jest.setSystemTime(START + 30_000);
        const ended: EventOf<"session.tool.success"> = {
            id: "evt_ok",
            created: 4,
            type: "session.tool.success",
            durable: { aggregateID: "s1", seq: 7, version: 2 },
            data: { sessionID: "s1", assistantMessageID: "m1", id: "c1", content: [{ type: "text", text: "built" }], executed: true },
        };
        clock.touch();
        noteCall(progress, ended, clock);
        expect(clock.remaining()).toBe(TIMEOUTS.inactivityMs);
    });

    test("in the background, or any other tool's call, leaves the silence window alone", () => {
        jest.setSystemTime(START);
        const clock = turnWatchdog(TIMEOUTS);
        const progress = turnProgress();

        noteCall(progress, callStarted("c1", "shell"), clock);
        noteCall(progress, called("c1", { command: "pnpm dev", background: true }), clock);
        noteCall(progress, callStarted("c2", "read"), clock);
        noteCall(progress, called("c2", { path: "a.ts", timeout: 600_000 }), clock);

        expect(clock.remaining()).toBe(TIMEOUTS.inactivityMs);
    });
});

// What the outside brings in through OpenCode's own tools reaches the turn's taint bit, which the command gate reads.
describe("a call whose result brings the outside in", () => {
    const succeededCall = (id: string): EventOf<"session.tool.success"> => ({
        id: `evt_ok_${id}`,
        created: 5,
        type: "session.tool.success",
        durable: { aggregateID: "s1", seq: 7, version: 2 },
        data: { sessionID: "s1", assistantMessageID: "m1", id, content: [{ type: "text", text: "ok" }], executed: true },
    });
    const failedCall = (id: string): EventOf<"session.tool.failed"> => ({
        id: `evt_fail_${id}`,
        created: 5,
        type: "session.tool.failed",
        durable: { aggregateID: "s1", seq: 7, version: 2 },
        data: { sessionID: "s1", assistantMessageID: "m1", id, error: { type: "unknown", message: "no" }, executed: true },
    });
    const run = (calls: readonly (readonly [string, string, Record<string, unknown>, "ok" | "failed"])[]): string[] => {
        const marked: string[] = [];
        const progress = turnProgress();
        const clock = turnWatchdog(TIMEOUTS);
        const nameOf = (raw: string): string => (raw === "intentic_k_web_navigate" ? "mcp__web__navigate" : raw === "intentic_k_ui_ask" ? "mcp__ui__ask" : raw);
        for (const [id, name, input, ending] of calls) {
            for (const event of [callStarted(id, name), called(id, input), ending === "ok" ? succeededCall(id) : failedCall(id)]) {
                noteCall(progress, event, clock);
                noteOutside(progress, event, nameOf, (source) => marked.push(source));
            }
        }
        return marked;
    };

    test("a fetch, a search, a network command and a browser's answer mark it once they succeeded", () => {
        expect(
            run([
                ["c1", "webfetch", { url: "https://example.com" }, "ok"],
                ["c2", "websearch", { query: "x" }, "ok"],
                ["c3", "shell", { command: "curl https://example.com" }, "ok"],
                ["c4", "intentic_k_web_navigate", { url: "https://example.com" }, "ok"],
            ]),
        ).toEqual(["web", "web-search", "shell-fetch", "web"]);
    });

    test("a local command, a file read, the daemon's own control server and a failed fetch mark nothing", () => {
        expect(
            run([
                ["c1", "shell", { command: "ls" }, "ok"],
                ["c2", "read", { path: "a.ts" }, "ok"],
                ["c3", "intentic_k_ui_ask", { question: "?" }, "ok"],
                ["c4", "webfetch", { url: "https://example.com" }, "failed"],
            ]),
        ).toEqual([]);
    });
});

describe("a turn whose own work ended", () => {
    test("is done once nothing is left to wait on", () => {
        const progress = turnProgress();
        noteExecution(progress, started("s1"), "s1");
        noteExecution(progress, succeeded("s1"), "s1");

        expect(progress.ownEnded).toBe(true);
        expect(settling(progress, 0, turnWatchdog(TIMEOUTS))).toBe("done");
    });

    test("waits on a steer still on its way, and on a form open on a card", () => {
        const clock = turnWatchdog(TIMEOUTS);
        const steering = turnProgress();
        steering.steers.add("msg_2");
        expect(settling(steering, 0, clock)).toBe("wait");

        const asking = turnProgress();
        asking.forms = 1;
        expect(settling(asking, 0, clock)).toBe("wait");
    });

    // A dev server never ends on its own: waited on without a bound, it held the turn silent until its cap, then failed it.
    test("waits on a shell left in the background for a bounded time, the silence window moved to match", () => {
        jest.setSystemTime(START);
        const clock = turnWatchdog(TIMEOUTS);
        const progress = turnProgress();

        expect(settling(progress, 1, clock, START)).toBe("wait");
        expect(progress.followUpUntil).toBe(START + BACKGROUND_WAIT_MS);
        expect(clock.remaining(progress.followUpUntil)).toBe(BACKGROUND_WAIT_MS);

        // Asked again later, the bound stays where it was first set.
        expect(settling(progress, 1, clock, START + 60_000)).toBe("wait");
        expect(progress.followUpUntil).toBe(START + BACKGROUND_WAIT_MS);
    });

    test("a new execution of its session starts the wait over", () => {
        const progress = turnProgress();
        progress.followUpUntil = START;
        progress.backgroundUntil = START;
        noteExecution(progress, started("s1"), "s1");

        expect(progress).toMatchObject({ ownEnded: false, followUpUntil: undefined, backgroundUntil: undefined });
    });
});

describe("a steer", () => {
    const steeringClient = (prompts: unknown[]) =>
        unstubbed<OpenCodeClient>("client", {
            session: unstubbed<OpenCodeClient["session"]>("client.session", {
                prompt: async (input) => {
                    prompts.push(input);
                    return { id: "msg_2", sessionID: "s1", time: { created: 0 }, type: "user", payload: { text: input.text }, delivery: "steer" };
                },
            }),
        });
    const reading = (client: OpenCodeClient): TurnReading => ({
        client,
        sessionId: "s1",
        queue: turnQueue(),
        clock: turnWatchdog(TIMEOUTS),
        ask: undefined,
        members: () => new Set(["s1"]),
        signal: new AbortController().signal,
    });

    test("is sent as an OpenCode steer and holds the turn open until the session takes it in", async () => {
        const prompts: unknown[] = [];
        const progress = turnProgress();

        await sendSteer(reading(steeringClient(prompts)), progress, "use the other branch");

        expect(prompts).toEqual([{ sessionID: "s1", text: "use the other branch", delivery: "steer" }]);
        expect([...progress.steers]).toEqual(["msg_2"]);
        noteInbox(progress, delivered("msg_2"), "s1");
        expect([...progress.steers]).toEqual([]);
    });

    // The session can take a steer in before its send has answered; it must not then wait on it for ever.
    test("taken in before its send answered holds nothing open", async () => {
        const progress = turnProgress();
        noteInbox(progress, delivered("msg_2"), "s1");

        await sendSteer(reading(steeringClient([])), progress, "and add a test");

        expect([...progress.steers]).toEqual([]);
        expect(progress.sending).toBe(0);
    });
});

describe("a form the session raises", () => {
    const FORM: EventOf<"form.created">["data"]["form"] = {
        id: "frm_1",
        sessionID: "s1",
        title: "Questions",
        metadata: { kind: "question" },
        fields: [{ key: "q0", title: "Color", description: "Which color?", type: "string", options: [{ value: "Blue", label: "Blue" }], custom: true }],
    };
    const formClient = (calls: string[]) =>
        unstubbed<OpenCodeClient>("client", {
            session: unstubbed<OpenCodeClient["session"]>("client.session", {
                form: unstubbed<OpenCodeClient["session"]["form"]>("client.session.form", {
                    reply: async (input) => void calls.push(`reply ${JSON.stringify(input.answer)}`),
                    cancel: async (input) => void calls.push(`cancel ${input.message ?? ""}`),
                }),
            }),
        });
    const reading = (client: OpenCodeClient, ask: TurnAsk | undefined): TurnReading => ({
        client,
        sessionId: "s1",
        queue: turnQueue(),
        clock: turnWatchdog(TIMEOUTS),
        ask,
        members: () => new Set(["s1"]),
        signal: new AbortController().signal,
    });

    test("goes on a question card, the turn's clock held while it waits, and is answered from the card", async () => {
        jest.setSystemTime(START);
        const calls: string[] = [];
        const answer = Promise.withResolvers<void>();
        let asked: AgentEvent | undefined;
        const turn = reading(formClient(calls), async (questions, push) => {
            const frame: AgentEvent = { kind: "question", requestId: "r1", questions: [...questions] };
            asked = frame;
            push(frame);
            await answer.promise;
            return { kind: "question", requestId: "r1", answers: { "Which color?": ["Blue"] } };
        });
        const progress = turnProgress();

        answerForm(turn, progress, FORM);
        await realYield();
        expect(progress.forms).toBe(1);
        expect(turn.clock.remaining()).toBe(Number.POSITIVE_INFINITY);

        answer.resolve();
        await realYield();
        expect(calls).toEqual(['reply {"q0":"Blue"}']);
        expect(progress.forms).toBe(0);
        // The card's frame in order on the turn's stream, then a wake so the turn looks again at whether it is done.
        expect(asked?.kind).toBe("question");
        expect(await turn.queue.next(turn.clock, undefined)).toMatchObject({ type: "intentic.frame", frame: { kind: "question", requestId: "r1" } });
        expect(await turn.queue.next(turn.clock, undefined)).toEqual({ type: "intentic.wake" });
    });

    test("dismissed on its card is cancelled with words telling the model to carry on", async () => {
        const calls: string[] = [];
        const turn = reading(formClient(calls), async () => ({ kind: "question", requestId: "r1", cancelled: true }));

        answerForm(turn, turnProgress(), FORM);
        await realYield();

        expect(calls).toEqual([`cancel ${FORM_DISMISSED}`]);
    });

    // Nobody answers a form a turn has no card for: left standing, it would park the turn until its watchdog.
    test("is cancelled at once where the turn has nobody to ask, or the form has a page to visit", async () => {
        const calls: string[] = [];
        answerForm(reading(formClient(calls), undefined), turnProgress(), FORM);
        const pageForm: EventOf<"form.created">["data"]["form"] = {
            ...FORM,
            id: "frm_2",
            fields: [{ key: "login", type: "external", url: "https://example.com/oauth" }],
        };
        answerForm(reading(formClient(calls), async () => ({ kind: "question", requestId: "r1" })), turnProgress(), pageForm);
        await realYield();

        expect(calls).toEqual([`cancel ${FORM_UNRENDERABLE}`, `cancel ${FORM_UNRENDERABLE}`]);
    });
});

describe("a retry OpenCode scheduled", () => {
    const retry = (at: number, type: string, attempt = 2): EventOf<"session.retry.scheduled"> => ({
        id: "evt_retry",
        created: 1,
        type: "session.retry.scheduled",
        durable: durable("s1", 6),
        data: { sessionID: "s1", assistantMessageID: "m1", attempt, at, error: { type, message: "No capacity" } },
    });

    test("is handed to the daemon as its coded failure once it would fall past the turn's cap", () => {
        jest.setSystemTime(START);
        const clock = turnWatchdog({ inactivityMs: 120_000, maxTurnMs: 60_000 });

        expect(handover(retry(START + 5_000, "provider.internal"), clock)).toBeUndefined();
        expect(handover(retry(START + 90_000, "provider.internal"), clock)).toEqual({
            type: "intentic.failed",
            frame: { kind: "error", code: "provider-outage", message: "No capacity" },
        });
    });
});

describe("after the server's stream reopened", () => {
    test("an event read back that was already heard is dropped, and each session's newest sequence kept", () => {
        const progress = turnProgress();
        const ending = succeeded("s1", 9);

        expect(heardBefore(progress, ending)).toBe(false);
        expect(heardBefore(progress, ending)).toBe(true);
        expect(progress.seq.get("s1")).toBe(9);
    });

    // OpenCode 2.0.26's log answered only its caught-up marker when read back: the session's own record of its last
    // execution is what says how it ended.
    test("a session the server no longer runs is read as ending the way its last recorded message says", async () => {
        const queue = turnQueue();
        const client = unstubbed<OpenCodeClient>("client", {
            session: unstubbed<OpenCodeClient["session"]>("client.session", {
                log: () =>
                    (async function* () {
                        yield { type: "log.synced" as const, aggregateID: "s1", seq: 9 };
                    })(),
                active: async () => ({}),
                form: unstubbed<OpenCodeClient["session"]["form"]>("client.session.form", { list: async () => [] }),
            }),
            message: unstubbed<OpenCodeClient["message"]>("client.message", {
                list: async () => ({ data: [{ id: "m9", time: { created: 9 }, type: "idle", outcome: "succeeded" }], cursor: {} }),
            }),
        });
        const progress = turnProgress();
        noteExecution(progress, started("s1"), "s1");

        await readBack({ client, sessionId: "s1", queue, clock: turnWatchdog(TIMEOUTS), ask: undefined, members: () => new Set(["s1"]), signal: new AbortController().signal }, progress);

        expect(await queue.next(turnWatchdog(TIMEOUTS), undefined)).toMatchObject({ type: "session.execution.succeeded", data: { sessionID: "s1" } });
    });
});
