import { STATE_DIR } from "@intentic/constants";
import type { FileContribution } from "@intentic/extension-manifest";
import { describe, expect, it } from "vitest";
import {
    BACKED_UP_STATE_PATHS,
    isLockedWorkspacePath,
    isReportedManifest,
    isReviewableLockedPath,
    REPORTED_MANIFEST_PATHS,
    SEARCHABLE_STATE_PATHS,
    STATE_GROUP_DIR,
    type StateGroup,
    stateGroupOf,
    stateGroupPaths,
    staleQueryKeys,
    UNBACKED_STATE_PATHS,
    VERSIONED_STATE_PATHS,
    WORKSPACE_STATE_FILES,
} from "./workspace-state.js";

// What the automations extension declares in its manifest, and what the memory extension WOULD declare if the
// watcher reported its files. Literals rather than the real manifests: an extension package importing this one is
// the dependency direction, so reaching back for them here would invert it. The real manifests are checked
// against this rule where they are loaded: web's fileBindings.test.ts and the daemon's file-bindings.test.ts.
const AUTOMATIONS: readonly FileContribution[] = [
    { path: `${STATE_DIR}/config/automations.json`, invalidates: [`automations`] },
    { path: `${STATE_DIR}/records/approvals/`, invalidates: [`automation-approvals`] },
];

describe(`staleQueryKeys`, () => {
    it(`maps a manifest write to the queries it makes stale`, () => {
        expect(staleQueryKeys([`.intentic/config/capabilities.json`], [])).toEqual([`capabilities`, `environment`, `panels`, `manifests`]);
    });

    it(`refreshes the unreadable-manifest notice for the three files a person hand-edits`, () => {
        // Only these three. Every manifest reports what the daemon could not read in it, but a write to one of
        // the twenty-odd DAEMON-written ones cannot introduce a typo, and billing every browser a refetch for
        // each of them is the amplification this table exists to avoid.
        const carries = WORKSPACE_STATE_FILES.filter((file) => file.invalidates.includes(`manifests`)).map((file) => file.path);
        expect(carries.toSorted()).toEqual([
            `.intentic/config/capabilities.json`,
            `.intentic/config/personas.json`,
            `.intentic/config/settings.json`,
        ]);
    });

    it(`matches a name family and a one-file-per-entry directory through one prefix each`, () => {
        // environment.Dockerfile, environment.custom.Dockerfile, environment.approved.Dockerfile: one entry.
        expect(staleQueryKeys([`.intentic/config/environment.custom.Dockerfile`], [])).toEqual([`environment`]);
        expect(staleQueryKeys([`.intentic/config/drafts/post-1.json`], [])).toEqual([`drafts`]);
    });

    it(`refreshes the Drafts view when the AGENT writes a draft`, () => {
        // The regression this table was reorganized around: the drafts skill writes these files directly, so
        // there is no browser mutation to hang an invalidate on: the watcher push is the only signal, and it
        // used to be dropped on the floor.
        expect(staleQueryKeys([`.intentic/config/drafts/post-1.json`], [])).toEqual([`drafts`]);
    });

    it(`ignores unrelated churn under .intentic/`, () => {
        // The amplification that turned an iq index rebuild into an endless request storm: a prefix test on
        // `.intentic/` alone would invalidate every one of these queries for each index write.
        expect(staleQueryKeys([`.intentic/local/cache/iq/index.db`, `.intentic/records/sessions/claude/projects/p/session.jsonl`], [])).toEqual([]);
    });

    it(`ignores a store's own temp file while it is mid-swap`, () => {
        // jsonFile writes `.<name>.<pid>.tmp` beside the target precisely so the atomic rename can't be read as
        // a write to the target itself. A trailing-tag temp would prefix-match and bill an extra refetch.
        expect(staleQueryKeys([`.intentic/.settings.json.42.tmp`], [])).toEqual([]);
        expect(staleQueryKeys([`.intentic/config/settings.json`], [])).toEqual([`settings`, `manifests`]);
    });

    it(`ignores ordinary workspace edits`, () => {
        expect(staleQueryKeys([`src/main.ts`, `README.md`], [])).toEqual([]);
    });

    it(`dedupes keys across a batch that touches several manifests`, () => {
        // A capability add recomposes the overlay, so both entries claim `environment`: one refetch, not two.
        expect(staleQueryKeys([`.intentic/config/capabilities.json`, `.intentic/config/environment.Dockerfile`], [])).toEqual([
            `capabilities`,
            `environment`,
            `panels`,
            `manifests`,
        ]);
    });

    it(`invalidates an extension's queries from its own declaration`, () => {
        expect(staleQueryKeys([`.intentic/config/automations.json`], AUTOMATIONS)).toEqual([`automations`]);
        expect(staleQueryKeys([`.intentic/records/approvals/a1.json`], AUTOMATIONS)).toEqual([`automation-approvals`]);
    });

    it(`makes nothing stale for an extension that is not running`, () => {
        // The reason the live set is passed in rather than read off the installed list: `automations` is the
        // extension's query key, so with the extension gone there is no cache entry for it to be about. The core
        // table used to carry these two keys itself, and would have kept invalidating them either way.
        expect(staleQueryKeys([`.intentic/config/automations.json`, `.intentic/records/approvals/a1.json`], [])).toEqual([]);
    });

    it(`lets an extension claim a path the core table deliberately ignores`, () => {
        // The two lists are unioned flat, not layered: a narrow extension entry under a broad core entry that
        // invalidates nothing must still fire. Without this, every path beneath one of the daemon's
        // machine-state prefixes would be unreachable to extensions.
        const nested: readonly FileContribution[] = [{ path: `${STATE_DIR}/records/sessions/claude/projects/p/memory/`, invalidates: [`memory`] }];
        expect(staleQueryKeys([`.intentic/records/sessions/claude/projects/p/memory/note.md`], nested)).toEqual([`memory`]);
        // …and a sibling under the same core prefix stays ignored.
        expect(staleQueryKeys([`.intentic/records/sessions/claude/projects/p/session.jsonl`], nested)).toEqual([]);
    });

    it(`dedupes a key two extensions both claim`, () => {
        const twice: readonly FileContribution[] = [
            { path: `${STATE_DIR}/config/automations.json`, invalidates: [`automations`] },
            { path: `${STATE_DIR}/config/automations.json`, invalidates: [`automations`] },
        ];
        expect(staleQueryKeys([`.intentic/config/automations.json`], twice)).toEqual([`automations`]);
    });
});

