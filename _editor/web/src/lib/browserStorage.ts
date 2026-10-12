import { accountKey, accountKeys, onAccountCleared, sandboxKeys } from "@intentic/ui/storage";

// The kit's one door to browser storage (`@intentic/ui/storage`: safe reads and writes, JSON through a schema, the
// device / account / sandbox scopes), plus every key the signed-in account leaves in this browser, declared HERE rather
// beside each store. Sign-out clears what the scope registry knows, and a store whose module never loaded in this page
// (a chunk the reader never opened) has registered nothing by then; declared in this module, which sign-out imports,
// each is known from the first paint.
export {
    type AccountClearer,
    clearAccountStorage,
    deviceKey,
    isAccountKey,
    onAccountCleared,
    removeStoredValue,
    type StorageArea,
    type StoredJsonValue,
    storedJson,
    storedKeys,
    type StoredSchema,
    storedValue,
    storeJson,
    storeValue,
} from "@intentic/ui/storage";

// Which sandbox this browser last had open: the account's, so the next person to sign in is not put on it.
export const ACTIVE_SANDBOX_KEY = accountKey(`intentic.activeSandboxId`);

// The chat's tabs, per sandbox (features/chat/tabs/tabSnapshot.ts).
export const chatTabsKey = sandboxKeys(`intentic.chatTabs.`);
// The last prompts sent, per sandbox (features/chat/drafts/inputHistory.ts).
export const inputHistoryKey = sandboxKeys(`intentic.inputHistory.`);
// Drafts of chats closed unsent, per sandbox (features/chat/drafts/closedDrafts.ts).
export const closedDraftsKey = sandboxKeys(`intentic.closedDrafts.`);
// A half-answered question card, per request (features/chat/drafts/questionDraft.ts).
export const questionDraftKey = accountKeys(`intentic.questionDraft.`);
// The commit message being written, per sandbox (features/workspace/changes/commit/commitMessage.ts).
export const commitMessageKey = sandboxKeys(`intentic.commitMessage.`);

// The transcript mirror (features/chat/transcript/transcriptCache.ts): up to its last few hundred messages per
// conversation, in IndexedDB. Deleted whole on sign-out; a window holding it open closes on the version change, so the
// delete is never blocked by this page.
export const TRANSCRIPT_DATABASE = `intentic.chat`;

const deleteDatabase = (name: string): Promise<void> =>
    new Promise((resolve) => {
        try {
            const request = globalThis.indexedDB.deleteDatabase(name);
            request.onsuccess = () => resolve();
            request.addEventListener(`error`, () => resolve());
            // Another tab holds it open past its version-change handler: it is deleted once that tab lets go.
            request.onblocked = () => resolve();
        } catch {
            // Unavailable (private mode, disabled storage), then nothing was mirrored.
            resolve();
        }
    });

onAccountCleared(() => deleteDatabase(TRANSCRIPT_DATABASE));
