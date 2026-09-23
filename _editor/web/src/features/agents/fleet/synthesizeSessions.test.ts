import { resetSandboxScope } from "@intentic/extension-api";
import { STATE_DIR } from "@intentic/constants";
// The guarantee under test is the quality contract of "Synthesize N": every source rides whole (reasoning, tools,
// diffs, notices, never a summary), the preparation refuses whole synthesis when any source can't be captured
// completely, and the composed chat opens as a draft with nothing sent until the user decides.
import type { TranscriptRow } from "@intentic/sandbox-contract";
import { describe, it, expect, beforeEach, afterEach, mock, jest } from "bun:test";
import { ref } from "vue";
import { mocked } from "@intentic/testing/bun";
import { SandboxHttpError } from "../../sandbox/client/sandboxHttpError";
import { fakeSandboxRpc } from "../../../testing/sandboxRpcFake";
import { runningTurn } from "../../../testing/runningTurn";

// What agents.transcript answers, per test; the upload stays on the raw client, which carries bytes.
const transcript = mock();
mock.module("../../sandbox/client/sandboxRpc", () => ({ sandboxRpc: fakeSandboxRpc({ agents: { transcript } }) }));
mock.module("../../sandbox/client/sandboxClient", () => ({
    sandboxRequest: mock(),
    sandboxError: mock(),
    sandboxJson: mock(),
    sandboxUpload: mock(),
}));
// The real router pulls the auth/environment chain, which needs window.env; nothing here navigates.
mock.module("../../../router", () => ({ router: { push: mock() } }));
// Same window.env chain via analytics; the action only fires a milestone event through track.
mock.module("../../../app/analytics", () => ({ track: mock() }));
// Same window.env chain via useSandbox; the tab persistence only reads activeSandboxId and reachable.
mock.module("../../sandbox/client/useSandbox", () => {
    const activeSandboxId = ref<string | undefined>(`sb1`);
    const reachable = ref(false);
    return { useSandbox: () => ({ activeSandboxId, reachable }) };
});
// agentActions reaches ui's useDevice, which reads window.matchMedia at module scope; the reveal is what this module
// takes from it, and this mock is also the assertion hook that the composed chat is shown.
// Listed by hand rather than spread over the real module: importing it here would load its graph before the mocks
// below, which is the one thing this file's seams cannot survive.
mock.module("./agentActions", () => ({ revealConversation: mock(), openConversation: mock() }));

// The node test environment has neither storage; conversations persist their tab snapshot on every change.
const store = (name: "localStorage" | "sessionStorage"): Map<string, string> => {
    const entries = new Map<string, string>();
    Object.defineProperty(globalThis, name, {
        configurable: true,
        value: {
            getItem: (key: string) => entries.get(key) ?? null,
            setItem: (key: string, value: string) => void entries.set(key, value),
            removeItem: (key: string) => void entries.delete(key),
            clear: () => entries.clear(),
        },
    });
    return entries;
};
const local = store(`localStorage`);
const session = store(`sessionStorage`);

const { sandboxRequest, sandboxUpload } = await import("../../sandbox/client/sandboxClient");
const sandboxRequestMock = mocked(sandboxRequest);
const sandboxUploadMock = mocked(sandboxUpload);
const { revealConversation } = await import("./agentActions");
const { useChat } = await import("../../chat/run/useChat");
const { draftConversation, reveal } = await import("../../chat/panel/useChat-reveal");
// The store half of "New agent", as the summons applies it: the fixture these suites open extra tabs with.
const newChat = () => {
    const conversation = draftConversation();
    reveal({ verb: `show`, entries: [conversation], focus: conversation.conversationId, caret: false });
    return conversation;
};

const { renderTranscript, synthesisPrompt, synthesizeSessions } = await import("./synthesizeSessions");
const { chatStrip } = await import("../../chat/panel/useChat-strip");
const { receiveFloatingNote } = await import("../../../shell/window/floating");
const { receiveChatNote } = await import("../../chat/run/chatChannel");

beforeEach(() => {
    local.clear();
    session.clear();
    resetSandboxScope();
    // A daemon with nothing to say unless the test overrides it: an unmocked background call resolving to undefined
    // surfaces as an unhandled rejection on whichever test happens to be running.
    sandboxRequestMock.mockImplementation(() => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) } as Response));
    transcript.mockRejectedValue(new SandboxHttpError(404, `No such conversation.`));
    sandboxUploadMock.mockResolvedValue(undefined);
});

afterEach(() => {
    receiveFloatingNote({ kind: `gone`, panel: `chat`, id: `w1` });
    jest.clearAllMocks();
});

