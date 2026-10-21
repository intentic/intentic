// This browser's copy of the sandbox's drafts, end to end against a fake daemon: what a composer writes reaches the
// sandbox from the revision it read, words from another device come back, an edit is never written over unseen, an
// older sandbox leaves the copy as the only one, and the per-browser set drafts used to live in is taken in once.
import { resetSandboxScope } from "@intentic/extension-api";
import type { ComposerDraft, DraftWrite } from "@intentic/sandbox-contract/schemas/composer-drafts";
import { waitFor } from "@intentic/testing/bun";
import { ref } from "vue";
import { SandboxHttpError } from "../../../client/sandbox/sandboxHttpError";
import { fakeSandboxRpc } from "../../../testing/sandboxRpcFake";

// The sandbox's side: its drafts, and every write and clear it was asked for.
let sandbox: ComposerDraft[] = [];
let revision = 0;
const writes: DraftWrite[] = [];
let refuseAll = false;

const refusing = (): never => {
    throw new SandboxHttpError(404, `Request failed (404).`);
};

const agents = {
    drafts: async () => (refuseAll ? refusing() : { drafts: [...sandbox], revision }),
    writeDraft: async (write: DraftWrite) => {
        if (refuseAll) {
            return refusing();
        }
        writes.push(write);
        const current = sandbox.find((draft) => draft.conversationId === write.id);
        if (write.base !== undefined && current?.revision !== write.base) {
            return current === undefined ? { conflict: true as const } : { draft: current, conflict: true as const };
        }
        revision += 1;
        const draft: ComposerDraft = { conversationId: write.id, text: write.text, attachments: write.attachments, since: current?.since ?? write.since ?? 1, revision };
        sandbox = [draft, ...sandbox.filter((entry) => entry.conversationId !== write.id)];
        return { draft };
    },
    clearDraft: async ({ id }: { id: string }) => {
        sandbox = sandbox.filter((draft) => draft.conversationId !== id);
        return {};
    },
};
jest.mock("../../../client/sandbox/sandboxRpc", () => ({ sandboxRpc: fakeSandboxRpc({ agents }) }));
jest.mock("../../../client/sandbox/useSandbox", () => {
    const activeSandboxId = ref<string | undefined>(`sb1`);
    return { useSandbox: () => ({ activeSandboxId, reachable: ref(true) }), sandboxKey: (...parts: unknown[]) => [...parts, activeSandboxId] };
});

// Node has no storage; the copy is written there on every change.
const stored = new Map<string, string>();
Object.defineProperty(globalThis, `localStorage`, {
    configurable: true,
    value: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => void stored.set(key, value),
        removeItem: (key: string) => void stored.delete(key),
        key: (at: number) => [...stored.keys()][at] ?? null,
        get length() {
            return stored.size;
        },
        clear: () => stored.clear(),
    },
});

const { closedDraftsKey, composerDraftsKey } = await import("../../../app/storage/browserStorage");
const { receiveChatNote } = await import("../run/chatChannel");
const { draftOf, draftsMoved, heldDrafts, ORPHANED_AFTER_MS, sandboxKeepsDrafts, sentFrom, writeDraft } = await import("./composerDrafts");

const words = (text: string) => ({ text, attachments: [] });

beforeEach(() => {
    sandbox = [];
    revision = 0;
    writes.length = 0;
    refuseAll = false;
    stored.clear();
    resetSandboxScope();
});

test(`writes what a composer holds to the sandbox once typing pauses, and agrees on the revision it got back`, async () => {
    writeDraft(`c1`, words(`fix the login`), { since: 1_700 });
    expect(draftOf(`c1`)).toMatchObject({ text: `fix the login`, since: 1_700, pending: true });

    await waitFor(() => expect(draftOf(`c1`)?.pending).toBe(false));

    expect(writes).toEqual([expect.objectContaining({ id: `c1`, text: `fix the login`, since: 1_700, base: undefined })]);
    // What a message sent now names, for the sandbox to clear as it takes it.
    expect(sentFrom(`c1`)).toBe(1);
});

test(`shows words written on another device, and drops words sent from one`, async () => {
    sandbox = [{ conversationId: `c2`, text: `from the phone`, since: 1_000, revision: 4 }];
    revision = 4;
    draftsMoved();
    await waitFor(() => expect(draftOf(`c2`)?.text).toBe(`from the phone`));

    sandbox = [];
    revision = 5;
    draftsMoved();
    await waitFor(() => expect(draftOf(`c2`)).toBeUndefined());
});

test(`keeps both sets of words when another device wrote over the revision this composer edited from`, async () => {
    writeDraft(`c1`, words(`fix the login`));
    await waitFor(() => expect(sentFrom(`c1`)).toBe(1));
    // The phone writes in between; this window then types on from what it last agreed with.
    sandbox = [{ conversationId: `c1`, text: `fix the logout`, since: 1, revision: 2 }];
    revision = 2;

    writeDraft(`c1`, words(`fix the login page`));

    await waitFor(() => expect(sandbox[0]?.text).toBe(`fix the logout\n\nfix the login page`));
    expect(draftOf(`c1`)).toMatchObject({ text: `fix the logout\n\nfix the login page`, pending: false });
});

