import { STATE_DIR } from "@intentic/constants";
import type { FileContribution } from "@intentic/extension-manifest";
import { describe, expect, it } from "vitest";
import {
    BACKED_UP_STATE_PATHS,
    isLockedWorkspacePath,
    isReportedManifest,
    isReviewableLockedPath,
    LOCKED_STATE_ENTRIES,
    lockedWorkspaceEntry,
    PLAN_DOCUMENTS_DIR,
    REPORTED_MANIFEST_PATHS,
    SEARCHABLE_STATE_PATHS,
    SHARED_STATE_PATHS,
    STATE_GROUP_DIR,
    type StateGroup,
    stateGroupOf,
    stateGroupPaths,
    staleQueryKeys,
    UNBACKED_STATE_PATHS,
    VERSIONED_STATE_PATHS,
    WORKSPACE_STATE_FILES,
} from "./workspace-state.js";

// What automations declares; literal here to avoid inverting the dependency on a real extension package.
const AUTOMATIONS: readonly FileContribution[] = [
    { path: `${STATE_DIR}/config/automations.json`, invalidates: [`automations`] },
    { path: `${STATE_DIR}/records/approvals/`, invalidates: [`automation-approvals`] },
];

describe(`staleQueryKeys`, () => {
    it(`maps a manifest write to the queries it makes stale`, () => {
        expect(staleQueryKeys([`.intentic/config/capabilities.json`], [])).toEqual([`capabilities`, `environment`, `panels`, `manifests`]);
    });

    it(`refreshes the unreadable-manifest notice for the three files a person hand-edits`, () => {
        const carries = WORKSPACE_STATE_FILES.filter((file) => file.invalidates.includes(`manifests`)).map((file) => file.path);
        expect(carries.toSorted()).toEqual([
            `.intentic/config/capabilities.json`,
            `.intentic/config/personas.json`,
            `.intentic/config/settings.json`,
        ]);
    });

    it(`matches a name family and a one-file-per-entry directory through one prefix each`, () => {
        // environment.Dockerfile, environment.custom.Dockerfile and environment.approved.Dockerfile share one entry.
        expect(staleQueryKeys([`.intentic/config/environment.custom.Dockerfile`], [])).toEqual([`environment`]);
        expect(staleQueryKeys([`.intentic/config/approvals/post-1.json`], [])).toEqual([`approvals`]);
    });

    it(`refreshes the Approvals view when the AGENT writes a proposal`, () => {
        // The approvals skill writes these files directly; the watcher push is the only signal available.
        expect(staleQueryKeys([`.intentic/config/approvals/post-1.json`], [])).toEqual([`approvals`]);
    });

    it(`ignores unrelated churn under .intentic/`, () => {
        // iq's index and a session transcript: frequent enough writes to storm every query under a prefix-only match.
        expect(staleQueryKeys([`.intentic/local/cache/iq/index.db`, `.intentic/records/sessions/claude/projects/p/session.jsonl`], [])).toEqual([]);
    });

    it(`ignores a store's own temp file while it is mid-swap`, () => {
        // jsonFile's atomic-rename temp name: `.<name>.<pid>.tmp` beside the target.
        expect(staleQueryKeys([`.intentic/.settings.json.42.tmp`], [])).toEqual([]);
        expect(staleQueryKeys([`.intentic/config/settings.json`], [])).toEqual([`settings`, `manifests`]);
    });

    it(`ignores ordinary workspace edits`, () => {
        expect(staleQueryKeys([`src/main.ts`, `README.md`], [])).toEqual([]);
    });

    it(`dedupes keys across a batch that touches several manifests`, () => {
        // A capability add recomposes the overlay, so both paths claim environment; one entry, not two.
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
        // automations is the extension's own query key; with it not running, no cache entry exists for it.
        expect(staleQueryKeys([`.intentic/config/automations.json`, `.intentic/records/approvals/a1.json`], [])).toEqual([]);
    });

    it(`lets an extension claim a path the core table deliberately ignores`, () => {
        // Unioned flat with the core table: a narrow extension entry still fires under an ignored core prefix.
        const nested: readonly FileContribution[] = [{ path: `${STATE_DIR}/records/sessions/claude/plans/`, invalidates: [`plans`] }];
        expect(staleQueryKeys([`.intentic/records/sessions/claude/plans/a-plan.md`], nested)).toEqual([`plans`]);
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

// A file is on the reported-manifest card iff a write to it refreshes the card.
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
        expect(isReportedManifest(`.intentic/records/workflow-runs.json`)).toBe(false);
        expect(isReportedManifest(`.intentic/records/loops.json`)).toBe(false);
        expect(isReportedManifest(`.intentic/records/thread-sessions.json`)).toBe(false);
    });

    it(`reads a platform path with either separator`, () => {
        expect(isReportedManifest(`.intentic\\config\\settings.json`)).toBe(true);
    });

    it(`does not report a file outside the workspace`, () => {
        // What `relative` gives the daemon for a manifest kept under /history.
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
        for (const file of WORKSPACE_STATE_FILES) {
            if (file.invalidates.length === 0) {
                // stringMatching(/\S/), not truthiness: a blank `why` left to quiet the check must still fail.
                expect(file.why, `${file.path} invalidates nothing and must say why`).toEqual(expect.stringMatching(/\S/));
            } else {
                expect(file.why, `${file.path} invalidates queries, so \`why\` is dead weight`).toBeUndefined();
            }
        }
    });

    it(`keeps directory entries slash-terminated so they cannot swallow a sibling`, () => {
        for (const file of WORKSPACE_STATE_FILES.filter((entry) => entry.invalidates.length > 0)) {
            const isFamilyPrefix = file.path.endsWith(`.`);
            // .md is the safety policy: the one state file a model reads as prose rather than a parser reading JSON.
            const isFile = file.path.endsWith(`.json`) || file.path.endsWith(`.Dockerfile`) || file.path.endsWith(`.md`);
            expect(isFile || isFamilyPrefix || file.path.endsWith(`/`), file.path).toBe(true);
        }
    });

    it(`only nests under an entry that invalidates nothing, so one write can't be billed twice`, () => {
        // Longest-match applies to portability, not invalidation: staleQueryKeys unions every match instead.
        for (const file of WORKSPACE_STATE_FILES.filter((entry) => entry.invalidates.length > 0)) {
            const nested = WORKSPACE_STATE_FILES.filter((other) => other !== file && other.path.startsWith(file.path));
            expect(
                nested.map((other) => other.path),
                `${file.path} invalidates ${file.invalidates.join(`, `)} and is a prefix of another entry`,
            ).toEqual([]);
        }
    });

    it(`splits a nested entry from its parent for a reason the parent doesn't already carry`, () => {
        // A nest agreeing with its parent is dead weight: stateFileFor resolves to the same answer either way.
        for (const file of WORKSPACE_STATE_FILES) {
            for (const parent of WORKSPACE_STATE_FILES.filter((other) => other !== file && file.path.startsWith(other.path))) {
                expect(
                    parent.portability === file.portability && parent.invalidates.join(",") === file.invalidates.join(","),
                    `${file.path} says nothing its parent ${parent.path} doesn't already say`,
                ).toBe(false);
            }
        }
    });
});

