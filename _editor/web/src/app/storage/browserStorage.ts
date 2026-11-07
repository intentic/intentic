import { accountKey, accountKeys, deviceKey, onAccountCleared, sandboxKeys } from "@intentic/ui/storage";
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
// The sandboxes this browser last reached over loopback, by row id (client/endpoint/onThisComputer.ts).
export const ON_THIS_COMPUTER_KEY = accountKey(`intentic.onThisComputer`);

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
// Whether this device has offered the account the preferences it holds (app/accountPreferences.ts); sign-out forgets it.
export const PREFERENCES_OFFERED_KEY = accountKey(`intentic.preferencesOffered`);
// Whose choice each look and reading preference this browser holds is, by preference (app/accountPreferences.ts). The
// device's, as the preferences themselves are: they outlive a sign-out, and the next account in must still be able to
// tell the last one's choices from its own.
export const PREFERENCES_WORN_FOR_KEY = deviceKey(`intentic.preferencesWornFor`);
// The reader's own order of the account's sandboxes (models/home/sandboxOrder.ts) and the sandboxes they told the
// hands-off offer "not now" (features/chat/panel/landing/handsOffOffer.ts): ids of the account's sandboxes, which another
// account on this browser has no business arranging or answering for.
export const SANDBOX_ORDER_KEY = accountKey(`ui-sandbox-order`);
export const HANDS_OFF_DISMISSED_KEY = accountKey(`ui-hands-off-offer-dismissed`);
// The page the installed app last showed (router/recentRoute.ts), which names the account's sandbox: the next account in
// is not reopened on it.
export const LAST_ROUTE_KEY = accountKey(`intentic.lastRoute`);
// Whether a sandbox's access names more than one person, as this account last heard (models/sandbox/useSandboxSharedAccess.ts):
// an owner reads its roster, a member is always one of two, so the answer is the account's.
export const sharedAccessKey = sandboxKeys(`intentic.sharedAccess.`);
// The size each markdown document's workspace picture last loaded at, per sandbox (lib/markdown/pictureSizes.ts).
export const pictureSizesKey = sandboxKeys(`intentic.pictureSizes.`);
// When a setup last opened a sandbox it had just set up, per sandbox (models/sandbox/live/justSetUp.ts).
export const justSetUpKey = sandboxKeys(`intentic.justSetUp.`);
// Whether the chat's usage rail last had anything to show, per sandbox (features/chat/panel/capacity/capacityMemory.ts).
export const capacityRailKey = sandboxKeys(`intentic.capacityRail.`);
// The board's last roster heard, per sandbox, painted before the stream answers (models/fleet/useAgents-registry.ts).
export const rosterKey = sandboxKeys(`intentic.roster.`);

// The transcript mirror (models/conversations/transcript/transcriptCache.ts): up to its last few hundred messages per
// conversation, in IndexedDB, one database per account (accountDatabases.ts). Deleted with that account; a window holding
// it open closes on the version change, so the delete is never blocked by this page.
export const TRANSCRIPT_DATABASE = `intentic.chat`;
// The loading placeholders' imprints (lib/skeletonPersistence.ts): the shapes of the account's sandboxes' views, how many
// secrets, rows and agents each one held, so the account's too.
export const SKELETON_DATABASE = `intentic.skeletons`;

onAccountCleared((account) => deleteAccountDatabases(TRANSCRIPT_DATABASE, account));
onAccountCleared((account) => deleteAccountDatabases(SKELETON_DATABASE, account));
