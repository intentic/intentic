import { STATE_DIR } from "@intentic/constants";
import { type AttachFrame, deriveTitle, type TranscriptRow } from "@intentic/sandbox-contract";
import { userRow } from "@intentic/sandbox-contract/transcript-fold";
import { unstubbed } from "@intentic/testing";
import { AsyncIteratorClass } from "@orpc/client";
import { hoisted, stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { computed, ref, watch } from "vue";
import type { AgentStanding } from "../../agents/fleet/agentStatus";
import { SandboxHttpError } from "../../sandbox/client/sandboxHttpError";
import type { SandboxRpc } from "../../sandbox/client/sandboxRpc";
import { fakeSandboxRpc } from "../../../testing/sandboxRpcFake";
import { runningTurn } from "../../../testing/runningTurn";
import type { PickUp } from "../run/pickUp";
import type { TurnFailures } from "../run/turnFailures";
import type { SessionRef, TurnSettings } from "../run/turnRequest";
import type { ChatMessage } from "../transcript/transcript";
import type { ComposerSelection } from "./composerSelection";
import { IDLE } from "./runPhase";

// One conversation's runs through their phases (runPhase.ts), and the queue they share, against a host that is nothing
// but the refs a run reads and writes and a daemon that is the four procedures a run calls. Whole conversations against
// a modelled daemon are conversation.test.ts's.

const { run, attach, stop, resume } = hoisted(() => ({
    run: mock<SandboxRpc["agent"]["run"]>(),
    attach: mock<SandboxRpc["agent"]["attach"]>(),
    stop: mock<SandboxRpc["agent"]["stop"]>(),
    resume: mock<SandboxRpc["agent"]["resume"]>(),
}));
mock.module("../../sandbox/client/sandboxRpc", () => ({ sandboxRpc: fakeSandboxRpc({ agent: { run, attach, stop, resume } }) }));

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

// A TurnClient over a conversation that is only its refs: the transcript is a real one, since a run's rows are drawn
// there; the selection and the failure policy answer only what a run asks of them.
const clientOf = () => {
    const error = ref<string | null>(null);
    const session = ref<SessionRef | undefined>();
    const box = ref<string | undefined>();
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
    };
    const client = new TurnClient(host);
    const transcript = new TranscriptView(() => undefined, {
        conversationId: `c1`,
        box,
        draft: ref(``),
        attachments: ref([]),
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

// A client whose turn is live and parked on a permission card: words sent now wait, and nothing is steered.
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
const texts = (client: InstanceType<typeof TurnClient>): string[] => client.queued.value.map((message) => message.text);

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
    run.mockReset();
    attach.mockReset();
    stop.mockReset();
    resume.mockReset();
});

describe(`a run's lifecycle`, () => {
    it(`opens a send, is taken at the daemon's ack, and settles as a run the daemon had`, async () => {
        const { client, host, phases } = clientOf();
        run.mockImplementation(async () => ({ run: `r1` }));
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

    it(`settles a send the door refused as never taken, with its words back in the queue`, async () => {
        const { client, host, phases } = clientOf();

        await client.send(`tidy the docs`, SETTINGS);

        expect(phases).toEqual([`sending`, `idle`]);
        expect(client.phase.value).toEqual(IDLE);
        expect(texts(client)).toEqual([`tidy the docs`]);
        expect(host.transcript.messages.value).toEqual([]);
        expect(host.error.value).toBe(`${REFUSAL} Your message is held below: send it again once that's sorted.`);
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
        run.mockImplementation(async () => ({ run: `r2` }));
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

    it(`arms the way back when the reader stops a run the daemon took, and asks the daemon to stop it`, () => {
        const { client, host } = clientOf();
        stop.mockImplementation(async () => ({ ok: true }));
        runningTurn(client, 4_000);

        client.stop();

        expect(host.pickUp.value).toEqual({ reason: `stopped` });
        expect(stop.mock.calls[0]?.[0]).toEqual({ conversationId: `c1` });
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

describe(`the queue`, () => {
    it(`holds words sent behind a parked card, collapsing a repeated nudge and nothing else`, async () => {
        const { client } = parked();

        await client.enqueue(`Continue`);
        await client.enqueue(`continue.`);
        await client.enqueue(`and the docs too`);
        // A nudge behind real words says something again; one with a file is new material.
        await client.enqueue(`Continue`);
        await client.enqueue(`Continue`, [FILE]);

        expect(texts(client)).toEqual([`Continue`, `and the docs too`, `Continue`, `Continue`]);
        expect(client.queued.value.at(-1)?.attachments).toEqual([FILE]);
        expect(run).not.toHaveBeenCalled();
    });

    it(`drops only the message whose chip was closed`, async () => {
        const { client } = parked();
        await client.enqueue(`one`);
        await client.enqueue(`two`);

        client.removeQueued(client.queued.value[0]!.id);

        expect(texts(client)).toEqual([`two`]);
    });

    it(`hands refused words back to the front once per turn, and a nudge already waiting is not doubled`, async () => {
        const { client } = parked();
        await client.enqueue(`later`);

        client.requeueUndelivered({ text: `the refused one`, attachments: [] });
        client.requeueUndelivered({ text: `the refused one`, attachments: [] });
        expect(texts(client)).toEqual([`the refused one`, `later`]);

        const nudged = parked().client;
        await nudged.enqueue(`Continue`);
        nudged.requeueUndelivered({ text: `continue`, attachments: [] });
        expect(texts(nudged)).toEqual([`Continue`]);
    });

    it(`keeps a held queue from going out until a resume releases it, clearing the red line`, async () => {
        const { client, host } = clientOf();
        client.queued.value = [{ id: `q1`, text: `send me later`, attachments: [] }];
        client.hold();
        host.error.value = `The credential was revoked.`;

        await client.drainQueue();
        expect(run).not.toHaveBeenCalled();

        await client.resume();
        expect(run).toHaveBeenCalledTimes(1);
        expect(run.mock.calls[0]?.[0]).toMatchObject({ conversationId: `c1`, prompt: `send me later` });
        // Refused at the door: the words never left, so they are still where a resend reads them, held again.
        expect(texts(client)).toEqual([`send me later`]);
        expect(host.transcript.messages.value).toEqual([]);
        expect(host.error.value).toBe(`${REFUSAL} Your message is held below: send it again once that's sorted.`);
    });
});
