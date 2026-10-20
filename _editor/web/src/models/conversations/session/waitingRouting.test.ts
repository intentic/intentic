import { SANDBOX_ROUTE_NAMES } from "@intentic/sandbox-contract";
import type { ContextUsage } from "@intentic/sandbox-contract/events/requests";
import type { TurnFact } from "@intentic/sandbox-contract/events/agent-events";
import type { ConversationQueue, QueuedMessage } from "@intentic/sandbox-contract/schemas/agent";
import { unstubbed } from "@intentic/testing";
import { waitFor } from "@intentic/testing/bun";
import { computed, reactive, ref, shallowRef } from "vue";
import { SandboxHttpError } from "../../../client/sandbox/sandboxHttpError";
import type { SandboxRpc } from "../../../client/sandbox/sandboxRpc";
import { setDaemonRoutes } from "../../../client/sandbox/useDaemonRoutes";
import { fakeSandboxRpc } from "../../../testing/sandboxRpcFake";
import { turnDefaults } from "../run/turnDefaults";
import type { SessionRef } from "../run/turnRequest";
import { movedByPick, servedApart } from "./waitingRouting";

// Pins where a person's waiting words go against the composer's pick: what counts as somewhere else, and that a pick
// moves them (agent.queueReroute) rather than leaving them to go by themselves on the pick they were sent under, which is
// what they did until 2026-10-20 under a divider naming the new pick.

const queueReroute = jest.fn<SandboxRpc["agent"]["queueReroute"]>();
jest.mock("../../../client/sandbox/sandboxRpc", () => ({ sandboxRpc: fakeSandboxRpc({ agent: { queueReroute } }) }));

const { followPick } = await import("./queueCalls");
const { ComposerSelection } = await import("./composerSelection");
const { TranscriptView } = await import("./transcriptView");

const words = (id: string, over: Partial<QueuedMessage> = {}): QueuedMessage => ({
    id,
    text: `words ${id}`,
    voice: `person`,
    queuedAt: 0,
    revision: 1,
    serves: { agent: `claude`, harness: `native`, model: `opus`, effort: `high`, account: `pro` },
    ...over,
});
const queueOf = (...items: QueuedMessage[]): ConversationQueue => ({ items, revision: 1 });
const CLAUDE_OPUS = { agent: `claude`, harness: `native`, model: `opus` } as const;

afterEach(() => {
    queueReroute.mockReset();
    setDaemonRoutes(undefined);
});

describe(`where waiting words go against the pick`, () => {
    it(`names what differs: the runtime, then the model, then an account the pick names, and nothing it leaves unnamed`, () => {
        const serves = { agent: `claude`, harness: `native`, model: `opus`, account: `pro` } as const;
        expect(servedApart(serves, CLAUDE_OPUS)).toBeUndefined();
        expect(servedApart(serves, { agent: `codex`, harness: `native`, model: `gpt-6` })).toBe(`runtime`);
        // Another loop for the same provider is another runtime; `native` and the default loop named outright are one.
        const codex = { agent: `codex`, harness: `native`, model: `gpt-6` } as const;
        expect(servedApart(codex, { ...codex, harness: `opencode` })).toBe(`runtime`);
        expect(servedApart(codex, { ...codex, harness: `codex` })).toBeUndefined();
        expect(servedApart(serves, { ...CLAUDE_OPUS, model: `sonnet` })).toBe(`model`);
        expect(servedApart(serves, { ...CLAUDE_OPUS, account: `max` })).toBe(`account`);
        // A pick before the catalog loads names no model, and the daemon's own account names none: neither is a move.
        expect(servedApart(serves, { agent: `claude`, harness: `native` })).toBeUndefined();
    });

    it(`moves only a person's words served elsewhere, among those named, the effort included`, () => {
        const queue = queueOf(words(`m1`), words(`m2`, { serves: { agent: `codex`, harness: `native` } }), words(`w1`, { voice: `sandbox`, serves: undefined }));
        expect(movedByPick(queue, { ...CLAUDE_OPUS, effort: `high` }).map((item) => item.id)).toEqual([`m2`]);
        expect(movedByPick(queue, { ...CLAUDE_OPUS, effort: `low` }).map((item) => item.id)).toEqual([`m1`, `m2`]);
        expect(movedByPick(queue, { ...CLAUDE_OPUS, effort: `low` }, [`m1`]).map((item) => item.id)).toEqual([`m1`]);
        // A sandbox older than `serves` says nothing about where they go, so nothing is moved.
        expect(movedByPick(queueOf(words(`m1`, { serves: undefined })), { agent: `codex`, harness: `native` })).toEqual([]);
    });
});