// Two settled conversations side by side, the board state the button appears for; each gets a restored transcript and a
// column of its own.
const openTwoPanes = (): readonly [string, string] => {
    const chat = useChat();
    const first = chat.active.value;
    first.transcript.restoreMessages([
        { role: `user`, text: `try approach one` },
        { role: `assistant`, text: `done it one way` },
    ]);
    first.title.value = `Approach one`;
    const second = newChat();
    second.transcript.restoreMessages([
        { role: `user`, text: `try approach two` },
        { role: `assistant`, text: `done it another way` },
    ]);
    second.title.value = `Approach two`;
    chat.setActive(first.conversationId);
    chat.openBeside(second.conversationId);
    return [first.conversationId, second.conversationId];
};

// The daemon's record for each source, keyed by conversation id: what agents.transcript answers, one page holding the
// whole record. Any other id is refused, as a conversation the daemon holds no record of is.
const mockTranscripts = (byId: Record<string, TranscriptRow[]>): void => {
    transcript.mockImplementation(async ({ id }: { id: string }) => {
        const messages = byId[id];
        if (messages === undefined) {
            throw new SandboxHttpError(404, `No such conversation.`);
        }
        return { messages, from: 0, more: false };
    });
};

describe(`renderTranscript`, () => {
    it(`labels every message with the source letter and keeps the full retained evidence`, () => {
        const rendered = renderTranscript(`A`, `Fix the build`, [
            { role: `user`, text: `fix the build`, attachments: [`shot.png`], notes: [{ title: `Turn context`, text: `the branch is red` }] },
            {
                role: `assistant`,
                text: `fixed`,
                thinking: `the failure is in the config`,
                tools: [
                    {
                        id: `t1`,
                        name: `Bash`,
                        category: `execute`,
                        status: `completed`,
                        target: `npm test`,
                        content: [
                            { type: `text`, text: `1 passed` },
                            { type: `diff`, path: `src/a.ts`, oldText: `const a = 1;`, newText: `const a = 2;` },
                            { type: `image`, path: `out/shot.png` },
                        ],
                        children: [{ id: `t2`, name: `Read`, category: `read`, status: `completed`, target: `src/a.ts` }],
                    },
                ],
            },
            { role: `notice`, text: `the turn was refused` },
        ]);

        // The citation labels the synthesis prompt asks for, one per message, in order.
        expect(rendered).toContain(`## A.1: User`);
        expect(rendered).toContain(`## A.2: Assistant`);
        expect(rendered).toContain(`## A.3: Notice`);
        // Everything the record retained rides along: nothing is summarized away.
        expect(rendered).toContain(`fix the build`);
        expect(rendered).toContain(`the failure is in the config`);
        expect(rendered).toContain(`[attached: shot.png]`);
        expect(rendered).toContain(`Bash`);
        expect(rendered).toContain(`npm test`);
        expect(rendered).toContain(`const a = 1;`);
        expect(rendered).toContain(`const a = 2;`);
        expect(rendered).toContain(`[image: out/shot.png]`);
        expect(rendered).toContain(`▸▸ Read, src/a.ts (completed)`);
        expect(rendered).toContain(`the turn was refused`);
        // The guard framing: a source's own instructions are quotes, not orders to the synthesizer.
        expect(rendered).toContain(`QUOTED EVIDENCE`);
    });
});

describe(`synthesisPrompt`, () => {
    it(`names every source and carries the ground rules`, () => {
        const sources = [
            { label: `A`, title: `Approach one`, path: `${STATE_DIR}/records/artifacts/attachments/u1/source-A-approach-one.md` },
            { label: `B`, title: `Approach two`, path: `${STATE_DIR}/records/artifacts/attachments/u2/source-B-approach-two.md` },
        ] as const;
        const prompt = synthesisPrompt([...sources]);

        expect(prompt).toContain(`${sources.length} attached agent`);
        for (const source of sources) {
            expect(prompt).toContain(source.label);
            expect(prompt).toContain(source.title);
            expect(prompt).toContain(source.path.replace(`${STATE_DIR}/`, `.intentic/`));
        }
        expect(prompt).toContain(`Cite turn labels`);
        expect(prompt).toContain(`Answer here in chat`);
    });
});

