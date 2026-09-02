import type { StateFile } from "./state-portability.js";

/* WHAT LIVES ON /history, the second half of the daemon's state, and the half nothing declared until an
 * export had to reason about it.
 *
 * `WORKSPACE_STATE_FILES` covers `<workspace>/.intentic/`, which is where the manifests live. It is not where
 * the machinery lives. Every repo's REAL git dir is here (a repo's in-tree `.git` is a pointer file, see
 * git/repo-git-dirs.ts for the invariant that forces it), and so are the fleet registry, the turn journal, the
 * ledgers, the checkpoint scopes and the isolated agents' checkouts. A "workspace export" that took `/work`
 * alone would carry a tree of repos with dangling gitdir pointers, every git command in the restored sandbox
 * answering `fatal: not a git repository`, and an empty agent board.
 *
 * The two tables stay separate rather than becoming one keyed by volume, because they answer different
 * questions. A `.intentic` entry also declares which browser QUERY it makes stale, since the file watcher
 * reports it; nothing here is watched at all (that is the point of the volume), so an `invalidates` field on
 * these entries would be a column of empty arrays. What they share is the portability class, and that is
 * imported rather than duplicated.
 *
 * `history-state-coverage.test.ts` fails when a daemon store builds a `/history` path this list doesn't carry, in both
 * directions, the same shape-recognizing guard that covers the workspace table.
 */