/* Which broken manifests the owner is actually told about. The pair below is the whole invariant: a file is on
 * the card iff a write to it refreshes the card. */
describe(`isReportedManifest`, () => {
    it(`shows exactly the files whose writes refresh the notice`, () => {
        expect(REPORTED_MANIFEST_PATHS.toSorted()).toEqual(
            WORKSPACE_STATE_FILES.filter((file) => file.invalidates.includes(`manifests`))
                .map((file) => file.path)
                .toSorted(),
        );
        expect(isReportedManifest(`.intentic/config/settings.json`)).toBe(true);
    });

    it(`stays quiet about daemon-written state the owner cannot repair`, () => {
        // The regression this exists for: the workflow ledger's records predated a schema that gained a required
        // field, so every read reported the whole file ignored: advice ("fix the file") addressed to nobody,
        // about sixty kilobytes of machine JSON, and refreshed by no write because the ledger feeds no query, so
        // it sat on the card until the daemon restarted. A ledger recovers on its own next write instead.
        expect(isReportedManifest(`.intentic/records/workflow-runs.json`)).toBe(false);
        expect(isReportedManifest(`.intentic/records/loops.json`)).toBe(false);
        expect(isReportedManifest(`.intentic/records/thread-sessions.json`)).toBe(false);
    });

    it(`reads a platform path with either separator`, () => {
        expect(isReportedManifest(`.intentic\\config\\settings.json`)).toBe(true);
    });

    it(`does not report a file outside the workspace`, () => {
        // What `relative` hands the daemon for the manifests it keeps under /history: never nameable on screen.
        expect(isReportedManifest(`../../history/settings.json`)).toBe(false);
    });
});

