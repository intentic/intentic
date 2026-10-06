import { STATE_DIR } from "@intentic/constants";
import {
    type AttachFrame,
    type ConversationQueue,
    deriveTitle,
    LAND_CONFLICT_OPENING,
    type MessageReceipt,
    SANDBOX_ROUTE_NAMES,
    type TranscriptRow,
} from "@intentic/sandbox-contract";
import { userRow } from "@intentic/sandbox-contract/transcript-fold";
import { unstubbed } from "@intentic/testing";
import { AsyncIteratorClass } from "@orpc/client";
import { stubGlobal, unstubAllGlobals, waitFor } from "@intentic/testing/bun";
import { computed, ref, shallowRef, watch } from "vue";
import type { AgentStanding } from "../../agents/fleet/agentStatus";
import { SandboxHttpError } from "../../../client/sandbox/sandboxHttpError";
import type { SandboxRpc } from "../../../client/sandbox/sandboxRpc";
import { fakeSandboxRpc } from "../../../testing/sandboxRpcFake";
import { runningTurn } from "../../../testing/runningTurn";
import type { PendingAttachment } from "../drafts/useChatAttachments";
import type { PickUp } from "../run/pickUp";
import type { TurnFailures } from "../run/turnFailures";
import type { ForkLink, SessionRef, TurnSettings } from "../run/turnRequest";
import type { ChatMessage } from "../transcript/transcript";
import type { ComposerSelection } from "./composerSelection";
import { IDLE } from "./runPhase";
import type { PickAction, Selection } from "./selectionReducer";
import { setDaemonRoutes } from "../../../client/sandbox/useDaemonRoutes";
import { setLocale } from "@intentic/ui/i18n";

// One conversation's runs through their phases (runPhase.ts), and the doors into the daemon's queue they share, against
// a host that is nothing but the refs a run reads and writes and a daemon that is the procedures a run calls. Whole
// conversations against a modelled daemon are conversation.test.ts's.