test(`keeps the copy a window edited last when another window's older copy arrives`, () => {
    writeDraft(`c1`, words(`newer`));
    const mine = draftOf(`c1`)!;

    receiveChatNote({ sandbox: `sb1`, note: { kind: `drafts`, changed: [{ ...mine, text: `older`, editedAt: mine.editedAt - 1 }], gone: [] } });
    expect(draftOf(`c1`)?.text).toBe(`newer`);

    receiveChatNote({ sandbox: `sb1`, note: { kind: `drafts`, changed: [{ ...mine, text: `newest`, editedAt: mine.editedAt + 1 }], gone: [] } });
    expect(draftOf(`c1`)?.text).toBe(`newest`);
});

// Another window of this browser typing: its copy arrives by note, edited after anything here.
const typedElsewhere = (conversationId: string, text: string, from: { readonly revision: number; readonly text: string }, editedAt = Date.now()): void => {
    receiveChatNote({
        sandbox: `sb1`,
        note: {
            kind: `drafts`,
            changed: [{ conversationId, text, attachments: [], since: 1, editedAt, synced: { ...from, paths: [] }, pending: true }],
            gone: [],
        },
    });
};

test(`leaves a draft another window is typing to that window, however often the sandbox says drafts moved`, async () => {
    sandbox = [{ conversationId: `c1`, text: `fix the`, since: 1, revision: 1 }];
    revision = 1;
    draftsMoved();
    await waitFor(() => expect(sentFrom(`c1`)).toBe(1));

    // The window typing writes from revision 1 itself; this one writing too raced it, and the loser's conflict joined
    // both sets of words into the composer.
    typedElsewhere(`c1`, `fix the login`, { revision: 1, text: `fix the` });
    draftsMoved();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(writes).toEqual([]);
    expect(draftOf(`c1`)).toMatchObject({ text: `fix the login`, pending: true });
});

test(`writes a draft another window left waiting once nobody has edited it for a while`, async () => {
    sandbox = [{ conversationId: `c1`, text: `fix the`, since: 1, revision: 1 }];
    revision = 1;
    draftsMoved();
    await waitFor(() => expect(sentFrom(`c1`)).toBe(1));

    // The window that typed it closed before it wrote it.
    typedElsewhere(`c1`, `fix the login`, { revision: 1, text: `fix the` });
    jest.setSystemTime(Date.now() + ORPHANED_AFTER_MS);
    try {
        draftsMoved();
        await waitFor(() => expect(sandbox[0]?.text).toBe(`fix the login`));
    } finally {
        jest.setSystemTime();
    }
    expect(writes).toEqual([expect.objectContaining({ id: `c1`, text: `fix the login`, base: 1 })]);
});

test(`hands the writing to another window once it edits the draft after this one`, async () => {
    writeDraft(`c1`, words(`fix the`));
    await waitFor(() => expect(sentFrom(`c1`)).toBe(1));
    writes.length = 0;

    typedElsewhere(`c1`, `fix the login`, { revision: 1, text: `fix the` }, draftOf(`c1`)!.editedAt + 1);
    draftsMoved();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(writes).toEqual([]);

    // Typed here again: this window writes it, from the revision it last agreed with.
    writeDraft(`c1`, words(`fix the login page`));
    await waitFor(() => expect(sandbox[0]?.text).toBe(`fix the login page`));
    expect(writes).toEqual([expect.objectContaining({ text: `fix the login page`, base: 1 })]);
});

test(`leaves this browser's copy as the only one against a sandbox that keeps no drafts`, async () => {
    refuseAll = true;
    writeDraft(`c1`, words(`fix the login`));

    await waitFor(() => expect(sandboxKeepsDrafts.value).toBe(false));

    expect(draftOf(`c1`)).toMatchObject({ text: `fix the login`, pending: true });
    expect(JSON.parse(stored.get(composerDraftsKey(`sb1`)) ?? `{}`)).toMatchObject({ drafts: [{ conversationId: `c1`, text: `fix the login` }] });
});

test(`takes the words chats were closed with before drafts were the sandbox's in once, and removes where they were`, () => {
    stored.set(
        closedDraftsKey(`sb1`),
        JSON.stringify({
            tabs: [
                { conversationId: `old-1`, draft: `the half-written message`, draftAt: 1_700, attachments: [], provider: `codex`, model: `gpt-5` },
                { conversationId: `old-2`, draft: `   `, attachments: [] },
            ],
        }),
    );

    resetSandboxScope();

    expect(heldDrafts.value.map((draft) => [draft.conversationId, draft.text, draft.since, draft.serves?.agent, draft.pending])).toEqual([
        [`old-1`, `the half-written message`, 1_700, `codex`, true],
    ]);
    expect(stored.has(closedDraftsKey(`sb1`))).toBe(false);
    // Read once: a later scope finds them in the copy itself, not imported a second time.
    resetSandboxScope();
    expect(heldDrafts.value.map((draft) => draft.conversationId)).toEqual([`old-1`]);
});
