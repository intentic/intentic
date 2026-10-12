import { sandboxRef } from "@intentic/extension-api";
import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { ref } from "vue";

// Signing out, as useAuth.ts tears it down: what the account left in this browser goes, and this device's preferences
// stay. The platform client and the session plumbing around it are stubbed; storage, the account scope registry and
// the sandbox scope are the real ones.

const clearSessions = jest.fn();
const clearPersistedQueries = jest.fn(async () => undefined);
jest.mock(`better-auth/client`, () => ({ createAuthClient: () => ({}) }));
jest.mock(`../session/sandboxSession`, () => ({ useSandboxSession: () => ({ clearSessions, retireAccountAccess: jest.fn() }) }));
jest.mock(`./useGoogleIdentity`, () => ({ useGoogleIdentity: () => ({ clearCredential: jest.fn() }) }));
jest.mock(`../../lib/queryPersistence`, () => ({ clearPersistedQueries }));
jest.mock(`../../app/environments/local`, () => ({ localFace: () => undefined }));
jest.mock(`../../app/environments/desktop`, () => ({ announceDesktopRoster: jest.fn() }));
jest.mock(`../directory/deviceDirectory`, () => ({ forgetAccount: jest.fn() }));
jest.mock(`../directory/directState`, () => ({ directMode: ref(false) }));
jest.mock(`@intentic/ui/skeleton-store`, () => ({ clearImprints: jest.fn(async () => undefined) }));

await import(`./useAuth`);
const { invalidatePlatformAuth } = await import(`../../lib/authLifecycle`);

// What the account leaves behind, by the keys its stores write today.
const ACCOUNT = {
    "intentic.chatTabs.sbx-1": `{"tabs":[]}`,
    "intentic.inputHistory.sbx-1": `["rotate the deploy key"]`,
    "intentic.closedDrafts.sbx-1": `{"tabs":[]}`,
    "intentic.questionDraft.req-7": `{"selections":{},"otherTexts":{},"savedAt":1}`,
    "intentic.commitMessage.sbx-1": `{"message":"wip: billing"}`,
    "intentic.activeSandboxId": `sbx-1`,
};
// This device's: the theme, the language, a rail's last pick.
const DEVICE = { "ui-theme": `dark`, "ui-language": `pl`, "intentic.rail.repos": `web` };

const deleted: string[] = [];

// As much of an IDBOpenDBRequest as a delete is read through: it succeeds on the next tick.
class DeleteRequest {
    onsuccess: (() => void) | undefined = undefined;
    onblocked: (() => void) | undefined = undefined;
    addEventListener(): void {
        // A delete here never fails.
    }
}

beforeEach(() => {
    deleted.length = 0;
    for (const [key, value] of Object.entries({ ...ACCOUNT, ...DEVICE })) {
        localStorage.setItem(key, value);
    }
    sessionStorage.setItem(`intentic.chatTabs.sbx-1`, `{"tabs":[]}`);
    stubGlobal(`indexedDB`, {
        deleteDatabase: (name: string) => {
            deleted.push(name);
            const request = new DeleteRequest();
            queueMicrotask(() => request.onsuccess?.());
            return request;
        },
    });
});

afterEach(() => {
    unstubAllGlobals();
    localStorage.clear();
    sessionStorage.clear();
});

it(`clears every account-scoped key and the transcript mirror, and keeps the device's preferences`, async () => {
    await invalidatePlatformAuth(false);

    expect(Object.keys(localStorage).toSorted()).toEqual(Object.keys(DEVICE).toSorted());
    expect(Object.keys(sessionStorage)).toEqual([]);
    expect(deleted).toEqual([`intentic.chat`]);
    expect([clearSessions.mock.calls.length > 0, clearPersistedQueries.mock.calls.length > 0]).toEqual([true, true]);
});

it(`empties the sandbox scope after storage, so what refills it reads nothing back`, async () => {
    const commitDraft = sandboxRef(() => localStorage.getItem(`intentic.commitMessage.sbx-1`));
    expect(commitDraft.value).toBe(`{"message":"wip: billing"}`);

    await invalidatePlatformAuth(false);

    expect(commitDraft.value).toBeNull();
});
