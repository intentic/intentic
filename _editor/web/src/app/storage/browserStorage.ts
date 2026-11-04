import { accountKey, accountKeys, onAccountCleared, sandboxKeys } from "@intentic/ui/storage";
import { deleteAccountDatabases } from "./accountDatabases";

// The kit's one door to browser storage (`@intentic/ui/storage`: safe reads and writes, JSON through a schema, the
// device / account / sandbox scopes), plus every key the signed-in account leaves in this browser, declared HERE rather
// beside each store. Sign-out clears what the scope registry knows, and a store whose module never loaded in this page
// (a chunk the reader never opened) has registered nothing by then; declared in this module, which sign-out imports,
// each is known from the first paint.
export {
    ACCOUNT_POINTER_KEY,
    type AccountClearer,
    accountPartition,
    clearAccountStorage,
    clearEveryAccountStorage,
    deviceKey,
    isAccountKey,
    onAccountCleared,
    type OpenedPartition,
    openAccountPartition,
    removeStoredValue,
    resetAccountPartitionForTests,
    sealAccountWrites,
    type StorageArea,
    type StoredJsonValue,
    storedJson,
    storedKeys,
    type StoredSchema,
    storedValue,
    storeJson,
    storeValue,
} from "@intentic/ui/storage";

// The credentials each account proves itself to its sandboxes with, in its own drawer: the daemon session minted for
// it, per sandbox (client/session/sandboxSession.ts), and the Google ID token it last signed in to them with, per web
// client (client/auth/useGoogleIdentity.ts). Kept beside each other's for a sandbox two accounts can open, never
// handed from one to the other.
export const daemonSessionKey = sandboxKeys(`intentic.session.`);
export const googleCredentialKey = accountKeys(`intentic.gid.`);

// Which sandbox this browser last had open: the account's, so the next person to sign in is not put on it.
export const ACTIVE_SANDBOX_KEY = accountKey(`intentic.activeSandboxId`);

// The chat's tabs, per sandbox (models/conversations/tabs/tabSnapshot.ts).
export const chatTabsKey = sandboxKeys(`intentic.chatTabs.`);
// The last prompts sent, per sandbox (features/chat/drafts/inputHistory.ts).
export const inputHistoryKey = sandboxKeys(`intentic.inputHistory.`);
// This browser's copy of every unsent message, per sandbox (models/conversations/drafts/composerDrafts.ts).
export const composerDraftsKey = sandboxKeys(`intentic.composerDrafts.`);
// Where a chat closed unsent kept its words before the sandbox held drafts: read once into the copy above, then removed.
export const closedDraftsKey = sandboxKeys(`intentic.closedDrafts.`);
// Messages sent while the sandbox could not be reached, waiting to go out again, per sandbox (models/conversations/session/sendOutbox.ts).
export const outboxKey = sandboxKeys(`intentic.outbox.`);
// A half-answered question card, per request (features/chat/drafts/questionDraft.ts).
export const questionDraftKey = accountKeys(`intentic.questionDraft.`);
// The commit message being written, per sandbox (features/workspace/changes/commit/commitMessage.ts).
export const commitMessageKey = sandboxKeys(`intentic.commitMessage.`);
// How long the last commit messages took to draft, for the field's progress ring (features/workspace/changes/commit/draftPace.ts).
export const commitDraftPaceKey = accountKey(`intentic.commitDraftPace`);
// The size each markdown document's workspace picture last loaded at, per sandbox (lib/markdown/pictureSizes.ts).
export const pictureSizesKey = sandboxKeys(`intentic.pictureSizes.`);
// When a setup last opened a sandbox it had just set up, per sandbox (models/sandbox/live/justSetUp.ts).
export const justSetUpKey = sandboxKeys(`intentic.justSetUp.`);
// Whether the chat's usage rail last had anything to show, per sandbox (features/chat/panel/capacity/capacityMemory.ts).
export const capacityRailKey = sandboxKeys(`intentic.capacityRail.`);
// The board's last roster heard, per sandbox, painted before the stream answers (models/fleet/useAgents-registry.ts).
export const rosterKey = sandboxKeys(`intentic.roster.`);
// Where each repository was last run from in the Run dialog, per sandbox (features/workspace/directory-ui/runPlaceMemory.ts).
export const runPlaceKey = sandboxKeys(`intentic.runPlace.`);

// The transcript mirror (models/conversations/transcript/transcriptCache.ts): up to its last few hundred messages per
// conversation, in IndexedDB, one database per account (accountDatabases.ts). Deleted with that account; a window holding
// it open closes on the version change, so the delete is never blocked by this page.
export const TRANSCRIPT_DATABASE = `intentic.chat`;
// The loading placeholders' imprints (lib/skeletonPersistence.ts): the shapes of the account's sandboxes' views, how many
// secrets, rows and agents each one held, so the account's too.
export const SKELETON_DATABASE = `intentic.skeletons`;

onAccountCleared((account) => deleteAccountDatabases(TRANSCRIPT_DATABASE, account));
onAccountCleared((account) => deleteAccountDatabases(SKELETON_DATABASE, account));
