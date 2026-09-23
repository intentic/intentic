import { STATE_DIR } from "@intentic/constants";
import type { TranscriptRow } from "@intentic/sandbox-contract";
import { computed, ref } from "vue";
import { SandboxHttpError } from "../../sandbox/client/sandboxHttpError";
import type { SandboxRpc } from "../../sandbox/client/sandboxRpc";
import { fakeSandboxRpc } from "../../../testing/sandboxRpcFake";
import type { PendingAttachment } from "../drafts/useChatAttachments";
import type { SessionRef } from "../run/turnRequest";
import type { ChatMessage } from "../transcript/transcript";

// Pins the transcript's own ways back: a rewind by the daemon's index that truncates by the bubble's, an edit that
// borrows the composer and hands it back, a fork's cut, and the in-place rewording of this window's own lines.

// The daemon's rewind, the one call these ways back make; a test refuses it.
const { rewind } = { rewind: jest.fn<SandboxRpc["agent"]["rewind"]>(async () => ({ snapshot: `cp-1`, dropped: 2 })) };
jest.mock("../../sandbox/client/sandboxRpc", () => ({ sandboxRpc: fakeSandboxRpc({ agent: { rewind } }) }));

const { TranscriptView } = await import("./transcriptView");
type Host = ConstructorParameters<typeof TranscriptView>[1];

// Two recorded turns, each prompt under its checkpoint, with a line only this window drew between them: the daemon's
// index and the bubble's position part ways at it.
const ROWS: readonly ChatMessage[] = [
    { id: 1, role: `user`, text: `first`, sentAt: 1, messageId: `m-1`, rewindIndex: 0, attachments: [`docs/spec.md`] },
    { id: 2, role: `assistant`, text: `done` },
    { id: 3, role: `notice`, text: `Switched to Haiku`, local: true },
    { id: 4, role: `user`, text: `second`, sentAt: 2, messageId: `m-2`, rewindIndex: 2 },
    { id: 5, role: `assistant`, text: `also done` },
];
const SESSION: SessionRef = { id: `s-1`, provider: `claude`, account: `a1`, harness: `native` };
const STAGED: PendingAttachment = { id: `u1`, name: `draft.png`, path: `${STATE_DIR}/a/draft.png`, status: `done`, progress: 100 };

const viewOf = (rows: readonly ChatMessage[] = ROWS) => {
    const host = {
        conversationId: `c1`,
        box: ref<string | undefined>(`box-2`),
        draft: ref(`half a thought`),
        attachments: ref<PendingAttachment[]>([STAGED]),
        error: ref<string | null>(`an older failure`),
        session: ref<SessionRef | undefined>(SESSION),
        turn: { streaming: computed(() => false), say: jest.fn<Host["turn"]["say"]>(async () => undefined) },
    };
    const view = new TranscriptView(() => undefined, host);
    view.adopt(rows);
    const row = (id: number): ChatMessage => view.messages.value.find((message) => message.id === id)!;
    const texts = (): string[] => view.messages.value.map((message) => message.text);
    return { host, view, row, texts };
};

afterEach(() => {
    rewind.mockReset();
    rewind.mockImplementation(async () => ({ snapshot: `cp-1`, dropped: 2 }));
});

describe(`rewindTo`, () => {
    it(`goes back by the daemon's index, drops from the bubble down, and retires the session`, async () => {
        const { host, view, row, texts } = viewOf();

        expect(await view.rewindTo(row(4))).toBe(true);

        expect(rewind.mock.calls).toEqual([[{ conversationId: `c1`, index: 2, messageId: `m-2` }, { context: { at: `box-2` } }]]);
        expect(texts()).toEqual([
            `first`,
            `done`,
            `Switched to Haiku`,
            `Went back to here, 2 messages dropped and the files restored to this point.`,
        ]);
        expect(host.session.value).toBeUndefined();
        expect(host.error.value).toBeNull();
    });

    it(`says why the daemon refused, and leaves the transcript and session standing`, async () => {
        const { host, view, row, texts } = viewOf();
        rewind.mockImplementationOnce(async () => {
            throw new SandboxHttpError(409, `Busy.`);
        });
        expect(await view.rewindTo(row(4))).toBe(false);
        expect(host.error.value).toBe(`This agent is running a turn, stop it before going back.`);

        rewind.mockImplementationOnce(async () => {
            throw new SandboxHttpError(404, `Not found.`);
        });
        expect(await view.rewindTo(row(4))).toBe(false);
        expect(host.error.value).toBe(`That message can no longer be gone back to.`);

        // Another window rewound and ran since: the position now holds a different message.
        rewind.mockImplementationOnce(async () => {
            throw new SandboxHttpError(412, `Moved.`);
        });
        expect(await view.rewindTo(row(4))).toBe(false);
        expect(host.error.value).toBe(`This conversation has moved on since you opened it: reload it and try again.`);

        expect(texts()).toEqual(ROWS.map((message) => message.text));
        expect(host.session.value).toEqual(SESSION);
    });

    it(`asks nothing of the daemon for a row with no checkpoint, no id to name it by, or one no longer drawn`, async () => {
        const { view, row } = viewOf([...ROWS, { id: 6, role: `user`, text: `unnamed`, rewindIndex: 5 }]);

        expect(await view.rewindTo(row(2))).toBe(false);
        expect(await view.rewindTo(row(6))).toBe(false);
        expect(await view.rewindTo({ ...row(4) })).toBe(false);
        expect(rewind).not.toHaveBeenCalled();
    });
});