describe(`WORKSPACE_STATE_FILES`, () => {
    it(`declares every entry under .intentic/, root-relative and forward-slash`, () => {
        for (const file of WORKSPACE_STATE_FILES) {
            expect(file.path.startsWith(`.intentic/`), file.path).toBe(true);
            expect(file.path.includes(`\\`), file.path).toBe(false);
        }
    });

    it(`states a reason for every entry that invalidates nothing`, () => {
        // An empty `invalidates` is a real answer (daemon machine state, a deliberately-polled surface, a path
        // whose query keys belong to an extension), but a SILENT one is indistinguishable from the omission this
        // table exists to prevent, which is exactly how drafts went missing. Requiring the reason is what makes
        // the difference visible at review time.
        for (const file of WORKSPACE_STATE_FILES) {
            if (file.invalidates.length === 0) {
                expect(file.why, `${file.path} invalidates nothing and must say why`).toBeTruthy();
            } else {
                expect(file.why, `${file.path} invalidates queries, so \`why\` is dead weight`).toBeUndefined();
            }
        }
    });

    it(`keeps directory entries slash-terminated so they cannot swallow a sibling`, () => {
        // `.intentic/config/drafts` without the slash would also prefix-match a future `.intentic/drafts-archive.json`.
        for (const file of WORKSPACE_STATE_FILES.filter((entry) => entry.invalidates.length > 0)) {
            const isFamilyPrefix = file.path.endsWith(`.`);
            const isFile = file.path.endsWith(`.json`) || file.path.endsWith(`.Dockerfile`);
            expect(isFile || isFamilyPrefix || file.path.endsWith(`/`), file.path).toBe(true);
        }
    });

    it(`only nests under an entry that invalidates nothing, so one write can't be billed twice`, () => {
        // Entries may nest when a subtree needs a different portability class: stateFileFor's longest match
        // keeps that unambiguous. Invalidation has no longest-match rule: staleQueryKeys unions every
        // matching entry, so a nest under an entry that DOES invalidate would bill the outer view's queries for
        // a write that belongs to the inner one. Nesting is therefore only legal beneath an empty `invalidates`.
        for (const file of WORKSPACE_STATE_FILES.filter((entry) => entry.invalidates.length > 0)) {
            const nested = WORKSPACE_STATE_FILES.filter((other) => other !== file && other.path.startsWith(file.path));
            expect(
                nested.map((other) => other.path),
                `${file.path} invalidates ${file.invalidates.join(`, `)} and is a prefix of another entry`,
            ).toEqual([]);
        }
    });

    it(`splits a nested entry from its parent for a reason the parent doesn't already carry`, () => {
        // A nest that agrees with the entry it sits under is a duplicate: stateFileFor resolves to the same
        // answer either way, so the split is dead weight the next reader has to diff to discover.
        for (const file of WORKSPACE_STATE_FILES) {
            for (const parent of WORKSPACE_STATE_FILES.filter((other) => other !== file && file.path.startsWith(other.path))) {
                expect(
                    parent.portability === file.portability && parent.invalidates.join() === file.invalidates.join(),
                    `${file.path} says nothing its parent ${parent.path} doesn't already say`,
                ).toBe(false);
            }
        }
    });
});

/* The rule the daemon enforces and the explorer draws. Both sides read it from here, which is the point: the
 * padlock on a row and the refusal behind it can no longer disagree. */