// The lock rule the daemon enforces and the explorer draws, from one shared list.
describe(`isLockedWorkspacePath`, () => {
    it(`covers the root state dir's credential entries, and their subtrees whole`, () => {
        expect(isLockedWorkspacePath(`.intentic/config/capabilities.json`)).toBe(true);
        expect(isLockedWorkspacePath(`.intentic/identity/owner.json`)).toBe(true);
        // A whole lifecycle root: a new provider under it is covered without a second edit.
        expect(isLockedWorkspacePath(`.intentic/secrets/auth`)).toBe(true);
        expect(isLockedWorkspacePath(`.intentic/secrets/auth/codex/auth.json`)).toBe(true);
        expect(isLockedWorkspacePath(`.intentic/local/browser/Default/Cookies`)).toBe(true);
    });

    it(`leaves the state dir's ordinary manifests alone`, () => {
        // The dir itself is browsable; most of what's in it is fine for a person to read.
        expect(isLockedWorkspacePath(`.intentic`)).toBe(false);
        expect(isLockedWorkspacePath(`.intentic/config/settings.json`)).toBe(false);
        expect(isLockedWorkspacePath(`.intentic/config/approvals/post-1.json`)).toBe(false);
    });

    it(`locks the ROOT's own .git and nobody else's`, () => {
        // The root's .git points at the shadow history repo, kept where the agent can't rewrite it.
        expect(isLockedWorkspacePath(`.git`)).toBe(true);
        expect(isLockedWorkspacePath(`.git/config`)).toBe(true);
        expect(isLockedWorkspacePath(`myrepo/.git/config`)).toBe(false);
        // A repo's own nested .intentic is its project's state, not the daemon's.
        expect(isLockedWorkspacePath(`myrepo/.intentic/config/capabilities.json`)).toBe(false);
    });

    it(`reads a platform path the same as a posix one`, () => {
        expect(isLockedWorkspacePath(`.intentic\\secrets\\auth\\codex`)).toBe(true);
        expect(isLockedWorkspacePath(`./.intentic/config/capabilities.json`)).toBe(true);
    });

    it(`lets the plan documents out of the session store around them`, () => {
        // The plan a card asks you to approve, carved out of the transcripts store, which stays locked around it.
        expect(isLockedWorkspacePath(`${PLAN_DOCUMENTS_DIR}/wiggly-spring.md`)).toBe(false);
        expect(isLockedWorkspacePath(PLAN_DOCUMENTS_DIR)).toBe(false);
        expect(isLockedWorkspacePath(`.intentic/records/sessions/claude/projects/x.jsonl`)).toBe(true);
        expect(isLockedWorkspacePath(`.intentic/records/sessions`)).toBe(true);
        // The directory is exempt, not the word: a similarly-named sibling store is not.
        expect(isLockedWorkspacePath(`.intentic/records/sessions/claude/plans-backup/x.md`)).toBe(true);
    });
});

