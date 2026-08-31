import { STATE_DIR } from "@intentic/constants";
// The guarantee under test is the QUALITY CONTRACT of "Synthesize N": every source rides whole (reasoning,
// tools, diffs, notices, not a summary), the preparation refuses WHOLE when any source can't be captured
// completely, and the composed chat opens as a draft: prompt in the composer, transcripts as chips, nothing
// sent until the user decides what to spend on it.
import type { RestoredMessage } from "@intentic/sandbox-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../sandbox/sandboxClient", () => ({ sandboxRequest: vi.fn(), sandboxJson: vi.fn(), sandboxUpload: vi.fn() }));
// The real router pulls the auth/environment chain, which needs window.env; nothing here navigates.
vi.mock("../../router", () => ({ router: { push: vi.fn() } }));
// Same window.env chain via analytics; the action only fires a milestone event through track.
vi.mock("../analytics", () => ({ track: vi.fn() }));
// Same window.env chain via useSandbox; the tab persistence only reads activeSandboxId + reachable.
vi.mock("../sandbox/useSandbox", async () => {
    const { ref } = await import("vue");
    const activeSandboxId = ref<string | undefined>(`sb1`);
    const reachable = ref(false);
    return { useSandbox: () => ({ activeSandboxId, reachable }) };
});
// agentActions reaches ui's useDevice, which reads window.matchMedia at module scope, and the reveal is the
// one thing this module takes from it, so the mock is also the assertion hook that the composed chat is shown.
vi.mock("./agentActions", () => ({ revealConversation: vi.fn() }));

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

const { sandboxRequest, sandboxUpload } = await import("../sandbox/sandboxClient");
const sandboxRequestMock = vi.mocked(sandboxRequest);
const sandboxUploadMock = vi.mocked(sandboxUpload);
const { revealConversation } = await import("./agentActions");
const { draftConversation, resetChat, reveal, useChat } = await import("../chat/useChat");
// The store half of "New agent", as the summons applies it (agentActions.startAgent): the fixture these
// suites open extra tabs with.
const newChat = () => {
    const conversation = draftConversation();
    reveal({ verb: `show`, entries: [conversation], focus: conversation.conversationId, caret: false });
    return conversation;
};

const { renderTranscript, synthesisPrompt, synthesizeSessions } = await import("./synthesizeSessions");

beforeEach(() => {
    local.clear();
    session.clear();
    resetChat();
    // A daemon with nothing to say, unless the test says otherwise: an unmocked background call resolving to
    // `undefined` surfaces as an unhandled rejection attributed to whichever test happens to be running.
    sandboxRequestMock.mockImplementation(() => Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) } as Response));
    sandboxUploadMock.mockResolvedValue(undefined);
});

afterEach(() => {
    vi.clearAllMocks();
});

// Two settled conversations side by side: the board state the button appears for. Each gets a restored
// transcript (so it reads as having completed turns) and a column of its own.
const openTwoPanes = (): readonly [string, string] => {
    const chat = useChat();
    const first = chat.active.value;
    first.restoreMessages([
        { role: `user`, text: `try approach one` },
        { role: `assistant`, text: `done it one way` },
    ]);
    first.title.value = `Approach one`;
    const second = newChat();
    second.restoreMessages([
        { role: `user`, text: `try approach two` },
        { role: `assistant`, text: `done it another way` },
    ]);
    second.title.value = `Approach two`;
    chat.setActive(first.conversationId);
    chat.openBeside(second.conversationId);
    return [first.conversationId, second.conversationId];
};

// The daemon's record for each source, keyed by conversation id: what /agents/:id/transcript answers.
const mockTranscripts = (byId: Record<string, RestoredMessage[]>): void => {
    sandboxRequestMock.mockImplementation((path: string) => {
        const match = /^\/agents\/([^/]+)\/transcript$/u.exec(path);
        const messages = match === null ? undefined : byId[decodeURIComponent(match[1] ?? ``)];
        return Promise.resolve(
            messages === undefined
                ? ({ ok: false, status: 404, json: () => Promise.resolve({}) } as Response)
                : ({ ok: true, status: 200, json: () => Promise.resolve({ messages }) } as unknown as Response),
        );
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
    it(`refuses with one pane on screen`, async () => {
        const before = useChat().conversations.value.length;

        const result = await synthesizeSessions();

        expect(result.started).toBe(false);
        expect(useChat().conversations.value.length).toBe(before);
        expect(sandboxUploadMock).not.toHaveBeenCalled();
    });

    it(`refuses while any selected agent is still running`, async () => {
        const [first] = openTwoPanes();
        useChat().conversations.value.find((conversation) => conversation.conversationId === first)!.streaming.value = true;

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
        // The composed chat is the focused draft: prompt in the composer, chips staged and done, an ordinary
        // chat posture, and NOTHING enqueued. The user picks the model and presses send.
        const composed = useChat().active.value;
        expect(composed.conversationId).not.toBe(first);
        expect(composed.conversationId).not.toBe(second);
        expect(composed.draft.value).toContain(`${2} attached agent`);
        expect(composed.draft.value).toContain(`Approach one`);
        expect(composed.draft.value).toContain(`Approach two`);
        expect(composed.attachments.value).toMatchObject([
            { name: `source-A-approach-one.md`, status: `done` },
            { name: `source-B-approach-two.md`, status: `done` },
        ]);
        expect(composed.modePick.value).toBe(`default`);
        expect(composed.messages.value).toHaveLength(0);
        expect(composed.streaming.value).toBe(false);
        expect(revealConversation).toHaveBeenCalledWith(composed);
        // The sources are untouched: a synthesis reads them, it never rewrites them.
        const source = useChat().conversations.value.find((conversation) => conversation.conversationId === first)!;
        expect(source.messages.value).toHaveLength(2);
    });
});