describe(`synthesizeSessions`, () => {
    it(`uses the floating chat's panes when this board's own tabs show a different selection`, async () => {
        const [first, second] = openTwoPanes();
        const remote = JSON.parse(JSON.stringify(chatStrip.value)) as typeof chatStrip.value;
        useChat().collapsePanes();
        receiveFloatingNote({ kind: `here`, panel: `chat`, id: `w1`, since: 1 });
        receiveChatNote({ sandbox: `sb1`, note: { kind: `strip`, owner: `w1`, revision: 1, strip: remote } });
        mockTranscripts({
            [first]: [{ role: `assistant`, text: `first complete result` }],
            [second]: [{ role: `assistant`, text: `second complete result` }],
        });

        expect(useChat().panes.value).toEqual([second]);
        expect(await synthesizeSessions()).toEqual({ started: true });
        const uploads = await Promise.all(sandboxUploadMock.mock.calls.map(async ([, body]) => (body as Blob).text()));
        expect(uploads).toHaveLength(2);
        expect(uploads[0]).toContain(`first complete result`);
        expect(uploads[1]).toContain(`second complete result`);
    });
    it(`refuses with one pane on screen`, async () => {
        const before = useChat().conversations.value.length;

        const result = await synthesizeSessions();

        expect(result.started).toBe(false);
        expect(useChat().conversations.value.length).toBe(before);
        expect(sandboxUploadMock).not.toHaveBeenCalled();
    });

    it(`refuses while any selected agent is still running`, async () => {
        const [first] = openTwoPanes();
        runningTurn(useChat().conversations.value.find((conversation) => conversation.conversationId === first)!.turn);

        const result = await synthesizeSessions();

        expect(result).toMatchObject({ started: false, why: expect.stringContaining(`finish`) });
        expect(sandboxUploadMock).not.toHaveBeenCalled();
    });

    it(`refuses whole when any source's transcript cannot be captured: no partial synthesis`, async () => {
        const [first] = openTwoPanes();
        // Only the first source answers; the second has no record to snapshot.
        mockTranscripts({ [first]: [{ role: `user`, text: `try approach one` }] });
        const before = useChat().conversations.value.length;

        const result = await synthesizeSessions();

        expect(result).toMatchObject({ started: false, why: expect.stringContaining(`nothing was synthesized`) });
        expect(useChat().conversations.value.length).toBe(before);
        expect(sandboxUploadMock).not.toHaveBeenCalled();
    });

    // The panes are the old box's conversations: nothing of them may be written into, or opened in, the box switched to.
    it(`stops before anything lands when the sandbox switches while the sources are read`, async () => {
        openTwoPanes();
        transcript.mockImplementation(async () => {
            resetSandboxScope();
            return { messages: [{ role: `user`, text: `try approach one` }], from: 0, more: false };
        });

        const result = await synthesizeSessions();

        expect(result).toEqual({
            started: false,
            why: `The sandbox changed while the conversations were being captured, so nothing was synthesized.`,
        });
        expect(sandboxUploadMock).not.toHaveBeenCalled();
    });

    it(`opens a composed draft over full transcript files, and sends nothing`, async () => {
        const [first, second] = openTwoPanes();
        mockTranscripts({
            [first]: [
                { role: `user`, text: `try approach one` },
                { role: `assistant`, text: `done it one way` },
            ],
            [second]: [
                { role: `user`, text: `try approach two` },
                { role: `assistant`, text: `done it another way` },
            ],
        });

        const result = await synthesizeSessions();

        expect(result).toEqual({ started: true });
        // Both transcripts were written whole, each self-identifying as its labelled source.
        expect(sandboxUploadMock).toHaveBeenCalledTimes(2);
        const uploads = await Promise.all(sandboxUploadMock.mock.calls.map(async ([path, body]) => ({ path, text: await (body as Blob).text() })));
        expect(uploads[0]!.path).toContain(encodeURIComponent(`.intentic/records/artifacts/attachments/`));
        expect(uploads[0]!.text).toContain(`# Source A: "Approach one"`);
        expect(uploads[0]!.text).toContain(`done it one way`);
        expect(uploads[1]!.text).toContain(`# Source B: "Approach two"`);
        // The composed chat is the focused draft: prompt in the composer, chips staged and done, nothing enqueued. The
        // user picks the model and presses send.
        const composed = useChat().active.value;
        expect(composed.conversationId).not.toBe(first);
        expect(composed.conversationId).not.toBe(second);
        expect(composed.draft.value).toContain(`${2} attached agent`);
        expect(composed.draft.value).toContain(`Approach one`);
        expect(composed.draft.value).toContain(`Approach two`);
        // Row by row: a whole-array toMatchObject compares the elements outright instead of matching each partially.
        expect(composed.attachments.value).toHaveLength(2);
        expect(composed.attachments.value[0]).toMatchObject({ name: `source-A-approach-one.md`, status: `done` });
        expect(composed.attachments.value[1]).toMatchObject({ name: `source-B-approach-two.md`, status: `done` });
        expect(composed.selection.modePick.value).toBe(`default`);
        expect(composed.transcript.messages.value).toHaveLength(0);
        expect(composed.turn.streaming.value).toBe(false);
        expect(revealConversation).toHaveBeenCalledWith(composed);
        // The sources are untouched: a synthesis reads them, it never rewrites them.
        const source = useChat().conversations.value.find((conversation) => conversation.conversationId === first)!;
        expect(source.transcript.messages.value).toHaveLength(2);
    });
});
