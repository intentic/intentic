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
const { draftOf, draftsMoved, heldDrafts, sandboxKeepsDrafts, sentFrom, writeDraft } = await import("./composerDrafts");

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