describe(`isLockedWorkspacePath`, () => {
    it(`covers the root state dir's credential entries, and their subtrees whole`, () => {
        expect(isLockedWorkspacePath(`.intentic/config/capabilities.json`)).toBe(true);
        expect(isLockedWorkspacePath(`.intentic/identity/owner.json`)).toBe(true);
        // A whole lifecycle root, so a provider added under it is covered without a second edit.
        expect(isLockedWorkspacePath(`.intentic/secrets/auth`)).toBe(true);
        expect(isLockedWorkspacePath(`.intentic/secrets/auth/codex/auth.json`)).toBe(true);
        expect(isLockedWorkspacePath(`.intentic/local/browser/Default/Cookies`)).toBe(true);
    });

    it(`leaves the state dir's ordinary manifests alone`, () => {
        // The dir itself is browsable, and most of what is in it is a file a person may legitimately read.
        expect(isLockedWorkspacePath(`.intentic`)).toBe(false);
        expect(isLockedWorkspacePath(`.intentic/config/settings.json`)).toBe(false);
        expect(isLockedWorkspacePath(`.intentic/config/drafts/post-1.json`)).toBe(false);
    });

    it(`locks the ROOT's own .git and nobody else's`, () => {
        // The root's is the pointer to the shadow history repo, kept where the agent cannot rewrite it; a
        // repo's own .git is ordinary content that stays browsable.
        expect(isLockedWorkspacePath(`.git`)).toBe(true);
        expect(isLockedWorkspacePath(`.git/config`)).toBe(true);
        expect(isLockedWorkspacePath(`myrepo/.git/config`)).toBe(false);
        // …and a repo's own nested state dir is its project's, not the daemon's.
        expect(isLockedWorkspacePath(`myrepo/.intentic/config/capabilities.json`)).toBe(false);
    });

    it(`reads a platform path the same as a posix one`, () => {
        expect(isLockedWorkspacePath(`.intentic\\secrets\\auth\\codex`)).toBe(true);
        expect(isLockedWorkspacePath(`./.intentic/config/capabilities.json`)).toBe(true);
    });
});

/* The carve-out the diff routes ask for, and the reason it is derived: a locked entry the root repo TRACKS has
 * a diff by construction, and refusing to serve it made the Changes panel list a row it could not open. */
describe(`isReviewableLockedPath`, () => {
    it(`admits the locked entry the root repo tracks, and nothing else locked`, () => {
        expect(isReviewableLockedPath(`.intentic/config/capabilities.json`)).toBe(true);
        // Every other locked entry is a credential, an identity binding or private runtime state. None is
        // versioned, so none is reachable through a diff: the carve-out cannot widen without the flag.
        expect(isReviewableLockedPath(`.intentic/identity/owner.json`)).toBe(false);
        expect(isReviewableLockedPath(`.intentic/identity/members.json`)).toBe(false);
        expect(isReviewableLockedPath(`.intentic/secrets/ci.json`)).toBe(false);
        expect(isReviewableLockedPath(`.intentic/secrets/auth/codex/auth.json`)).toBe(false);
        expect(isReviewableLockedPath(`.intentic/records/sessions/claude/x.jsonl`)).toBe(false);
        expect(isReviewableLockedPath(`.intentic/local/browser/Default/Cookies`)).toBe(false);
        expect(isReviewableLockedPath(`.git/config`)).toBe(false);
    });

    it(`answers only for the locked set: an ordinary path was never refused to begin with`, () => {
        // Tracked, but not locked: the guards never ask this of them, and a `true` here would read as "this
        // path needed a carve-out", which is a different and wrong statement.
        expect(isReviewableLockedPath(`.intentic/config/settings.json`)).toBe(false);
        expect(isReviewableLockedPath(`src/app.ts`)).toBe(false);
        // A repo's own nested state dir is its project's content, exactly as the lock reads it.
        expect(isReviewableLockedPath(`myrepo/.intentic/config/capabilities.json`)).toBe(false);
    });

    it(`reads a platform path and a dot-relative one the same as a posix one`, () => {
        expect(isReviewableLockedPath(`.intentic\\config\\capabilities.json`)).toBe(true);
        expect(isReviewableLockedPath(`./.intentic/config/capabilities.json`)).toBe(true);
    });

    it(`stays a strict subset of the lock`, () => {
        // The carve-out is about which locked paths a DIFF may serve. A path it admits that the lock never
        // held would mean the guards had stopped agreeing on what the control plane is.
        for (const path of VERSIONED_STATE_PATHS) {
            expect([path, isReviewableLockedPath(path) && !isLockedWorkspacePath(path)]).toEqual([path, false]);
        }
    });
});