// Which entry a locked path belongs to, for the refusal screen's message; split from the boolean so the browser reads
// the daemon's own list.
describe(`lockedWorkspaceEntry`, () => {
    it(`names the entry a path matched, not the leaf it ends at`, () => {
        // A locked folder is one un-descended row, so the name worth reporting is the folder's.
        expect(lockedWorkspaceEntry(`.intentic/local/browser/Default/Cookies`)).toBe(`local/browser`);
        expect(lockedWorkspaceEntry(`.intentic/secrets/auth/codex/auth.json`)).toBe(`secrets/auth`);
        expect(lockedWorkspaceEntry(`.intentic/config/capabilities.json`)).toBe(`config/capabilities.json`);
        expect(lockedWorkspaceEntry(`.git/config`)).toBe(`.git`);
    });

    it(`answers undefined for everything the lock does not hold`, () => {
        expect(lockedWorkspaceEntry(`src/app.ts`)).toBeUndefined();
        expect(lockedWorkspaceEntry(`.intentic/config/settings.json`)).toBeUndefined();
        expect(lockedWorkspaceEntry(`${PLAN_DOCUMENTS_DIR}/wiggly-spring.md`)).toBeUndefined();
    });

    it(`answers for every entry the lock declares`, () => {
        // Makes the daemon's set addressable from the browser; an unresolvable entry could only get a generic message.
        for (const entry of LOCKED_STATE_ENTRIES) {
            expect([entry, lockedWorkspaceEntry(`${STATE_DIR}/${entry}`)]).toEqual([entry, entry]);
        }
    });
});

// The carve-out diff routes need: a locked entry the root repo tracks has a diff by construction, so refusing to serve
// it left Changes with an unopenable row.
describe(`isReviewableLockedPath`, () => {
    it(`admits the locked entry the root repo tracks, and nothing else locked`, () => {
        expect(isReviewableLockedPath(`.intentic/config/capabilities.json`)).toBe(true);
        // None of the rest is versioned, so none is diff-reachable; the carve-out can't widen without that flag.
        expect(isReviewableLockedPath(`.intentic/identity/owner.json`)).toBe(false);
        expect(isReviewableLockedPath(`.intentic/identity/members.json`)).toBe(false);
        expect(isReviewableLockedPath(`.intentic/secrets/ci.json`)).toBe(false);
        expect(isReviewableLockedPath(`.intentic/secrets/auth/codex/auth.json`)).toBe(false);
        expect(isReviewableLockedPath(`.intentic/records/sessions/claude/x.jsonl`)).toBe(false);
        expect(isReviewableLockedPath(`.intentic/local/browser/Default/Cookies`)).toBe(false);
        expect(isReviewableLockedPath(`.git/config`)).toBe(false);
    });

    it(`answers only for the locked set: an ordinary path was never refused to begin with`, () => {
        expect(isReviewableLockedPath(`.intentic/config/settings.json`)).toBe(false);
        expect(isReviewableLockedPath(`src/app.ts`)).toBe(false);
        // A repo's own nested state dir is its project's content, same as the lock reads it.
        expect(isReviewableLockedPath(`myrepo/.intentic/config/capabilities.json`)).toBe(false);
    });

    it(`reads a platform path and a dot-relative one the same as a posix one`, () => {
        expect(isReviewableLockedPath(`.intentic\\config\\capabilities.json`)).toBe(true);
        expect(isReviewableLockedPath(`./.intentic/config/capabilities.json`)).toBe(true);
    });

    it(`stays a strict subset of the lock`, () => {
        // A path admitted here that the lock never held would mean the two guards disagree on what's locked.
        for (const path of VERSIONED_STATE_PATHS) {
            expect([path, isReviewableLockedPath(path) && !isLockedWorkspacePath(path)]).toEqual([path, false]);
        }
    });
});

