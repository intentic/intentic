import { STATE_DIR } from "@intentic/constants";
import { type AttachFrame, type ConversationQueue, deriveTitle, type MessageReceipt, type TranscriptRow } from "@intentic/sandbox-contract";
import { userRow } from "@intentic/sandbox-contract/transcript-fold";
import { unstubbed } from "@intentic/testing";
import { AsyncIteratorClass } from "@orpc/client";
import { hoisted, stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { computed, ref, shallowRef, watch } from "vue";
import type { AgentStanding } from "../../agents/fleet/agentStatus";
import { SandboxHttpError } from "../../sandbox/client/sandboxHttpError";
import type { SandboxRpc } from "../../sandbox/client/sandboxRpc";
import { fakeSandboxRpc } from "../../../testing/sandboxRpcFake";
import { runningTurn } from "../../../testing/runningTurn";
import type { PendingAttachment } from "../drafts/useChatAttachments";
import type { PickUp } from "../run/pickUp";
import type { TurnFailures } from "../run/turnFailures";
import type { SessionRef, TurnSettings } from "../run/turnRequest";
import type { ChatMessage } from "../transcript/transcript";
import type { ComposerSelection } from "./composerSelection";
import { IDLE } from "./runPhase";

// One conversation's runs through their phases (runPhase.ts), and the doors into the daemon's queue they share, against
// a host that is nothing but the refs a run reads and writes and a daemon that is the procedures a run calls. Whole
// conversations against a modelled daemon are conversation.test.ts's.

const { run, attach, stop, resume, queueResume, queueRemove, queueEdit } = hoisted(() => ({
    run: mock<SandboxRpc["agent"]["run"]>(),
    attach: mock<SandboxRpc["agent"]["attach"]>(),
    stop: mock<SandboxRpc["agent"]["stop"]>(),
    resume: mock<SandboxRpc["agent"]["resume"]>(),
    queueResume: mock<SandboxRpc["agent"]["queueResume"]>(),
    queueRemove: mock<SandboxRpc["agent"]["queueRemove"]>(),
    queueEdit: mock<SandboxRpc["agent"]["queueEdit"]>(),
}));
mock.module("../../sandbox/client/sandboxRpc", () => ({
    sandboxRpc: fakeSandboxRpc({ agent: { run, attach, stop, resume, queueResume, queueRemove, queueEdit } }),
}));

const { TurnClient } = await import("./turnClient");
const { TranscriptView } = await import("./transcriptView");

const SETTINGS: TurnSettings = {
    agent: `claude`,
    harness: `native`,
    account: undefined,
    actsAs: undefined,
    startIn: undefined,
    model: `opus`,
    effort: `high`,
    thinking: false,
    fast: false,
};
const FILE = { name: `shot.png`, path: `${STATE_DIR}/a/shot.png` };
const REFUSAL = `The free allowance is spent.`;

// A run the daemon took, as its attach stream carries it: the head naming the run and its rows, then the end.
const attached = (runId: string, startedAt: number, prompt: string): AsyncIteratorClass<AttachFrame, unknown, void> => {
    const rows: TranscriptRow[] = [{ ...userRow(prompt, startedAt, []), run: runId }];
    const frames: AttachFrame[] = [{ kind: `attached`, run: runId, startedAt, seq: 0, rows }, { kind: `end` }];
    return new AsyncIteratorClass<AttachFrame, unknown, void>(
        async () => {
            const frame = frames.shift();
            return frame === undefined ? { done: true, value: undefined } : { done: false, value: frame };
        },
        async () => undefined,
    );
};

// A message waiting in the daemon's queue, as the card shows it.
const WAITING: ConversationQueue = {
    items: [{ id: `m-wait`, text: `and the docs`, voice: `person`, queuedAt: 1_000, revision: 1 }],
    revision: 1,
};

// A TurnClient over a conversation that is only its refs: the transcript is a real one, since a run's rows are drawn
// there; the selection and the failure policy answer only what a run asks of them.
const clientOf = () => {
    const error = ref<string | null>(null);
    const session = ref<SessionRef | undefined>();
    const box = ref<string | undefined>();
    const draft = ref(``);
    const attachments = ref<PendingAttachment[]>([]);
    const host = {
        conversationId: `c1`,
        // Drawn over this client, so handed over once both exist.
        get transcript(): InstanceType<typeof TranscriptView> {
            return transcript;
        },
        selection: unstubbed<ComposerSelection>(`selection`, {
            turnSettings: () => SETTINGS,
            apply: mock(),
            mode: computed(() => `default` as const),
            provider: computed(() => `claude` as const),
            account: computed(() => undefined),
            harness: computed(() => `native` as const),
        }),
        failures: unstubbed<TurnFailures>(`failures`, { cancelProbe: mock(), clear: mock(), armRenewalProbe: mock() }),
        title: ref<string | null>(null),
        isolated: ref(true),
        runner: ref<string | undefined>(),
        box,
        registered: ref(false),
        standing: ref<AgentStanding | undefined>(),
        pendingForkOf: ref<{ conversationId: string; keep: number; files: "then" | "now" } | undefined>(),
        error,
        pickUp: ref<PickUp | undefined>(),
        session,
        agentTerminal: ref<string | undefined>(),
        agentBrowser: ref<string | undefined>(),
        peek: ref(true),
        draft,
        attachments,
        queue: shallowRef<ConversationQueue | undefined>(),
    };
    const client = new TurnClient(host);
    const transcript = new TranscriptView(() => undefined, {
        conversationId: `c1`,
        box,
        draft,
        attachments,
        error,
        session,
        turn: client,
    });
    // Every phase the run moves through, in order, as the sync watcher sees each write.
    const phases: string[] = [];
    watch(
        () => client.phase.value,
        (phase) => void phases.push(phase.kind),
        { flush: `sync` },
    );
    return { client, host, phases };
};

// A client whose turn is live and parked on a permission card: words said now go to the daemon, which holds them.
const parked = () => {
    const made = clientOf();
    const rows: ChatMessage[] = [
        { id: 1, role: `user`, text: `clean the sandbox` },
        { id: 2, role: `assistant`, text: ``, permission: { requestId: `p1`, toolName: `Bash`, status: `pending` } },
    ];
    made.host.transcript.adopt(rows);
    runningTurn(made.client);
    return made;
};

// The receipts the daemon answers sends with.
const answers = (...receipts: MessageReceipt[]): void => {
    for (const receipt of receipts) {
        run.mockImplementationOnce(async () => receipt);
    }
};

beforeEach(() => {
    run.mockImplementation(async () => {
        throw new SandboxHttpError(402, REFUSAL);
    });
    stubGlobal(`requestAnimationFrame`, (callback: FrameRequestCallback): number => {
        callback(0);
        return 0;
    });
    stubGlobal(`cancelAnimationFrame`, () => {});
});

afterEach(() => {
    unstubAllGlobals();
    for (const procedure of [run, attach, stop, resume, queueResume, queueRemove, queueEdit]) {
        procedure.mockReset();
    }
});

describe(`a run's lifecycle`, () => {
    it(`opens a send, is taken at the daemon's ack, and settles as a run the daemon had`, async () => {
        const { client, host, phases } = clientOf();
        answers({ delivered: `started`, run: `r1` });
        attach.mockImplementation(async () => attached(`r1`, 4_000, `tidy the docs`));

        await client.send(`tidy the docs`, SETTINGS);

        expect(phases).toEqual([`sending`, `running`, `idle`]);
        expect(client.phase.value).toEqual({ kind: `idle`, accepted: true });
        expect(client.streaming.value).toBe(false);
        expect(client.turnStartedAt.value).toBeUndefined();
        // Named after its first message, as the daemon's own record names it.
        expect(host.title.value).toBe(deriveTitle(`tidy the docs`));
        expect(host.transcript.messages.value.map((message) => message.text)).toEqual([`tidy the docs`]);
    });

    it(`settles a send the door refused as never taken, with its words back in the composer`, async () => {
        const { client, host, phases } = clientOf();
        host.draft.value = `typed since`;

        await client.send(`tidy the docs`, SETTINGS, [FILE]);

        expect(phases).toEqual([`sending`, `idle`]);
        expect(client.phase.value).toEqual(IDLE);
        expect(host.draft.value).toBe(`tidy the docs\n\ntyped since`);
        expect(host.attachments.value).toEqual([{ id: expect.any(String), name: FILE.name, path: FILE.path, status: `done`, progress: 100 }]);
        expect(host.transcript.messages.value).toEqual([]);
        expect(host.error.value).toBe(`${REFUSAL} Your message is back in the composer: send it again once that's sorted.`);
    });

    it(`ends an errand stopped while its words are composed here, sending nothing and arming no way back`, async () => {
        const { client, host, phases } = clientOf();
        const started = client.startErrand(
            `Resolving the conflict`,
            (signal) => new Promise<string>((_, reject) => signal.addEventListener(`abort`, () => reject(new DOMException(`aborted`, `AbortError`)))),
        );
        expect(client.phase.value.kind).toBe(`composing`);

        client.stop();

        expect(await started).toBe(false);
        expect(phases).toEqual([`composing`, `idle`]);
        expect(run).not.toHaveBeenCalled();
        expect(stop).not.toHaveBeenCalled();
        expect(host.transcript.messages.value).toEqual([]);
        expect(host.pickUp.value).toBeUndefined();
    });

    it(`sends an errand's words once composed, through the same phases as any send`, async () => {
        const { client, phases } = clientOf();
        answers({ delivered: `started`, run: `r2` });
        attach.mockImplementation(async () => attached(`r2`, 5_000, `Resolve the conflict in docs/a.md`));

        expect(await client.startErrand(`Resolving the conflict`, async () => `Resolve the conflict in docs/a.md`)).toBe(true);

        expect(phases.slice(0, 3)).toEqual([`composing`, `sending`, `running`]);
        expect(run.mock.calls[0]?.[0]).toMatchObject({ conversationId: `c1`, prompt: `Resolve the conflict in docs/a.md` });
    });

    it(`adopts a run the daemon already took, from its own start, and settles it as taken`, async () => {
        const { client, phases } = clientOf();
        const startedAt: (number | undefined)[] = [];
        watch(client.turnStartedAt, (at) => void startedAt.push(at), { flush: `sync` });
        attach.mockImplementation(async () => attached(`r7`, 9_000, `carry on`));

        expect(await client.reattach()).toBe(true);

        expect(phases).toEqual([`running`, `idle`]);
        expect(startedAt).toEqual([9_000, undefined]);
        expect(client.phase.value).toEqual({ kind: `idle`, accepted: true });
    });

    it(`stays idle when the daemon has no run to attach to`, async () => {
        const { client, phases } = clientOf();
        attach.mockImplementation(async () => {
            throw new SandboxHttpError(404, `Nothing is running.`);
        });

        expect(await client.reattach()).toBe(false);

        expect(phases).toEqual([]);
        expect(client.phase.value).toBe(IDLE);
    });

    // Looking for the turn the queue starts next, a head naming the run this window just saw end is not it.
    it(`stands down for a head naming a run it has already seen to its end`, async () => {
        const { client, phases } = clientOf();
        attach.mockImplementation(async () => attached(`r7`, 9_000, `carry on`));

        expect(await client.reattach(`r7`)).toBe(false);

        expect(phases).toEqual([]);
    });

    it(`arms the way back when the reader stops a run the daemon took, and asks the daemon to stop that run`, () => {
        const { client, host } = clientOf();
        stop.mockImplementation(async () => ({ stopped: true }));
        runningTurn(client, 4_000, `r4`);

        client.stop();

        expect(host.pickUp.value).toEqual({ reason: `stopped` });
        expect(stop.mock.calls[0]?.[0]).toEqual({ conversationId: `c1`, run: `r4` });
    });

    // A send not yet answered has no run to name, only its message; one the daemon has not made a turn of yet is
    // stopped once the ack names its run, and never by a stop that could land on a turn another window started.
    it(`names the message of a send not yet answered, and its run once the ack brings one`, async () => {
        const { client } = clientOf();
        let ack: ((receipt: MessageReceipt) => void) | undefined;
        run.mockImplementation(() => new Promise((resolve) => (ack = resolve)));
        stop.mockImplementation(async () => ({ stopped: false }));
        attach.mockImplementation(async () => attached(`r5`, 5_000, `tidy the docs`));
        const sending = client.send(`tidy the docs`, SETTINGS);
        await Promise.resolve();

        client.stop();
        await new Promise((settle) => setTimeout(settle, 0));
        ack?.({ delivered: `started`, run: `r5` });
        await sending;

        const messageId = run.mock.calls[0]?.[0].messageId ?? `none sent`;
        expect(messageId).toEqual(expect.any(String));
        expect(stop.mock.calls.map(([body]) => body)).toEqual([
            { conversationId: `c1`, messageId },
            { conversationId: `c1`, run: `r5` },
        ]);
    });

    it(`stops nothing when nothing runs, and arms no way back for a turn the daemon never took`, () => {
        const { client, host } = clientOf();

        client.stop();
        expect(host.pickUp.value).toBeUndefined();

        client.endedByReader();
        expect(host.pickUp.value).toBeUndefined();
    });

    it(`sees each tool card first once per turn`, () => {
        const { client } = clientOf();

        expect(client.firstSight(`t1`)).toBe(true);
        expect(client.firstSight(`t1`)).toBe(false);
        expect(client.firstSight(`t2`)).toBe(true);
    });

    it(`re-runs nothing the daemon is not holding, and nothing while a turn is live`, async () => {
        const idle = clientOf();
        idle.host.pickUp.value = { reason: `stopped` };
        expect(await idle.client.resumeHeldTurn()).toBe(false);

        const live = parked();
        live.host.pickUp.value = { reason: `outage`, held: { ran: true } };
        expect(await live.client.resumeHeldTurn()).toBe(false);
        expect(resume).not.toHaveBeenCalled();
    });
});

describe(`saying something`, () => {
    it(`hands words said while a turn runs to the daemon, drawing nothing: its steer row or its queue shows them`, async () => {
        const { client, host } = parked();
        answers({ delivered: `queued` }, { delivered: `steered`, run: `run-1` });

        await client.say(`and the docs too`, [FILE]);
        await client.say(`skip the changelog`);

        expect(run.mock.calls.map(([body]) => ({ prompt: body.prompt, attachments: body.attachments }))).toEqual([
            { prompt: `and the docs too`, attachments: [FILE.path] },
            { prompt: `skip the changelog`, attachments: undefined },
        ]);
        expect(host.transcript.messages.value.map((message) => message.text)).toEqual([`clean the sandbox`, ``]);
        expect(host.draft.value).toBe(``);
        expect(host.error.value).toBeNull();
    });

    // Another window's turn holds the conversation: the words went to the daemon, so the bubble drawn here goes, and
    // this window follows the turn that will carry them.
    it(`drops its own bubble for a send the daemon queued behind another turn, and follows that turn`, async () => {
        const { client, host } = clientOf();
        answers({ delivered: `queued` });
        attach.mockImplementation(async () => attached(`r-other`, 3_000, `the other window's ask`));

        await client.say(`and the docs too`);

        expect(attach).toHaveBeenCalledTimes(1);
        expect(host.transcript.messages.value.map((message) => message.text)).toEqual([`the other window's ask`]);
    });

    it(`sends a nudge behind a waiting nudge nowhere, and anything else as ever`, async () => {
        const { client, host } = parked();
        host.queue.value = { items: [{ id: `m-go`, text: `Continue`, voice: `person`, queuedAt: 1_000, revision: 1 }], revision: 1 };
        answers({ delivered: `queued` }, { delivered: `queued` });

        await client.say(`continue.`);
        await client.say(`Continue`, [FILE]);
        await client.say(`and the docs too`);

        expect(run.mock.calls.map(([body]) => body.prompt)).toEqual([`Continue`, `and the docs too`]);
    });

    it(`lets a held queue go when the nudge it holds is pressed again, rather than saying it twice`, async () => {
        const { client, host } = clientOf();
        host.queue.value = { items: [{ id: `m-go`, text: `Continue`, voice: `person`, queuedAt: 1_000, revision: 1 }], revision: 2, paused: `refused` };
        queueResume.mockImplementation(async () => ({ run: `r8` }));
        attach.mockImplementation(async () => attached(`r8`, 5_000, `Continue`));

        await client.say(`Continue`);

        expect(run).not.toHaveBeenCalled();
        expect(queueResume).toHaveBeenCalledTimes(1);
        expect(attach).toHaveBeenCalledTimes(1);
    });

    it(`lets the held queue go when nothing is typed, on the pick the composer holds now`, async () => {
        const { client, host } = clientOf();
        host.error.value = `The credential was revoked.`;
        queueResume.mockImplementation(async () => ({ run: `r9` }));
        attach.mockImplementation(async () => attached(`r9`, 6_000, `send me later`));

        await client.say(``);

        expect(queueResume.mock.calls).toEqual([
            [{ conversationId: `c1`, routing: { agent: `claude`, harness: `native`, account: undefined, model: `opus` } }, { context: { at: undefined } }],
        ]);
        expect(host.error.value).toBeNull();
        // The turn the queue started is followed here.
        expect(attach).toHaveBeenCalledTimes(1);
        expect(run).not.toHaveBeenCalled();
    });

    it(`tries a send nobody answered again under the same id, which the daemon answers rather than delivering twice`, async () => {
        const { client } = clientOf();
        run.mockImplementationOnce(async () => {
            throw new TypeError(`Failed to fetch`);
        });
        answers({ delivered: `started`, run: `r3`, duplicate: true });
        attach.mockImplementation(async () => attached(`r3`, 7_000, `tidy the docs`));

        await client.say(`tidy the docs`);

        const [first, second] = run.mock.calls.map(([body]) => body.messageId);
        expect(first).toEqual(expect.any(String));
        expect(second).toBe(first);
        expect(attach).toHaveBeenCalledTimes(1);
    });

    // A daemon that took the words after all while no answer came back recognises them when they are sent again unchanged.
    it(`gives words back to the composer under the id they went out with, which sending them again unchanged keeps`, async () => {
        const { client, host } = clientOf();
        run.mockImplementation(async () => {
            throw new TypeError(`Failed to fetch`);
        });

        await client.say(`tidy the docs`);
        expect(host.draft.value).toBe(`tidy the docs`);
        expect(host.error.value).toBe(`Failed to fetch Your message is back in the composer, send it again to deliver it.`);
        const sentAs = run.mock.calls.map(([body]) => body.messageId);
        expect(sentAs).toEqual([sentAs[0], sentAs[0], sentAs[0]]);

        run.mockReset();
        answers({ delivered: `started`, run: `r4`, duplicate: true });
        attach.mockImplementation(async () => attached(`r4`, 8_000, `tidy the docs`));
        await client.say(host.draft.value);

        expect(run.mock.calls.map(([body]) => body.messageId)).toEqual([sentAs[0]]);
    });
});

describe(`the queue's doors`, () => {
    it(`takes back or rewords a waiting message as this window read it, and keeps the queue the daemon answered with`, async () => {
        const { client, host } = clientOf();
        host.queue.value = WAITING;
        const [waiting] = WAITING.items;
        queueEdit.mockImplementation(async () => ({ items: [{ ...waiting!, text: `and the docs, briefly`, revision: 2 }], revision: 2 }));
        queueRemove.mockImplementation(async () => ({ items: [], revision: 3 }));

        expect(await client.reword(waiting!, `and the docs, briefly`)).toBe(true);
        expect(queueEdit.mock.calls[0]?.[0]).toEqual({ conversationId: `c1`, id: `m-wait`, revision: 1, text: `and the docs, briefly` });
        expect(host.queue.value).toEqual({ items: [{ ...waiting!, text: `and the docs, briefly`, revision: 2 }], revision: 2 });

        expect(await client.unqueue({ ...waiting!, revision: 2 })).toBe(true);
        expect(queueRemove.mock.calls[0]?.[0]).toEqual({ conversationId: `c1`, id: `m-wait`, revision: 2 });
        expect(host.queue.value).toEqual({ items: [], revision: 3 });
    });

    it(`says a change against an older copy was refused, and one to a message already gone`, async () => {
        const { client, host } = clientOf();
        host.queue.value = WAITING;
        const [waiting] = WAITING.items;
        queueRemove.mockImplementationOnce(async () => {
            throw new SandboxHttpError(412, `Changed since.`);
        });
        queueRemove.mockImplementationOnce(async () => {
            throw new SandboxHttpError(404, `Gone.`);
        });

        expect(await client.unqueue(waiting!)).toBe(false);
        expect(host.error.value).toBe(`That waiting message was changed in another window since you saw it: look again before changing it.`);
        expect(await client.unqueue(waiting!)).toBe(false);
        expect(host.error.value).toBe(`That message is no longer waiting: it has gone out, or somebody took it back.`);
        expect(host.queue.value).toBe(WAITING);
    });
});