describe(`VERSIONED_STATE_PATHS`, () => {
    /* THE ONE ASSERTION THAT MUST NEVER GO GREEN BY ACCIDENT.
     *
     * `versioned` carves an entry out of the root repo's wholesale `.intentic` exclusion, so marking one is the
     * difference between a file the owner reviews and a file the next baseline commit publishes into `git log`
     * forever. A credential marked by a hurried hand is not recoverable by unmarking it later: the commit is
     * already written, which is why the refusal is mechanical here rather than a rule in a comment. */
    it(`never tracks a credential or an identity binding`, () => {
        const leaked = WORKSPACE_STATE_FILES.filter((file) => file.versioned && (file.portability === `secret` || file.portability === `identity`));
        expect(leaked.map((file) => file.path)).toEqual([]);
    });

    /* Narrower than `carry` ON PURPOSE, and this is where that stays true. The two answer different questions:
     * carry is "does it move to a new sandbox", versioned is "should a human review it changing", so the
     * ledgers and the bulk are `carry` and deliberately absent: the run ledger is rewritten several times per
     * workflow step, the usage batch every few seconds a browser is open, and the transcripts run to hundreds of
     * megabytes. Tracking any of them buries the owner's code review under machine noise. */
    it(`leaves the ledgers and the bulk out even though they travel`, () => {
        for (const path of [
            `.intentic/records/workflow-runs.json`,
            // Split out of the tracked automations manifest precisely so a fire stops dirtying it: the one
            // entry here that would be a REGRESSION rather than an oversight if it ever went tracked.
            `.intentic/records/automation-runs.json`,
            `.intentic/records/loops.json`,
            `.intentic/records/thread-sessions.json`,
            `.intentic/records/extension-usage.json`,
            `.intentic/records/webchat-installs.json`,
            `.intentic/records/sessions/claude/`,
            `.intentic/records/artifacts/`,
        ]) {
            expect([path, VERSIONED_STATE_PATHS.includes(path)]).toEqual([path, false]);
        }
    });

    /* Spelled out rather than derived, so ADDING a tracked entry is a visible edit to this list and not a silent
     * consequence of editing the table above: the review the flag itself exists to force. */
    it(`tracks exactly the configuration slice plus the agent's own authored output`, () => {
        expect(VERSIONED_STATE_PATHS.toSorted()).toEqual([
            `.intentic/config/automations.json`,
            /* The connections themselves, and the entry that took the longest to earn its place: it was classed
             * `secret` on the strength of holding each capability's credential, which stopped being true when the
             * vault took the values out and left the shape behind. Connecting a deployment orchestrator, or
             * granting a connected computer shell and screen control, is the largest change made to what this
             * sandbox can DO, and it used to leave no diff. */
            `.intentic/config/capabilities.json`,
            `.intentic/config/capability-dismissals.json`,
            /* The two entries the AGENT authors on its own initiative, and the reason `versioned` is not read as
             * config-only. Both are the sandbox acting outward: a draft publishes words under the owner's name,
             * a workspace extension is code that runs in the app and can serve HTTP with the workspace under
             * node:fs, and both used to reach that far with no diff anywhere. Kept rather than consumed, one
             * small file at a time, so tracking them yields a record instead of churn. */
            `.intentic/config/drafts/`,
            `.intentic/config/environment.Dockerfile`,
            `.intentic/config/environment.custom.Dockerfile`,
            `.intentic/config/environment.d/`,
            `.intentic/config/extension-enablement.json`,
            /* Its twin, and the pair is the argument: the SWITCH was already tracked while the configuration
             * behind it was not, so a commit could record turning an extension on and say nothing about what it
             * was told to do. Tracked once its declared-secret values moved to the vault. */
            `.intentic/config/extension-settings.json`,
            // The owner's per-extension update posture (notify / agent / auto): a standing decision about
            // what may run unattended, which is exactly the kind of edit worth a line in `git log`.
            `.intentic/config/extension-update-policy.json`,
            // Which commands are heavy enough to take turns, and how many may run at once. Tracked because
            // raising that limit is a decision about every session sharing the box, and `git log` is the only
            // thing that answers "since when have we been allowing four of these at a time".
            `.intentic/config/heavy-commands.json`,
            `.intentic/config/loop-designs.json`,
            `.intentic/config/personas.json`,
            // A persona's own kit: the prompt it runs on and the skills only its turns reach. Tracked for the
            // reason its card is, one step further: this is the text that decides how that persona behaves.
            `.intentic/config/personas/`,
            `.intentic/config/settings.json`,
            // The skills the owner wrote. Tracked for the reason the rules in settings.json are: text that
            // changes how the agent behaves is worth a diff and a line in `git log`.
            `.intentic/config/skills/`,
            `.intentic/config/templates.json`,
            `.intentic/config/workflows.json`,
            `.intentic/config/workspace-extensions/`,
        ]);
    });

    /* THE ASYMMETRY THIS CLOSED, kept as its own assertion because it is the failure rather than a detail of it:
     * the switch was tracked and the thing it switched was not, so a commit could record turning on an extension
     * whose code nobody else could read, and a workspace extension has no install moment to review at instead. */
    it(`tracks a workspace extension's code, not just the switch that enables it`, () => {
        expect(VERSIONED_STATE_PATHS).toContain(`.intentic/config/extension-enablement.json`);
        expect(VERSIONED_STATE_PATHS).toContain(`.intentic/config/workspace-extensions/`);
    });

    /* A QUEUE IS A LEDGER, which is the distinction the two entries above turn on. A draft is kept after it
     * settles (`posted`, with postedAt/postedUrl stamped on it), so tracking it leaves a durable record of what
     * went out; a held wake is REMOVED once answered, so tracking it would leave an add and a delete describing
     * a decision whose outcome lives elsewhere. Same for the staged docs: publishing copies them into the repo,
     * where they are tracked as ordinary content, so tracking the staging tree too would double every page. */
    it(`leaves the consumed queues and the staging trees out even though they are authored`, () => {
        for (const path of [`.intentic/records/approvals/`, `.intentic/config/docs/`]) {
            expect([path, VERSIONED_STATE_PATHS.includes(path)]).toEqual([path, false]);
        }
        // Both still reach workspace search: searchability is a property of the content, not of tracking.
        for (const path of [`.intentic/records/approvals/`, `.intentic/config/docs/`]) {
            const entry = WORKSPACE_STATE_FILES.find((file) => file.path === path);
            expect([path, entry?.versioned === true || entry?.authored === true]).toEqual([path, path === `.intentic/config/docs/`]);
        }
    });

    /* The composed overlay is `derived`: recomposed on every boot from the custom file that IS tracked, against
     * whatever base image this container happens to be on. Tracking it would put a rewritten-at-startup file in
     * front of the owner as a change they made. */
    it(`tracks the environment overlay's source but not its composed output`, () => {
        expect(VERSIONED_STATE_PATHS).toContain(`.intentic/config/environment.custom.Dockerfile`);
        expect(VERSIONED_STATE_PATHS).not.toContain(`.intentic/local/environment.approved.Dockerfile`);
    });
});

