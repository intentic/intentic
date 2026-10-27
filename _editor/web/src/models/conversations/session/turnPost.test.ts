import "@intentic/testing/dom";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import type { MessageReceipt } from "@intentic/sandbox-contract/schemas/agent";
import { ref } from "vue";
import { activeSandboxId } from "../../../app/storage/activeSandbox";
import { forgetEdgeVerdict, noteVerdict } from "../../../client/sandbox/edgeVerdict";
import * as actualSandboxRpc from "../../../client/sandbox/sandboxRpc";
import type { ProcedureInput } from "../../../client/sandbox/sandboxRpc";
import { fakeSandboxRpc } from "../../../testing/sandboxRpcFake";
import type { FreshLink } from "../run/turnRequest";

// Pins that a fresh session's origin rides the first send the sandbox takes and no later one, and that a refused send
// keeps it for the retry, so a press that failed never loses the link to the work it was opened on. And that a send the
// edge or netd refused before the daemon saw it is sent again under the same id for a bounded while, and nothing else is.

const run = jest.fn<(input: ProcedureInput<`agent.run`>) => Promise<MessageReceipt>>();
const realSandboxRpc = { ...actualSandboxRpc };
jest.mock(`../../../client/sandbox/sandboxRpc`, () => ({ ...realSandboxRpc, sandboxRpc: fakeSandboxRpc({ agent: { run } }) }));

const { postTurn } = await import("./turnPost");
const { SandboxHttpError } = await import("../../../client/sandbox/sandboxHttpError");

const BOX = `sbx-1`;
const ORIGIN: FreshLink = { conversationId: `origin`, kind: `review` };
const RECEIPT: MessageReceipt = { delivered: `started`, run: `r1` };
const body = (messageId: string): ProcedureInput<`agent.run`> => ({ messageId, prompt: `/code-review `, conversationId: `fresh`, isolated: true });
const host = (box?: string) => ({ box: ref<string | undefined>(box), pendingFreshOf: ref<FreshLink | undefined>(ORIGIN) });
// How each refusal reaches postTurn: the edge's and netd's are plain text, so they carry no words of the daemon's.
const edge502 = () => new SandboxHttpError(502, `Request failed (502).`);
const netdRestarting = () => new SandboxHttpError(503, `Request failed (503).`);
const daemon502 = () => new SandboxHttpError(502, `the model provider is down`, { message: `the model provider is down` });

afterEach(() => {
    run.mockReset();
    forgetEdgeVerdict();
    jest.useRealTimers();
});

describe(`a fresh session's first send`, () => {
    it(`carries its origin once, then never again`, async () => {
        run.mockResolvedValue(RECEIPT);
        const chat = host();
        await postTurn(chat, body(`m1`), new AbortController().signal);
        await postTurn(chat, body(`m2`), new AbortController().signal);
        expect(run.mock.calls.map(([input]) => input.freshOf)).toEqual([ORIGIN, undefined]);
        expect(chat.pendingFreshOf.value).toBeUndefined();
    });

    it(`keeps its origin when the sandbox refused the words`, async () => {
        run.mockRejectedValue(new SandboxHttpError(400, `the origin is archived`));
        const chat = host();
        const receipt = await postTurn(chat, body(`m1`), new AbortController().signal);
        expect(receipt).toBeInstanceOf(SandboxHttpError);
        expect(chat.pendingFreshOf.value).toEqual(ORIGIN);
        expect(run).toHaveBeenCalledTimes(1);
    });
});

describe(`a send refused before the daemon saw it`, () => {
    it.each([
        [`the edge lost it on a dying tunnel`, `dropped`, edge502],
        [`the edge held no tunnel for the sandbox`, `no-tunnel`, edge502],
    ] as const)(`goes again under the same id when %s`, async (_, verdict, refusal) => {
        jest.useFakeTimers();
        noteVerdict(BOX, verdict);
        run.mockRejectedValueOnce(refusal()).mockResolvedValue(RECEIPT);
        const chat = host(BOX);
        const sent = postTurn(chat, body(`m1`), new AbortController().signal);
        await advanceTimersByTimeAsync(1_000);
        expect(await sent).toEqual(RECEIPT);
        expect(run.mock.calls.map(([input]) => input.messageId)).toEqual([`m1`, `m1`]);
        expect(chat.pendingFreshOf.value).toBeUndefined();
    });

    it(`goes again while netd says the daemon is restarting`, async () => {
        jest.useFakeTimers();
        run.mockRejectedValueOnce(netdRestarting()).mockRejectedValueOnce(edge502()).mockResolvedValue(RECEIPT);
        const sent = postTurn(host(BOX), body(`m1`), new AbortController().signal);
        await advanceTimersByTimeAsync(3_000);
        expect(await sent).toEqual(RECEIPT);
        expect(run).toHaveBeenCalledTimes(3);
    });

    it(`gives up after 15 s of waiting, keeping the origin and returning the refusal`, async () => {
        jest.useFakeTimers();
        noteVerdict(BOX, `dropped`);
        run.mockImplementation(() => Promise.reject(edge502()));
        const chat = host(BOX);
        const sent = postTurn(chat, body(`m1`), new AbortController().signal);
        await advanceTimersByTimeAsync(14_999);
        expect(run).toHaveBeenCalledTimes(4);
        await advanceTimersByTimeAsync(1);
        const receipt = await sent;
        expect(receipt).toBeInstanceOf(SandboxHttpError);
        expect(run).toHaveBeenCalledTimes(5);
        expect(chat.pendingFreshOf.value).toEqual(ORIGIN);
    });

    it(`stops going again when the person stops it`, async () => {
        jest.useFakeTimers();
        run.mockRejectedValue(edge502());
        const stop = new AbortController();
        const sent = postTurn(host(BOX), body(`m1`), stop.signal);
        const settled = sent.catch((error: unknown) => error);
        await advanceTimersByTimeAsync(500);
        stop.abort(new DOMException(`stopped`, `AbortError`));
        expect(await settled).toMatchObject({ name: `AbortError` });
        expect(run).toHaveBeenCalledTimes(1);
    });
});

describe(`an answer that is not sent again`, () => {
    it(`is the daemon's own 502, in its words`, async () => {
        run.mockRejectedValue(daemon502());
        const receipt = await postTurn(host(BOX), body(`m1`), new AbortController().signal);
        expect(receipt).toMatchObject({ status: 502, said: { message: `the model provider is down` } });
        expect(run).toHaveBeenCalledTimes(1);
    });

    it(`is the edge saying the sandbox no longer exists, read under the active sandbox's id`, async () => {
        const before = activeSandboxId.value;
        activeSandboxId.value = `sbx-active`;
        try {
            noteVerdict(`sbx-active`, `unknown-sandbox`);
            run.mockRejectedValue(edge502());
            const receipt = await postTurn(host(), body(`m1`), new AbortController().signal);
            expect(receipt).toMatchObject({ status: 502 });
            expect(run).toHaveBeenCalledTimes(1);
        } finally {
            activeSandboxId.value = before;
        }
    });

    it(`is any other refusal`, async () => {
        run.mockRejectedValue(new SandboxHttpError(504, `Request failed (504).`));
        await postTurn(host(BOX), body(`m1`), new AbortController().signal);
        expect(run).toHaveBeenCalledTimes(1);
    });
});