// Paths are historyRoot-relative, forward-slash, matched by PREFIX; a directory entry keeps its trailing slash
// so it cannot prefix-match a sibling file. See stateFileFor for how nesting resolves.
export const HISTORY_STATE_FILES: readonly StateFile[] = [
    /* ---- the machinery a restored workspace is inert without ---- */

    /* THE ONE THAT MAKES A BUNDLE A WORKSPACE. Every repo's real git dir, including the /work root's own
     * ("root"), keyed by URI-encoded repo id. Carrying the working tree without this hands the target files
     * whose `.git` points at a path that does not exist there, which is not a degraded repo but a broken one,
     * and it takes the Changes review, the diff, land and every agent branch with it. The agent BRANCHES live
     * in here too, which is what lets the checkouts below be left out. */
    { path: "gits/", portability: "carry" },
    // The checkpoint timeline (one bare repo per scope, snapshots on refs/snapshots/head). Restoring it is what
    // makes "restore to before that turn" still reach back past the move.
    { path: "scopes/", portability: "carry" },
    // The fleet: every conversation card, its branch, its session ids, its standing.
    { path: "agents.json", portability: "carry" },
    { path: "turns/", portability: "carry" },
    /* THE ARMED CONDITION WATCHES, one file per watch, put back at boot (agent/watchers.ts `restoreWatchers`).
     *
     * Carried for the reason loops.json is: an arrangement the agent entered into on the user's behalf and
     * that is still outstanding travels with the conversation that is waiting on it, or a restored sandbox
     * shows a card parked on a condition nothing will ever check. It can be carried safely because the journal
     * holds no credential, only the NAMES of the environment its check ran with (agent/watch-journal.ts); the
     * values are re-derived on the target from whatever capabilities it actually has, so a watch landing
     * somewhere without them fails its check honestly and ends in a wake that says so, rather than arriving
     * with a working copy of a token the bundle was never supposed to carry. A watch whose isolated checkout
     * did not travel (those are `derived`) is dropped by the restore rather than re-armed against a tree that
     * is not there. */
    { path: "watches/", portability: "carry" },
    { path: "transcripts/", portability: "carry" },
    // What each message can be put back to, a workspace checkpoint, or an isolated conversation's own commits.
    // Carried WITH the transcripts and the scopes above, because it is the join between them: without it a
    // restored conversation reads back whole and offers no way back into it, even though both the messages and
    // the states they name travelled.
    { path: "turn-anchors.json", portability: "carry" },
    /* WHICH CONVERSATIONS ARE PUBLISHED AS PAGES ANYONE WITH THE LINK CAN READ.
     *
     * Carried, and it is the entry with the most to say for itself: the PAGES live in the workspace's outbox
     * (`public/`), so they travel with `/work` whatever this says. Leaving the index behind would restore a
     * sandbox that is still serving somebody's conversation on the internet with nothing in the app that knows
     * it, no row, no link, and no way to stop sharing short of deleting files by hand. The index is what makes
     * a published page withdrawable, so it goes wherever the pages go. */
    { path: "shares.json", portability: "carry" },
    { path: "activity.jsonl", portability: "carry" },
    { path: "usage.jsonl", portability: "carry" },
    { path: "account-usage.json", portability: "carry" },
    { path: "provider-refusals.json", portability: "carry" },
    // Explicit first-time dependency setup requests. Carrying the worklist preserves the owner's decision when
    // an export interrupts the queue before its terminal starts; fulfilled entries remove themselves.
    { path: "dependency-requests.json", portability: "carry" },
    // The deploy engine's own ledgers, a run's events and the check results the Pipelines view reads back.
    { path: "apply-events.ndjson", portability: "carry" },
    { path: "check-events/", portability: "carry" },

    /* ---- regenerated by the target ---- */

    /* THE DELIBERATE OMISSION, and the difference between a bundle of gigabytes and one of hundreds.
     *
     * A conversation's worktree is a full checkout of the monorepo per agent (plus its overlay upper dir), and
     * there can be a hundred of them. None of it is unique: the branch it holds is in `gits/` above, and the
     * registry entry naming it travels in agents.json, so an imported conversation arrives in exactly the
     * shape the system already has a name for. `attached()` reports its checkout as absent, the board renders
     * it, and the next turn's `ensure()` re-creates it from the recorded composition, which is the same path an
     * archived agent takes when it runs again. The boot sweep's `git worktree prune` clears the stale admin
     * entries the restored git dirs still carry. */
    {
        path: "worktrees/",
        portability: "derived",
        note: "Each conversation re-attaches its checkout from its branch on its next turn.",
    },
    /* The phrase index over what every conversation said, which both search boxes read (sessions/search-index.ts).
     * Derived in the strict sense: every row in it was extracted from `transcripts/`, which travels, so a
     * restored sandbox rebuilds it on its first boot rather than carrying tens of megabytes of index that its
     * own backfill would produce anyway. Until that pass finishes the searches answer from what is indexed so
     * far and say so, which is the behaviour they already have on any first run. */
    { path: "said-index/", portability: "derived", note: "Rebuilt from the carried transcripts by the first boot's backfill." },
    { path: "overlays/", portability: "derived" },
    { path: "logs/", portability: "derived" },
    { path: "trash/", portability: "derived" },
    { path: ".isolation-probe", portability: "derived" },
    /* The finished bundles themselves. `derived` is doing real work here rather than describing leftovers: an
     * export that carried the export directory would pack every previous bundle into the new one, and the next
     * export would pack THAT, each one a multiple of the last. Living on this volume is the other half of the
     * same guard; under `/work` the file would also be watched, indexed by iq, and snapshotted into history. */
    { path: "exports/", portability: "derived" },
    /* The other end of the same volume: a bundle being taken IN, spooled here while its owner reads the plan
     * it produced. `derived` for the export directory's reason and one more — this is somebody else's bundle,
     * mid-review, and packing a half-reviewed arrival into an export would carry a sandbox that was never
     * this one. The pipeline deletes each spool on apply or abandon, and boot sweeps whatever a crash left
     * (portability/bundle-arrival.ts). */
    { path: "arrivals/", portability: "derived" },

    /* ---- credentials ---- */

    // The ssh alias dir ~/.ssh/intentic-hosts symlinks to: per-host config, private keys and passphrases for
    // every host capability and git remote the sandbox reaches.
    {
        path: "ssh-hosts/",
        portability: "secret",
        note: "Re-add each ssh host on the Capabilities view, its key does not travel.",
    },
    // The cli-proxy's config, which holds the routed subscriptions' provider tokens.
    {
        path: "translator/",
        portability: "secret",
        note: "Sign the routed AI subscriptions in again on the Agent tab.",
    },

    /* ---- identity: what binds this sandbox to its owner, its browsers and its host ---- */

    /* Signs every browser session cookie. Carrying it would let a bundle's holder mint sessions against the
     * target, an export becomes a credential, and the target minting its own costs exactly one sign-in. */
    { path: "session-secret", portability: "identity", note: "Sign in again, the target signs its own sessions." },
    {
        path: "browser-access-disabled",
        portability: "identity",
        note: "Account-deletion retirement belongs to the source sandbox; the imported copy starts with fresh browser access.",
    },
    {
        path: "push.json",
        portability: "identity",
        note: "Re-enable notifications in the browsers you use, a push subscription is bound to the sandbox that minted it.",
    },
    { path: "sync-enrollments.json", portability: "identity", note: "Re-pair desktop sync from the Sync tab." },
    { path: "sync-pair-consumed.json", portability: "identity" },
    { path: "host-enrollments.json", portability: "identity" },
    /* A connected BROWSER's enrollment (webext/webext-store.ts). Identity for the hosts file's reason and one
     * more of its own: the token admits a socket into somebody's signed-in browser, and that browser was paired
     * with THIS sandbox — carried into another one it would either be dead weight or, worse, a second sandbox
     * holding a live key to a browser its owner never connected it to. Re-pairing is a code and one click. */
    { path: "webext-enrollments.json", portability: "identity", note: "Pair your browser again from its card: the extension is still installed." },
    // The burn list for setup-time computer pairings. Identity, like sync's beside it, and for a sharper reason:
    // carrying it into another sandbox would mark that sandbox's own fresh pairing as already spent.
    { path: "host-pair-consumed.json", portability: "identity" },
    // A runner's enrollment names THIS sandbox as its parent (runners/runners-store.ts): in another sandbox the
    // digest would admit a socket whose runner still dials the old parent. Identity, both files, hosts' reasons.
    { path: "runner-enrollments.json", portability: "identity" },
    { path: "runner-pair-consumed.json", portability: "identity" },
    // The runner-SIDE half: who this container belongs to and the token its reconnects present
    // (runners/runner-identity.ts). Carried into another box it would dial the parent as this runner.
    { path: "runner-identity.json", portability: "identity" },
    { path: "local-cert/", portability: "identity" },
];