/* THE GROUPING, AND THE INVARIANT THAT LETS IT BE DERIVED.
 *
 * `stateGroupOf` reads three existing answers instead of adding a fourth, which is only sound while those answers
 * nest: reviewed and authored entries must all be `carry`, so "did a person write this" never has to be asked of
 * a credential. Nothing in the type system says so, `versioned: true` on a `secret` entry compiles, and the
 * failure would be quiet in the worst way: the entry would group as `secrets` (correctly kept out of the backup)
 * while the git exclude and the search floor, which read `versioned` directly, went on tracking and indexing it.
 * A credential in the owner's diff and in the search index, from one plausible-looking flag. */
describe(`state groups`, () => {
    const GROUPS: readonly StateGroup[] = [`config`, `records`, `local`, `identity`, `secrets`];

    it(`puts every entry in exactly one group, and the groups add back up to the table`, () => {
        const grouped = GROUPS.flatMap((group) => stateGroupPaths(group));
        expect(grouped.toSorted()).toEqual(WORKSPACE_STATE_FILES.map((file) => file.path).toSorted());
        expect(new Set(grouped).size).toBe(WORKSPACE_STATE_FILES.length);
    });

    it(`keeps everything a person writes inside the class that travels`, () => {
        for (const file of WORKSPACE_STATE_FILES) {
            if (file.versioned === true || file.authored === true) {
                expect(file.portability, `${file.path} is authored or reviewed, so it must be carry`).toBe(`carry`);
            }
        }
    });

    it(`agrees with the two lists that were derived before it`, () => {
        // The git exclude reads `versioned` and the search floor reads `versioned || authored`. Both must land
        // inside `config`, or the folder a rule points at stops matching the rule.
        const written = stateGroupPaths(`config`);
        for (const path of VERSIONED_STATE_PATHS) {
            expect([path, written.includes(path)]).toEqual([path, true]);
        }
        expect(SEARCHABLE_STATE_PATHS.toSorted()).toEqual(written.toSorted());
    });

    it(`sorts the entries a browsing owner would recognise`, () => {
        expect(stateGroupPaths(`config`)).toContain(`.intentic/config/personas/`);
        expect(stateGroupPaths(`config`)).toContain(`.intentic/config/drafts/`);
        expect(stateGroupPaths(`records`)).toContain(`.intentic/records/sessions/claude/`);
        expect(stateGroupPaths(`records`)).toContain(`.intentic/records/artifacts/`);
        expect(stateGroupPaths(`local`)).toContain(`.intentic/local/cache/`);
        expect(stateGroupPaths(`local`)).toContain(`.intentic/local/browser/`);
        expect(stateGroupPaths(`identity`)).toContain(`.intentic/identity/owner.json`);
        expect(stateGroupPaths(`secrets`)).toContain(`.intentic/secrets/auth/`);
    });

    /* THE LAYOUT GUARD, and the reason the folders can carry the rules at all.
     *
     * Five prefixes replaced five hand-kept path lists: the git exclude, the search allow-list, the sync backup,
     * the watcher skip, the export bundle, and every one of them is now only as true as the claim that an entry
     * physically SITS in the folder its class puts it in. Nothing else checks that: the paths are literals, and a
     * credential typed into `config/` by mistake would compile, track in git, index in search and copy to the
     * owner's laptop, with each of those rules behaving exactly as designed. This is the one assertion standing
     * between a mistyped literal and that. */
    it(`puts every entry physically inside its own group's folder`, () => {
        for (const file of WORKSPACE_STATE_FILES) {
            const expected = `${STATE_GROUP_DIR[stateGroupOf(file)]}/`;
            expect(file.path.startsWith(expected), `${file.path} should sit under ${expected}`).toBe(true);
        }
    });

    /* The browser profiles' path is copied into @intentic/workspace-ignore (isBrowserProfilePath), which cannot
     * import this package: it is the browser-safe half, deliberately free of zod and the contract surface, so
     * the platform's web bundle can take it. This is the guard that keeps the copy honest. If it fails, the
     * profiles moved and `BROWSER_PROFILE_GROUP` in _sandbox/workspace-ignore/src/constants.ts must move too, or
     * the tree will start eagerly walking a Chromium user-data dir and the watcher will report its churn. */
    it(`keeps the browser profiles where workspace-ignore's copy of the path expects them`, () => {
        expect(WORKSPACE_STATE_FILES.map((file) => file.path)).toContain(`.intentic/local/browser/`);
    });

    it(`gives each group a folder of its own, all directly under the state dir`, () => {
        const dirs = GROUPS.map((group) => STATE_GROUP_DIR[group]);
        expect(new Set(dirs).size).toBe(GROUPS.length);
        for (const dir of dirs) {
            expect(dir.startsWith(`${STATE_DIR}/`)).toBe(true);
            expect(dir.slice(`${STATE_DIR}/`.length).includes(`/`)).toBe(false);
        }
    });

    it(`reads the group off the class, not off the name`, () => {
        const entry = (path: string) => WORKSPACE_STATE_FILES.find((file) => file.path === path)!;
        expect(stateGroupOf(entry(`.intentic/config/settings.json`))).toBe(`config`);
        expect(stateGroupOf(entry(`.intentic/records/loops.json`))).toBe(`records`);
        expect(stateGroupOf(entry(`.intentic/local/tmp/`))).toBe(`local`);
        expect(stateGroupOf(entry(`.intentic/identity/members.json`))).toBe(`identity`);
        expect(stateGroupOf(entry(`.intentic/secrets/ci.json`))).toBe(`secrets`);
    });
});

