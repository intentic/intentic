import "@intentic/testing/dom";
import type { MessageReceipt } from "@intentic/sandbox-contract/schemas/agent";
import { ref } from "vue";
import * as actualSandboxRpc from "../../../client/sandbox/sandboxRpc";
import type { ProcedureInput } from "../../../client/sandbox/sandboxRpc";
import { fakeSandboxRpc } from "../../../testing/sandboxRpcFake";
import type { FreshLink } from "../run/turnRequest";

// Pins that a fresh session's origin rides the first send the sandbox takes and no later one, and that a refused send
// keeps it for the retry, so a press that failed never loses the link to the work it was opened on.

const run = jest.fn<(input: ProcedureInput<`agent.run`>) => Promise<MessageReceipt>>();
const realSandboxRpc = { ...actualSandboxRpc };
jest.mock(`../../../client/sandbox/sandboxRpc`, () => ({ ...realSandboxRpc, sandboxRpc: fakeSandboxRpc({ agent: { run } }) }));

const { postTurn } = await import("./turnPost");
const { SandboxHttpError } = await import("../../../client/sandbox/sandboxHttpError");

const ORIGIN: FreshLink = { conversationId: `origin`, kind: `review` };
const body = (messageId: string): ProcedureInput<`agent.run`> => ({ messageId, prompt: `/code-review `, conversationId: `fresh`, isolated: true });
const host = () => ({ box: ref<string | undefined>(), pendingFreshOf: ref<FreshLink | undefined>(ORIGIN) });

afterEach(() => run.mockReset());

describe(`a fresh session's first send`, () => {
    it(`carries its origin once, then never again`, async () => {
        run.mockResolvedValue({ delivered: `started`, run: `r1` });
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
    });
});