describe(`an edit`, () => {
    it(`borrows the composer for a sent prompt, its files re-staged, and cancelling hands back exactly what it held`, () => {
        const { host, view, row } = viewOf();

        expect(view.beginEdit(row(1))).toBe(true);
        expect(host.draft.value).toBe(`first`);
        expect(host.attachments.value).toEqual([{ id: expect.any(String), name: `spec.md`, path: `docs/spec.md`, status: `done`, progress: 100 }]);
        expect(view.editing.value).toEqual({ id: 1, restore: `half a thought`, attachments: [STAGED] });

        view.cancelEdit();
        expect(host.draft.value).toBe(`half a thought`);
        expect(host.attachments.value).toEqual([STAGED]);
        expect(view.editing.value).toBeUndefined();
    });

    it(`dooms the edited prompt and every row below it, and nothing once disarmed`, () => {
        const { view, row } = viewOf();
        expect([...view.doomed.value]).toEqual([]);

        view.beginEdit(row(4));
        expect([...view.doomed.value]).toEqual([4, 5]);

        view.cancelEdit();
        expect([...view.doomed.value]).toEqual([]);
    });

    it(`is offered only on a prompt of this transcript that has a checkpoint`, () => {
        const { host, view, row } = viewOf([...ROWS, { id: 6, role: `user`, text: `unrecorded` }]);

        expect(view.beginEdit(row(2))).toBe(false);
        expect(view.beginEdit(row(6))).toBe(false);
        expect(view.beginEdit({ ...row(1) })).toBe(false);
        expect(view.editing.value).toBeUndefined();
        expect(host.draft.value).toBe(`half a thought`);
    });

    it(`rewinds before it sends, and sends the new words only once the rewind landed`, async () => {
        const { host, view, row, texts } = viewOf();
        view.beginEdit(row(1));
        rewind.mockImplementationOnce(async () => {
            throw new SandboxHttpError(409, `Busy.`);
        });

        expect(await view.submitEdit(`first, better`)).toBe(false);
        expect(host.turn.say).not.toHaveBeenCalled();
        // Still armed: the refusal is the daemon's to lift, and the press is the same one again.
        expect(view.editing.value).toMatchObject({ id: 1 });

        expect(await view.submitEdit(`first, better`)).toBe(true);
        expect(texts()).toEqual([`Edited this message, 5 messages dropped and the files restored to this point.`]);
        expect(view.editing.value).toBeUndefined();
        expect(host.turn.say.mock.calls).toEqual([[`first, better`, [], undefined]]);
    });

    it(`ends when the prompt it aimed at left the transcript`, async () => {
        const { host, view, row } = viewOf();
        view.beginEdit(row(4));
        view.adopt(ROWS.slice(0, 2));

        expect(await view.submitEdit(`second, better`)).toBe(false);
        expect(view.editing.value).toBeUndefined();
        expect(host.error.value).toBe(`That message is no longer in this conversation.`);
        expect(rewind).not.toHaveBeenCalled();
    });
});

describe(`the transcript's own lines`, () => {
    it(`cuts a fork's opening from another transcript, counting only the rows the daemon recorded`, () => {
        const source = viewOf().view;
        const { view, texts } = viewOf([]);

        expect(view.cutFrom(source, 4)).toBe(3);
        expect(texts()).toEqual([`first`, `done`, `Switched to Haiku`, `second`]);
    });

    it(`rewords one notice in place and ends its wait`, () => {
        const { view, row } = viewOf();
        const id = view.notice(`Reading which model fits…`, { noticeWait: `chatRoute` });

        view.rewordNotice(id, `Read by Haiku.`, { noticeWait: undefined });

        expect(row(id)).toEqual({ id, role: `notice`, text: `Read by Haiku.`, local: true, noticeWait: undefined });
        expect(view.messages.value).toHaveLength(ROWS.length + 1);
    });

    it(`freezes a card a stopped turn left pending`, () => {
        const pending: TranscriptRow = { role: `assistant`, text: ``, permission: { requestId: `p1`, toolName: `Bash`, status: `pending` } };
        const { view } = viewOf([...ROWS, { id: 6, ...pending }]);
        expect(view.awaitingDecision.value).toBe(true);

        view.cancelPendingCards();

        expect(view.messages.value.at(-1)?.permission).toEqual({ requestId: `p1`, toolName: `Bash`, status: `cancelled` });
        expect(view.awaitingDecision.value).toBe(false);
    });

    it(`redraws a replayed record with its page cursor, and disarms an edit aimed at the old ids`, () => {
        const { host, view, row } = viewOf();
        view.beginEdit(row(1));

        view.restoreMessages(ROWS.slice(3), { from: 3, more: true });
        expect(view.editing.value).toBeUndefined();
        expect(view.historyFrom.value).toBe(3);
        expect(view.historyMore.value).toBe(true);
        expect(host.error.value).toBeNull();

        view.restoreMessages(ROWS);
        expect(view.historyFrom.value).toBe(0);
        expect(view.historyMore.value).toBe(false);
    });
});