describe(`VERSIONED_STATE_PATHS`, () => {
    // versioned exempts an entry from the `.intentic` exclusion; a mismarked credential can't be unmarked once
    // committed.
    it(`never tracks a credential or an identity binding`, () => {
        const leaked = WORKSPACE_STATE_FILES.filter((file) => file.versioned && (file.portability === `secret` || file.portability === `identity`));
        expect(leaked.map((file) => file.path)).toEqual([]);
    });

    // versioned asks if a human should review it; carry asks if it moves. Frequently-rewritten ledgers are carry only.
    it(`leaves the ledgers and the bulk out even though they travel`, () => {
        for (const path of [
            `.intentic/records/workflow-runs.json`,
            // Split from the tracked automations manifest so a run doesn't dirty it.
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

    // Spelled out rather than derived, so adding a tracked entry is a visible edit here, not a silent side effect.
    it(`tracks exactly the configuration slice plus the agent's own authored output`, () => {
        expect(VERSIONED_STATE_PATHS.toSorted()).toEqual([
            `${STATE_DIR}/config/approvals/`,
            `${STATE_DIR}/config/automations.json`,
            // Which apps the daemon starts at boot: the starter site, plus whatever the owner adds.
            `${STATE_DIR}/config/autostart.json`,
            // Tracked since credential values moved to the vault, leaving shapes only; connecting something merits
            // review.
            `${STATE_DIR}/config/capabilities.json`,
            `${STATE_DIR}/config/capability-dismissals.json`,
            // Context shelves: which repos a conversation opened; a decision about what a session may see, worth
            // review.
            // Agent-authored: a draft publishes under the owner's name; an extension runs code with node:fs access.
            // Which version each agent engine runs; a standing decision worth a `git log` answer to "since when".
            `${STATE_DIR}/config/engines.json`,
            `${STATE_DIR}/config/environment.Dockerfile`,
            `${STATE_DIR}/config/environment.custom.Dockerfile`,
            `${STATE_DIR}/config/environment.d/`,
            `${STATE_DIR}/config/extension-enablement.json`,
            // Twin of the enablement switch, tracked now that its secret values moved to the vault.
            `${STATE_DIR}/config/extension-settings.json`,
            // Per-extension update posture (notify/agent/auto): a standing decision on what may run unattended.
            `${STATE_DIR}/config/extension-update-policy.json`,
            // Which commands count as heavy, and how many may run at once; a shared-box decision worth a `git log`
            // line.
            `${STATE_DIR}/config/heavy-commands.json`,
            // The exclude list carves entries out by name; an unlisted directory is invisible to git and to land.
            `${STATE_DIR}/config/hooks/`,
            `${STATE_DIR}/config/loop-designs.json`,
            `${STATE_DIR}/config/personas.json`,
            // A persona's prompt and reachable skills: the text that decides how it behaves, same reason as its card.
            `${STATE_DIR}/config/personas/`,
            // Prose deciding when the agent stops to ask; the standing answer to "since when did we allow this".
            `${STATE_DIR}/config/safety.md`,
            `${STATE_DIR}/config/settings.json`,
            // Skills the owner wrote: text that changes agent behavior, worth a diff like the rules in settings.json.
            `${STATE_DIR}/config/skills/`,
            `${STATE_DIR}/config/templates.json`,
            `${STATE_DIR}/config/workflows.json`,
            `${STATE_DIR}/config/workspace-extensions/`,
        ]);
    });

    // Both the switch and the code are tracked: an extension has no separate install moment to review.
    it(`tracks a workspace extension's code, not just the switch that enables it`, () => {
        expect(VERSIONED_STATE_PATHS).toContain(`.intentic/config/extension-enablement.json`);
        expect(VERSIONED_STATE_PATHS).toContain(`.intentic/config/workspace-extensions/`);
    });

    // A settled draft stays as a record; a consumed wake is removed, so tracking it would only log a decision twice.
    // Staged docs are tracked once published; tracking the staging tree too would double every page.
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

    // The composed file is rebuilt every boot; tracking it would show the owner a rewrite as their own edit.
    it(`tracks the environment overlay's source but not its composed output`, () => {
        expect(VERSIONED_STATE_PATHS).toContain(`.intentic/config/environment.custom.Dockerfile`);
        expect(VERSIONED_STATE_PATHS).not.toContain(`.intentic/local/environment.approved.Dockerfile`);
    });
});

// stateGroupOf derives from three existing flags rather than a fourth, sound only because authored/versioned entries
// are always `carry`. Nothing enforces that: `versioned` on a `secret` entry would compile and misclassify silently.
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
        // The git exclude reads versioned; the search floor reads versioned||authored. Both must land inside config.
        const written = stateGroupPaths(`config`);
        for (const path of VERSIONED_STATE_PATHS) {
            expect([path, written.includes(path)]).toEqual([path, true]);
        }
        expect(SEARCHABLE_STATE_PATHS.toSorted()).toEqual(written.toSorted());
    });

    it(`sorts the entries a browsing owner would recognise`, () => {
        expect(stateGroupPaths(`config`)).toContain(`.intentic/config/personas/`);
        expect(stateGroupPaths(`config`)).toContain(`.intentic/config/approvals/`);
        expect(stateGroupPaths(`records`)).toContain(`.intentic/records/sessions/claude/`);
        expect(stateGroupPaths(`records`)).toContain(`.intentic/records/artifacts/`);
        expect(stateGroupPaths(`local`)).toContain(`.intentic/local/cache/`);
        expect(stateGroupPaths(`local`)).toContain(`.intentic/local/browser/`);
        expect(stateGroupPaths(`identity`)).toContain(`.intentic/identity/owner.json`);
        expect(stateGroupPaths(`secrets`)).toContain(`.intentic/secrets/auth/`);
    });

    // Replaces five hand-kept path lists; a mistyped literal here is the one thing that breaks them all silently.
    it(`puts every entry physically inside its own group's folder`, () => {
        for (const file of WORKSPACE_STATE_FILES) {
            const expected = `${STATE_GROUP_DIR[stateGroupOf(file)]}/`;
            expect(file.path.startsWith(expected), `${file.path} should sit under ${expected}`).toBe(true);
        }
    });

    // The browser-safe copy lives in @intentic/workspace-ignore, which can't import this package; a failure here means
    // that copy has drifted.
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

// The mount boundary: shared prefixes and tracked entries never overlap, so isolation can bind by group instead of the
// whole state dir.
describe(`SHARED_STATE_PATHS`, () => {
    const under = (path: string, prefix: string): boolean => path === prefix || path.startsWith(prefix);

    it(`is the four untracked groups whole, plus the one untracked entry inside config`, () => {
        expect(SHARED_STATE_PATHS.toSorted()).toEqual([
            `.intentic/config/docs/`,
            `.intentic/identity/`,
            `.intentic/local/`,
            `.intentic/records/`,
            `.intentic/secrets/`,
        ]);
    });

    it(`never covers a tracked entry`, () => {
        for (const path of VERSIONED_STATE_PATHS) {
            expect([path, SHARED_STATE_PATHS.some((shared) => under(path, shared))]).toEqual([path, false]);
        }
    });

    it(`covers every untracked entry`, () => {
        for (const file of WORKSPACE_STATE_FILES) {
            if (file.versioned !== true) {
                expect([file.path, SHARED_STATE_PATHS.some((shared) => under(file.path, shared))]).toEqual([file.path, true]);
            }
        }
    });

    it(`spells every prefix as a directory, so a bind can never prefix-match a sibling`, () => {
        for (const path of SHARED_STATE_PATHS) {
            expect(path.endsWith(`/`), path).toBe(true);
        }
    });
});

// Pins the split: the authored slice that now backs up, and the credentials that still must not.
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

    // identity means never restoring into another sandbox; that doesn't stop the owner keeping their own copy.
    it(`copies the ownership records that may never travel`, () => {
        for (const path of [`.intentic/identity/owner.json`, `.intentic/identity/members.json`, `.intentic/identity/workspace.json`]) {
            expect([path, BACKED_UP_STATE_PATHS.includes(path)]).toEqual([path, true]);
        }
    });

    it(`still withholds the tokens that authenticate against this sandbox`, () => {
        expect(BACKED_UP_STATE_PATHS).not.toContain(`.intentic/identity/control-tokens.json`);
        // The only entry that opts out by hand; everything else follows from its class alone.
        expect(WORKSPACE_STATE_FILES.filter((file) => file.backup === false).map((file) => file.path)).toEqual([
            `.intentic/identity/control-tokens.json`,
        ]);
    });
});