/* WHAT THE OWNER'S MACHINE KEEPS. The sync ignored the whole state dir, so losing a sandbox lost every persona,
 * skill, automation, draft and transcript in it: a backup that held only the source tree. These pin the two
 * halves of the fix: the slice that now comes down, and the credentials that still must not. */
describe(`BACKED_UP_STATE_PATHS`, () => {
    it(`splits the table in two with nothing falling between`, () => {
        expect([...BACKED_UP_STATE_PATHS, ...UNBACKED_STATE_PATHS].toSorted()).toEqual(WORKSPACE_STATE_FILES.map((file) => file.path).toSorted());
        for (const path of BACKED_UP_STATE_PATHS) {
            expect([path, UNBACKED_STATE_PATHS.includes(path)]).toEqual([path, false]);
        }
    });

    it(`copies down everything a person wrote and everything that happened`, () => {
        for (const path of [...stateGroupPaths(`config`), ...stateGroupPaths(`records`)]) {
            expect([path, BACKED_UP_STATE_PATHS.includes(path)]).toEqual([path, true]);
        }
    });

    it(`never copies a credential, whatever else the entry is`, () => {
        for (const path of stateGroupPaths(`secrets`)) {
            expect([path, BACKED_UP_STATE_PATHS.includes(path)]).toEqual([path, false]);
        }
    });

    it(`leaves the rebuildable bulk behind: it is size, not secrecy`, () => {
        for (const path of stateGroupPaths(`local`)) {
            expect([path, BACKED_UP_STATE_PATHS.includes(path)]).toEqual([path, false]);
        }
    });

    /* The distinction `portability` alone cannot draw, and the reason the `backup` flag exists. Ownership records
     * may never RESTORE into another sandbox: that is what `identity` means, and members.json's own entry argues
     * why. None of that stops the owner keeping a copy of who could drive their own machine. */
    it(`copies the ownership records that may never travel`, () => {
        for (const path of [`.intentic/identity/owner.json`, `.intentic/identity/members.json`, `.intentic/identity/workspace.json`]) {
            expect([path, BACKED_UP_STATE_PATHS.includes(path)]).toEqual([path, true]);
        }
    });

    it(`still withholds the tokens that authenticate against this sandbox`, () => {
        expect(BACKED_UP_STATE_PATHS).not.toContain(`.intentic/identity/control-tokens.json`);
        // And it is the ONLY entry that opts out by hand: everything else follows from its class.
        expect(WORKSPACE_STATE_FILES.filter((file) => file.backup === false).map((file) => file.path)).toEqual([
            `.intentic/identity/control-tokens.json`,
        ]);
    });
});