describe(`a pick moves the words already waiting`, () => {
    const chatOf = (queue: ConversationQueue | undefined) => ({
        conversationId: `c-1`,
        error: ref<string | null>(null),
        box: ref<string | undefined>(),
        queue: shallowRef<ConversationQueue | undefined>(queue),
    });

    it(`asks the sandbox to move the words served elsewhere, and draws the queue it answers with`, async () => {
        const chat = chatOf(queueOf(words(`m1`), words(`m2`, { serves: { ...CLAUDE_OPUS, account: `pro` } })));
        const moved = queueOf(words(`m1`, { serves: { agent: `claude`, harness: `native`, model: `sonnet` }, revision: 2 }));
        queueReroute.mockImplementationOnce(async () => ({ ...moved, revision: 2 }));

        expect(await followPick(chat, { ...CLAUDE_OPUS, model: `sonnet` })).toBe(true);
        expect(queueReroute.mock.calls.map(([input]) => input)).toEqual([
            { conversationId: `c-1`, routing: { ...CLAUDE_OPUS, model: `sonnet` }, ids: [`m1`, `m2`] },
        ]);
        expect(chat.queue.value?.revision).toBe(2);
    });

    it(`asks nothing when nothing would move, or of a sandbox that cannot move them`, async () => {
        const chat = chatOf(queueOf(words(`m1`)));
        expect(await followPick(chat, { ...CLAUDE_OPUS, effort: `high` })).toBe(false);
        setDaemonRoutes(SANDBOX_ROUTE_NAMES.filter((name) => name !== `agent.queueReroute`));
        expect(await followPick(chat, { agent: `codex`, harness: `native` })).toBe(false);
        expect(queueReroute).not.toHaveBeenCalled();
    });

    it(`says a refusal on the error line, and nothing for words that went out meanwhile`, async () => {
        const chat = chatOf(queueOf(words(`m1`)));
        queueReroute.mockImplementationOnce(async () => {
            throw new SandboxHttpError(404, `gone`);
        });
        expect(await followPick(chat, { agent: `codex`, harness: `native` })).toBe(false);
        expect(chat.error.value).toBeNull();
        queueReroute.mockImplementationOnce(async () => {
            throw new SandboxHttpError(500, `the sandbox broke`);
        });
        expect(await followPick(chat, { agent: `codex`, harness: `native` })).toBe(false);
        expect(chat.error.value).toBe(`the sandbox broke`);
    });

    // The selection over a conversation that is only its refs, its words waiting on Claude Opus at high effort.
    const selectionOf = () => {
        turnDefaults.provider.value = `claude`;
        turnDefaults.models.value = { claude: `opus`, codex: `gpt-6` };
        turnDefaults.effort.value = `high`;
        const live = reactive({ streaming: false, generating: false });
        const host = {
            ...chatOf(queueOf(words(`m1`))),
            session: ref<SessionRef | undefined>({ id: `s-1`, provider: `claude`, account: `pro`, harness: `native` }),
            registered: ref(true),
            activeModel: ref<string | null>(null),
            contextUsage: ref<ContextUsage | undefined>(),
            fastMode: ref<Extract<TurnFact, { kind: `fast_mode` }> | undefined>(),
            transcript: new TranscriptView(() => undefined, unstubbed(`transcriptHost`, {})),
            turn: { streaming: computed(() => live.streaming), generating: computed(() => live.generating), moveAccount: (): void => undefined },
            peek: ref(false),
        };
        return { host, selection: new ComposerSelection(host) };
    };

    it(`moves them on the reader's own pick of a model or provider, and never on a pick the app writes`, async () => {
        queueReroute.mockImplementation(async (input) => ({ ...queueOf(words(`m1`)), revision: 2, conversationId: input.conversationId }));
        const { selection } = selectionOf();
        selection.apply({ kind: `set`, picks: { model: `sonnet` } });
        expect(queueReroute).not.toHaveBeenCalled();

        selection.apply({ kind: `selectModel`, pick: { provider: `codex`, value: `gpt-6` } });
        await waitFor(() => expect(queueReroute).toHaveBeenCalledTimes(1));
        expect(queueReroute.mock.calls[0]?.[0]).toMatchObject({ conversationId: `c-1`, routing: { agent: `codex`, harness: `native`, model: `gpt-6` }, ids: [`m1`] });
    });
});