const run = jest.fn<SandboxRpc["agent"]["run"]>();
const attach = jest.fn<SandboxRpc["agent"]["attach"]>();
const stop = jest.fn<SandboxRpc["agent"]["stop"]>();
const resume = jest.fn<SandboxRpc["agent"]["resume"]>();
const queueResume = jest.fn<SandboxRpc["agent"]["queueResume"]>();
const queueRemove = jest.fn<SandboxRpc["agent"]["queueRemove"]>();
const queueEdit = jest.fn<SandboxRpc["agent"]["queueEdit"]>();
const switchAccount = jest.fn<SandboxRpc["agent"]["switchAccount"]>();
const queueSchedule = jest.fn<SandboxRpc["agent"]["queueSchedule"]>();
jest.mock("../../../client/sandbox/sandboxRpc", () => ({
    sandboxRpc: fakeSandboxRpc({ agent: { run, attach, stop, resume, queueResume, queueRemove, queueEdit, switchAccount, queueSchedule } }),
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

// The same stream held open after its head until `closed` resolves: a turn still unwinding after a Stop.
const unwinding = (runId: string, startedAt: number, prompt: string, closed: Promise<void>): AsyncIteratorClass<AttachFrame, unknown, void> => {
    const rows: TranscriptRow[] = [{ ...userRow(prompt, startedAt, []), run: runId }];
    const frames: (() => Promise<AttachFrame>)[] = [async () => ({ kind: `attached`, run: runId, startedAt, seq: 0, rows }), async () => {
        await closed;
        return { kind: `end` };
    }];
    return new AsyncIteratorClass<AttachFrame, unknown, void>(
        async () => {
            const frame = frames.shift();
            return frame === undefined ? { done: true, value: undefined } : { done: false, value: await frame() };
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
const clientOf = (settings: TurnSettings = SETTINGS, selection: Partial<ComposerSelection> = {}) => {
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
            turnSettings: () => settings,
            apply: jest.fn(),
            mode: computed(() => `default` as const),
            provider: computed(() => `claude` as const),
            account: computed(() => undefined),
            harness: computed(() => `native` as const),
            ...selection,
        }),
        failures: unstubbed<TurnFailures>(`failures`, { cancelProbe: jest.fn(), clear: jest.fn(), armRenewalProbe: jest.fn(), settled: jest.fn() }),
        title: ref<string | null>(null),
        isolated: ref(true),
        runner: ref<string | undefined>(),
        box,
        registered: ref(false),
        standing: ref<AgentStanding | undefined>(),
        pendingForkOf: ref<ForkLink | undefined>(),
        error,
        pickUp: ref<PickUp | undefined>(),
        session,
        agentTerminal: ref<string | undefined>(),
        agentBrowser: ref<string | undefined>(),
        peek: ref(true),
        draft,
        attachments,
        queue: shallowRef<ConversationQueue | undefined>(),
        autoLandDraft: ref<boolean | undefined>(),
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
    for (const procedure of [run, attach, stop, resume, queueResume, queueRemove, queueEdit, queueSchedule]) {
        procedure.mockReset();
    }
});

describe(`a run's lifecycle`, () => {
    it(`opens a send, is taken at the daemon's ack, and settles as a run the daemon had`, async () => {
        const { client, host, phases } = clientOf();
        answers({ delivered: `started`, run: `r1` });
        attach.mockImplementation(async () => attached(`r1`, 4_000, `tidy the docs`));
        // Started by this window's own press, on this browser's clock: counted on it, never on the sandbox's.
        const onSandbox: boolean[] = [];
        watch(client.turnOnSandboxClock, (on) => void onSandbox.push(on), { flush: `sync` });

        await client.send(`tidy the docs`, SETTINGS);

        expect(onSandbox).toEqual([]);
        expect(client.turnOnSandboxClock.value).toBe(false);

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

    // An older sandbox refused a message to a busy conversation in English; the reader gets it in their own language.
    it(`says a refusal it knows in the reader's language, and hands the words back all the same`, async () => {
        run.mockImplementation(async () => {
            throw new SandboxHttpError(409, `a turn is already running for this conversation`);
        });
        const { client, host } = clientOf();
        await setLocale(`pl`);
        try {
            await client.send(`tidy the docs`, SETTINGS);
            expect(host.draft.value).toBe(`tidy the docs`);
            expect(host.error.value).toBe(`W tej rozmowie trwa już tura. Twoja wiadomość wróciła do pola wpisywania: wyślij ją ponownie, gdy to się wyjaśni.`);
        } finally {
            await setLocale(`en`);
        }
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
        // The second write is the press marking it ended, in the same frame, before the abort settles it.
        expect(phases).toEqual([`composing`, `composing`, `idle`]);
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

    // The row it opens names the errand, so it reads as the app's words and not the owner's, whatever the text says later.
    it(`names the errand its composed words are, by the contract's own reader`, async () => {
        const { client } = clientOf();
        answers({ delivered: `started`, run: `r3` });
        const prompt = `${LAND_CONFLICT_OPENING}\n\nroot: docs/a.md`;
        attach.mockImplementation(async () => attached(`r3`, 5_000, prompt));

        expect(await client.startErrand(`Resolving the conflict`, async () => prompt)).toBe(true);

        expect(run.mock.calls[0]?.[0]).toMatchObject({ prompt, errand: `land-conflict` });
    });

    it(`adopts a run the daemon already took, from its own start, and settles it as taken`, async () => {
        const { client, phases } = clientOf();
        const startedAt: (number | undefined)[] = [];
        watch(client.turnStartedAt, (at) => void startedAt.push(at), { flush: `sync` });
        // Its start is the daemon's own stamp: an elapsed count runs on the sandbox's clock, not this browser's.
        const onSandbox: boolean[] = [];
        watch(client.turnOnSandboxClock, (on) => void onSandbox.push(on), { flush: `sync` });
        attach.mockImplementation(async () => attached(`r7`, 9_000, `carry on`));

        expect(await client.reattach()).toBe(true);

        expect(phases).toEqual([`running`, `idle`]);
        expect(startedAt).toEqual([9_000, undefined]);
        expect(onSandbox).toEqual([true, false]);
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

    // Stopping a parked turn takes its card with it, as the daemon records it: nothing may still offer an answer to it.
    it(`freezes the card a stopped turn was parked on at the press`, () => {
        const { client, host } = parked();
        stop.mockImplementation(async () => ({ stopped: true }));

        client.stop();

        expect(host.transcript.awaitingDecision.value).toBe(false);
        expect(host.transcript.messages.value[1]?.permission?.status).not.toBe(`pending`);
    });

    // The press is the ending, for everyone looking: the turn reads as ended in the frame it was pressed, long before
    // the daemon has unwound it and its stream closes. Words typed meanwhile are the next turn's, never said into the
    // one ending (the daemon would hold them behind the stop), so they wait for it to close and go as a turn of their own.
    it(`reads a stopped turn as ended from the press, and sends words typed after it as the next turn once it closes`, async () => {
        const { client, phases } = clientOf();
        let close: () => void = () => undefined;
        const closed = new Promise<void>((settle) => (close = settle));
        answers({ delivered: `started`, run: `r1` }, { delivered: `started`, run: `r2` });
        attach.mockImplementationOnce(async () => unwinding(`r1`, 4_000, `clean the sandbox`, closed));
        attach.mockImplementation(async () => attached(`r2`, 5_000, `try again`));
        stop.mockImplementation(async () => ({ stopped: true }));
        const first = client.send(`clean the sandbox`, SETTINGS);
        await waitFor(() => expect(client.phase.value.kind).toBe(`running`));

        client.stop();
        expect(client.ending.value).toBe(`stop`);
        expect(client.streaming.value).toBe(true);
        expect(client.generating.value).toBe(false);
        // Pressed again while it unwinds, it asks the daemon nothing more.
        client.stop();
        expect(stop).toHaveBeenCalledTimes(1);

        const next = client.say(`try again`);
        await new Promise((settle) => setTimeout(settle, 0));
        expect(run).toHaveBeenCalledTimes(1);

        close();
        await first;
        await next;
        expect(run.mock.calls.map(([body]) => body.prompt)).toEqual([`clean the sandbox`, `try again`]);
        expect(phases).toEqual([`sending`, `running`, `running`, `idle`, `sending`, `running`, `idle`]);
        expect(client.ending.value).toBeUndefined();
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

    // A first turn's ack can take a while (its worktree is made first): a Stop pressed before it still leaves a way back
    // once the ack says the daemon took the turn.
    it(`arms the way back for a send stopped before its ack, once the ack says the daemon took it`, async () => {
        const { client, host } = clientOf();
        let ack: ((receipt: MessageReceipt) => void) | undefined;
        run.mockImplementation(() => new Promise((resolve) => (ack = resolve)));
        stop.mockImplementation(async () => ({ stopped: true }));
        attach.mockImplementation(async () => attached(`r6`, 6_000, `explore android`));
        const sending = client.send(`explore android`, SETTINGS);
        await Promise.resolve();

        client.stop();
        expect(host.pickUp.value).toBeUndefined();
        ack?.({ delivered: `started`, run: `r6` });
        await sending;

        expect(host.pickUp.value).toEqual({ reason: `stopped` });
    });

    it(`stops nothing when nothing runs, and arms no way back for a turn the daemon never took`, () => {
        const { client, host } = clientOf();

        client.stop();
        expect(host.pickUp.value).toBeUndefined();

        client.endedByReader(`dismiss`);
        expect(host.pickUp.value).toBeUndefined();
    });

    it(`sees each tool card first once per turn`, () => {
        const { client } = clientOf();

        expect(client.firstSight(`t1`)).toBe(true);
        expect(client.firstSight(`t1`)).toBe(false);
        expect(client.firstSight(`t2`)).toBe(true);
    });

    // The composer's account follows the daemon's session (bindSession), so a plain Continue on it names none and keeps
    // the session. One that differs is a pick the daemon has not taken yet (refused while a turn ran), and the press
    // names it, as intent, like a send would.
    it(`presses Continue naming no account on the one the conversation runs on, and a pick that leaves it`, async () => {
        const session: SessionRef = { id: `s-1`, provider: `claude`, account: `acct-now`, harness: `native` };
        resume.mockImplementation(async () => ({ run: `r-press` }));
        attach.mockImplementation(async () => attached(`r-press`, 4_000, `clean the sandbox`));

        const bound = clientOf({ ...SETTINGS, account: `acct-now` });
        bound.host.session.value = session;
        bound.host.pickUp.value = { reason: `limit`, held: { ran: true } };
        expect(await bound.client.resumeHeldTurn()).toBe(true);
        expect(resume.mock.calls.at(-1)?.[0]).toEqual({
            conversationId: `c1`,
            routing: { agent: `claude`, harness: `native`, model: `opus` },
        });
        expect(bound.host.session.value).toEqual(session);

        const picked = clientOf({ ...SETTINGS, account: `acct-other` });
        picked.host.session.value = session;
        picked.host.pickUp.value = { reason: `limit`, held: { ran: true } };
        expect(await picked.client.resumeHeldTurn({ carry: true })).toBe(true);
        expect(resume.mock.calls.at(-1)?.[0]).toEqual({
            conversationId: `c1`,
            routing: { agent: `claude`, harness: `native`, account: `acct-other`, model: `opus`, carry: true },
        });
    });

    // A pick on a conversation the daemon holds is a move (switchAccount). A sandbox too old for the route is asked
    // nothing: no request that would 404, and the picker's notice says it needs an update.
    it(`moves a conversation the daemon holds, and asks a sandbox too old for the move nothing`, () => {
        switchAccount.mockReset();
        switchAccount.mockImplementation(async () => ({}));
        const { client, host } = clientOf();
        host.registered.value = true;

        setDaemonRoutes(SANDBOX_ROUTE_NAMES.filter((name) => name !== `agent.switchAccount`));
        client.moveAccount(`acct-other`);
        expect(switchAccount).not.toHaveBeenCalled();

        setDaemonRoutes([...SANDBOX_ROUTE_NAMES]);
        client.moveAccount(`acct-other`);
        expect(switchAccount.mock.calls.map(([input]) => input)).toEqual([{ conversationId: `c1`, account: `acct-other` }]);
        setDaemonRoutes(undefined);
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

    // A scheduled send opens no turn: no bubble, no working line, nothing followed. The words are the queue's, drawn at
    // the ack as scheduled, until the daemon's own queue (the same revision) replaces them.
    it(`books a scheduled send into the queue, drawing no turn`, async () => {
        const { client, host } = clientOf();
        host.registered.value = true;
        answers({ delivered: `queued` });
        const at = Date.now() + 60 * 60 * 1_000;

        await client.schedule(`ship it`, { sendAt: at }, [FILE]);

        expect(run.mock.calls.map(([body]) => ({ prompt: body.prompt, sendAt: body.sendAt }))).toEqual([{ prompt: `ship it`, sendAt: at }]);
        expect(attach).not.toHaveBeenCalled();
        expect(client.streaming.value).toBe(false);
        expect(host.transcript.messages.value).toEqual([]);
        expect(host.queue.value).toMatchObject({
            items: [{ text: `ship it`, attachments: [FILE.path], voice: `person`, revision: 1, until: at }],
            revision: 1,
            paused: `scheduled`,
            until: at,
        });
    });

    // The booking opens a chat the daemon has no record of yet: it comes back on the board as scheduled, named after its
    // words, with its own answer to whether its work lands by itself; nothing starts here.
    it(`books a message that opens its chat, carrying the chat's own landing answer, drawing no turn`, async () => {
        const { client, host } = clientOf();
        host.autoLandDraft.value = true;
        answers({ delivered: `queued` });

        await client.schedule(`ship it after the auth refactor`, { sendAfter: `brave-otter` });

        expect(run.mock.calls.map(([body]) => ({ sendAt: body.sendAt, sendAfter: body.sendAfter, conversationAutoLand: body.conversationAutoLand }))).toEqual([
            { sendAt: undefined, sendAfter: `brave-otter`, conversationAutoLand: true },
        ]);
        expect(attach).not.toHaveBeenCalled();
        expect(host.title.value).toBe(deriveTitle(`ship it after the auth refactor`));
        expect(host.queue.value).toMatchObject({ items: [{ text: `ship it after the auth refactor`, after: `brave-otter` }], paused: `scheduled`, after: `brave-otter` });
        expect(host.queue.value).not.toHaveProperty(`until`);
        expect(host.queue.value?.items[0]).not.toHaveProperty(`until`);
    });

    // A sandbox from before bookings could open a chat has nothing to hold one on: it goes the ordinary way, drawn as any send is.
    it(`sends a scheduled message the ordinary way to a sandbox that cannot hold it`, async () => {
        const { client } = clientOf();
        answers({ delivered: `queued` });
        setDaemonRoutes(SANDBOX_ROUTE_NAMES.filter((name) => name !== `agent.queueSchedule`));

        await client.schedule(`ship it`, { sendAt: Date.now() + 60_000 });
        setDaemonRoutes(undefined);

        expect(run.mock.calls.map(([body]) => body.sendAt)).toEqual([undefined]);
    });

    // A queue booked as a whole: what a sandbox older than per-message bookings holds, re-timed whole as it always was.
    it(`re-times what waits through the queue's own door, and follows a turn it let go at once`, async () => {
        const { client, host } = clientOf();
        host.queue.value = { ...WAITING, paused: `scheduled`, until: Date.now() + 60_000 };
        queueSchedule.mockImplementationOnce(async () => ({ ...WAITING, revision: 2, paused: `scheduled` as const, after: `brave-otter` }));

        expect(await client.reschedule({ sendAfter: `brave-otter` })).toBe(true);
        expect(queueSchedule.mock.calls.map(([input]) => input)).toEqual([{ conversationId: `c1`, sendAfter: `brave-otter` }]);
        expect(host.queue.value).toMatchObject({ revision: 2, paused: `scheduled`, after: `brave-otter` });
        expect(attach).not.toHaveBeenCalled();

        // What it waited for had already come: the queue comes back empty and the turn it started is followed.
        queueSchedule.mockImplementationOnce(async () => ({ items: [], revision: 3 }));
        attach.mockImplementation(async () => attached(`r9`, 6_000, `and the docs`));
        expect(await client.reschedule({ sendAt: Date.now() - 1 })).toBe(true);
        expect(attach).toHaveBeenCalledTimes(1);
    });

    // Each message carries its own booking (2026-10-06): the queue once held one, so a second booking re-timed the first.
    // This window's mirror at the ack books the new message alone, as the daemon does, and reads the soonest for the queue.
    it(`books a second scheduled send on its own time, leaving the first on its own`, async () => {
        const { client, host } = clientOf();
        host.registered.value = true;
        answers({ delivered: `queued` }, { delivered: `queued` });
        const soon = Date.now() + 60 * 60 * 1_000;
        const late = soon + 24 * 60 * 60 * 1_000;

        await client.schedule(`do the thing`, { sendAt: soon });
        await client.schedule(`second thing`, { sendAt: late });

        expect(host.queue.value?.items.map(({ text, until }) => ({ text, until }))).toEqual([
            { text: `do the thing`, until: soon },
            { text: `second thing`, until: late },
        ]);
        expect(host.queue.value).toMatchObject({ paused: `scheduled`, until: soon });
    });

    // A sandbox that books each message names them in Change and Send now; an older one would act on the whole queue
    // whatever it was sent, so it is sent no ids, and nothing it did not do is promised.
    it(`names the messages a re-time or a release acts on, only to a sandbox that books each message on its own`, async () => {
        const { client, host } = clientOf();
        const at = Date.now() + 60 * 60 * 1_000;
        const perMessage: ConversationQueue = {
            items: [
                { id: `m-a`, text: `write the guide`, voice: `person`, queuedAt: 1_000, revision: 1, until: at },
                { id: `m-b`, text: `then tag it`, voice: `person`, queuedAt: 1_000, revision: 2, until: at + 1_000 },
            ],
            revision: 2,
            paused: `scheduled`,
            until: at,
        };
        host.queue.value = perMessage;
        queueSchedule.mockImplementation(async () => ({ ...perMessage, revision: 3 }));
        queueResume.mockImplementation(async () => ({}));

        await client.reschedule({ sendAt: at + 5_000 }, [`m-a`]);
        await client.resume([`m-b`]);

        expect(queueSchedule.mock.calls.map(([input]) => input)).toEqual([{ conversationId: `c1`, sendAt: at + 5_000, ids: [`m-a`] }]);
        expect(queueResume.mock.calls.map(([input]) => input.ids)).toEqual([[`m-b`]]);

        queueSchedule.mockClear();
        queueResume.mockClear();
        const legacy: ConversationQueue = { ...WAITING, paused: `scheduled`, until: at };
        host.queue.value = legacy;
        queueSchedule.mockImplementation(async () => ({ ...legacy, revision: 2, until: at + 5_000 }));
        await client.reschedule({ sendAt: at + 5_000 }, [`m-wait`]);
        await client.resume([`m-wait`]);

        expect(queueSchedule.mock.calls.map(([input]) => input)).toEqual([{ conversationId: `c1`, sendAt: at + 5_000 }]);
        expect(queueResume.mock.calls.map(([input]) => Object.keys(input).toSorted())).toEqual([[`conversationId`, `routing`]]);
    });

    // Resume answers a Stop or a refusal: what it held goes, and a message booked for later stays on its time.
    it(`lets a stop's hold go without the bookings beside it, naming only the messages it held`, async () => {
        const { client, host } = clientOf();
        const at = Date.now() + 60 * 60 * 1_000;
        host.queue.value = {
            items: [
                { id: `m-held`, text: `and the docs`, voice: `person`, queuedAt: 1_000, revision: 1 },
                { id: `m-later`, text: `then tag it`, voice: `person`, queuedAt: 1_000, revision: 2, until: at },
            ],
            revision: 3,
            paused: `stopped`,
        };
        queueResume.mockImplementation(async () => ({}));

        await client.resume();

        expect(queueResume.mock.calls.map(([input]) => input.ids)).toEqual([[`m-held`]]);
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
        host.queue.value = {
            items: [{ id: `m-go`, text: `Continue`, voice: `person`, queuedAt: 1_000, revision: 1 }],
            revision: 2,
            paused: `refused`,
        };
        queueResume.mockImplementation(async () => ({ run: `r8` }));
        attach.mockImplementation(async () => attached(`r8`, 5_000, `Continue`));

        await client.say(`Continue`);

        expect(run).not.toHaveBeenCalled();
        expect(queueResume).toHaveBeenCalledTimes(1);
        expect(attach).toHaveBeenCalledTimes(1);
    });

    // A busy sandbox's roster frames can lag the turn's own stream by many seconds. The press's answer says what the queue
    // left, so this window never draws the message it just sent as still held beneath the turn that is running it.
    it(`takes the queue the press left from its answer, not from a roster that has not caught up`, async () => {
        const { client, host } = clientOf();
        host.queue.value = {
            items: [{ id: `m-held`, text: `look at this`, voice: `person`, queuedAt: 1_000, revision: 1 }],
            revision: 2,
            paused: `refused`,
        };
        queueResume.mockImplementation(async () => ({ run: `r10`, queue: { items: [], revision: 4 } }));
        attach.mockImplementation(async () => attached(`r10`, 7_000, `look at this`));

        await client.resume();

        expect(host.queue.value).toEqual({ items: [], revision: 4 });
    });

    it(`lets the held queue go when nothing is typed, on the pick the composer holds now`, async () => {
        const { client, host } = clientOf();
        host.error.value = `The credential was revoked.`;
        queueResume.mockImplementation(async () => ({ run: `r9` }));
        attach.mockImplementation(async () => attached(`r9`, 6_000, `send me later`));

        await client.say(``);

        expect(queueResume.mock.calls).toEqual([
            [
                { conversationId: `c1`, routing: { agent: `claude`, harness: `native`, account: undefined, model: `opus` } },
                { context: { at: undefined } },
            ],
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

// A hand pick of an account is this window's until a turn runs on it: the daemon refuses to move a conversation a turn
// holds (one parked on a card included), and every press after the pick has to name it until one of them runs there.
describe(`an account picked by hand`, () => {
    const PICKED: TurnSettings = { ...SETTINGS, account: `acct-b`, accountPicked: true };
    const ON_A: SessionRef = { id: `s-1`, provider: `claude`, account: `acct-a`, harness: `native` };
    // A client over a selection whose picks it records, and what it told that selection about the pick: that a turn
    // naming it ran.
    const pickedClient = (settings: TurnSettings, selection: Partial<ComposerSelection> = {}) => {
        const apply = jest.fn<(action: PickAction) => void>();
        const made = clientOf(settings, { apply, ...selection });
        const taken = (): PickAction[] => apply.mock.calls.map(([action]) => action).filter((action) => action.kind === `accountTaken`);
        return { ...made, taken };
    };

    // Words queued behind a card go into the parked turn once it is answered, on that turn's account: nothing ran there.
    it(`is spent by a turn that starts naming it, never by words that only wait behind another`, async () => {
        const queued = pickedClient(PICKED);
        answers({ delivered: `queued` });
        attach.mockImplementation(async () => attached(`r-other`, 3_000, `the parked ask`));
        await queued.client.say(`and the docs too`);
        expect(run.mock.calls.at(-1)?.[0].account).toBe(`acct-b`);
        expect(queued.taken()).toEqual([]);

        const started = pickedClient(PICKED);
        answers({ delivered: `started`, run: `r1` });
        attach.mockImplementation(async () => attached(`r1`, 4_000, `tidy the docs`));
        await started.client.say(`tidy the docs`);
        expect(started.taken()).toEqual([{ kind: `accountTaken`, account: `acct-b` }]);
    });

    // A kept turn re-runs on the account it was started on, which wins over a move (turn-resume.ts), so the press names
    // the pick, as Continue does for a held turn. Without one, it runs as it was started.
    it(`sends a kept turn again on a pick no turn has run on, and as it was started otherwise`, async () => {
        resume.mockImplementation(async () => ({ run: `r-kept` }));
        attach.mockImplementation(async () => attached(`r-kept`, 4_000, `fix the pipeline`));

        const picked = pickedClient(PICKED);
        picked.host.session.value = ON_A;
        await picked.client.resendKept({ text: `fix the pipeline`, attachments: [] });
        expect(resume.mock.calls.at(-1)?.[0]).toEqual({
            conversationId: `c1`,
            routing: { agent: `claude`, harness: `native`, account: `acct-b`, model: `opus` },
        });
        expect(picked.taken()).toEqual([{ kind: `accountTaken`, account: `acct-b` }]);

        const unpicked = clientOf({ ...SETTINGS, account: `acct-a` });
        unpicked.host.session.value = ON_A;
        await unpicked.client.resendKept({ text: `fix the pipeline`, attachments: [] });
        expect(resume.mock.calls.at(-1)?.[0]).toEqual({ conversationId: `c1` });
        expect(run).not.toHaveBeenCalled();
    });

    // A re-run another press already started (409) went out on that press's routing, not this one's.
    it(`is not spent by a Continue whose held turn somebody else already re-ran`, async () => {
        resume.mockImplementation(async () => {
            throw new SandboxHttpError(409, `a turn is already running in that conversation`);
        });
        attach.mockImplementation(async () => attached(`r-theirs`, 4_000, `clean the sandbox`));
        const { client, host, taken } = pickedClient(PICKED);
        host.pickUp.value = { reason: `limit`, held: { ran: true } };

        expect(await client.resumeHeldTurn()).toBe(true);
        expect(taken()).toEqual([]);
    });

    // Refused while a card held the conversation, the move is asked again as that turn settles, so what the daemon does
    // by itself from then on (a booked re-run, a wake) goes to the pick too, not only this window's presses.
    it(`asks the daemon again for a move it refused while a turn held the conversation, once that turn settles`, async () => {
        switchAccount.mockReset();
        switchAccount.mockImplementationOnce(async () => {
            throw new SandboxHttpError(409, `a turn is running in that conversation: move it once the turn ends`);
        });
        switchAccount.mockImplementation(async () => ({}));
        const { client, host } = clientOf(PICKED, {
            state: shallowRef({ accountPicked: true } as Selection),
            account: computed(() => `acct-b`),
        });
        host.registered.value = true;

        client.moveAccount(`acct-b`);
        await waitFor(() => expect(switchAccount).toHaveBeenCalledTimes(1));
        await new Promise((settled) => setTimeout(settled, 0));
        attach.mockImplementation(async () => attached(`r-parked`, 4_000, `clean the sandbox`));
        await client.reattach();

        expect(switchAccount.mock.calls.map(([input]) => input)).toEqual([
            { conversationId: `c1`, account: `acct-b` },
            { conversationId: `c1`, account: `acct-b` },
        ]);
        // Taken the second time: the settle after asks nothing more.
        attach.mockImplementation(async () => attached(`r-next`, 5_000, `and then`));
        await client.reattach();
        expect(switchAccount).toHaveBeenCalledTimes(2);
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
