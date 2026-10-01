import { STATE_DIR } from "@intentic/constants";
import type { IconName, Tip } from "@intentic/ui";
import type { LandConflict, LandConflictReason } from "@intentic/sandbox-contract";
import { errands, errandPrompt } from "../../chat/run/errands";
import { t } from "@intentic/ui/i18n";

// Land conflict causes, and who can clear each:
// - diverged: main moved under the agent; the agent rebases and resolves in its own worktree
// - binary: no automatic merge; the agent re-creates the file or picks a side
// - workspace: user has uncommitted edits; only the user can commit or stash

// One blocked path with its repo; flattened since the wire groups by repo and the UI groups by cause.
export interface Blocker {
    readonly repo: string;
    readonly path: string;
    readonly reason: LandConflictReason;
}

export const blockersOf = (conflicts: readonly LandConflict[] | undefined): readonly Blocker[] =>
    (conflicts ?? []).flatMap((conflict) => conflict.paths.map((blocked) => ({ repo: conflict.repo, path: blocked.path, reason: blocked.reason })));

// Repo-qualified like a review row's label: the root repo's paths read as themselves, a nested repo's carry the
// repo prefix.
export const blockerLabel = (blocker: Blocker): string => (blocker.repo === `root` ? blocker.path : `${blocker.repo}/${blocker.path}`);

// The agent's half: everything a rebase in its own worktree can reconcile.
export const agentBlockers = (blockers: readonly Blocker[]): readonly Blocker[] => blockers.filter((blocker) => blocker.reason !== `workspace`);

// The user's half: paths held by uncommitted edits, clearable only by a commit or stash.
export const userBlockers = (blockers: readonly Blocker[]): readonly Blocker[] => blockers.filter((blocker) => blocker.reason === `workspace`);

// The Sandbox pages that write a root-repo file themselves: what a refusal names as the origin of an "edit" nobody typed.
// Every one of them commits its own writes now (the daemon's settings-versions.ts); one still uncommitted is older than
// that, or was saved over edits already in the file, which the daemon leaves uncommitted. Refused as the owner's own
// edits, one took three Accepts, a trip to Changes and a redo to get a land through.
export type SettingsPage = `personas` | `capabilities` | `agent`;
const SETTINGS_FILES: readonly (readonly [path: string, page: SettingsPage])[] = [
    [`${STATE_DIR}/config/personas.json`, `personas`],
    [`${STATE_DIR}/config/personas/`, `personas`],
    [`${STATE_DIR}/config/capabilities.json`, `capabilities`],
    [`${STATE_DIR}/config/settings.json`, `agent`],
    [`${STATE_DIR}/config/safety.md`, `agent`],
];

export const settingsPageOf = (blocker: Blocker): SettingsPage | undefined =>
    blocker.repo === `root`
        ? SETTINGS_FILES.find(([path]) => (path.endsWith(`/`) ? blocker.path.startsWith(path) : blocker.path === path))?.[1]
        : undefined;

// The pages the user's half came from, when every file in it was written by one: then saving them keeps nothing the
// owner has not already chosen on that page. Undefined when any file is an edit of their own, which only they can judge.
export const settingsOrigin = (blockers: readonly Blocker[]): readonly SettingsPage[] | undefined => {
    const pages = blockers.map(settingsPageOf);
    if (pages.length === 0 || pages.includes(undefined)) {
        return undefined;
    }
    return [...new Set(pages.filter((page): page is SettingsPage => page !== undefined))];
};

// A page as the Sandbox view names it.
export const settingsPageName = (page: SettingsPage): string =>
    ({ personas: t(`shared.personas`), capabilities: t(`shared.capabilities`), agent: t(`shared.agent`) })[page];

// The pages behind the owner's half of a land report, named and joined as the report's heading names them; undefined
// unless a page wrote every file in it. The board card reads it too, so the two never name one refusal differently.
export const settingsPagesOf = (conflicts: readonly LandConflict[] | undefined): string | undefined =>
    settingsOrigin(userBlockers(blockersOf(conflicts)))
        ?.map(settingsPageName)
        .join(`, `);

// Per-cause copy shared by the group heading and row mark; `icon` links them so they can't drift. Order below is
// the report's group order (agent causes first, then the user's):
// - mark: one word, beside a path and diffstat
// - title: plural group heading
// - fix: button-ladder text
// - row: the row mark's hover card, the cause in two words and what clears it
export const reasonCopy = (): Record<LandConflictReason, { icon: IconName; mark: string; title: string; fix: string; row: Tip }> => ({
    diverged: {
        icon: `sync`,
        mark: `moved`,
        title: t(`agents.conflictResolution.workspaceMovedOnSince`),
        fix: `The agent can rebase onto it and merge these itself.`,
        row: { title: t(`agents.conflictResolution.rowTip.diverged.title`), note: t(`agents.conflictResolution.rowTip.diverged.note`) },
    },
    workspace: {
        icon: `user`,
        mark: `yours`,
        title: t(`agents.conflictResolution.uncommittedEditsTo`),
        fix: `Only you can clear this, git cannot merge through unstaged work, and the agent's checkout cannot see it.`,
        row: { title: t(`agents.conflictResolution.rowTip.workspace.title`), note: t(`agents.conflictResolution.rowTip.workspace.note`) },
    },
    binary: {
        icon: `image`,
        mark: `binary`,
        title: t(`agents.conflictResolution.binaryFilesNoAutomatic`),
        fix: `The agent can re-create them against the current file, or pick a side.`,
        row: { title: t(`agents.conflictResolution.rowTip.binary.title`), note: t(`agents.conflictResolution.rowTip.binary.note`) },
    },
});

// Why each path is blocked, addressed to the agent; distinct from REASON_COPY, which speaks to the user.
const REASON_BRIEF: Record<LandConflictReason, string> = {
    diverged: `the main line's committed content moved under you since you branched`,
    binary: `git has no automatic merge for a binary file, so re-create it against the current one or pick a side deliberately`,
    workspace: `the user has uncommitted edits of their own here`,
};

// Grouped under a repo heading (the `cd` the agent implies) rather than repo-qualified per line. `reasons` is off
// when a listing's whole set already shares one cause, stated once by the section itself.
const listing = (blockers: readonly Blocker[], reasons: boolean): string => {
    const byRepo = new Map<string, Blocker[]>();
    for (const blocker of blockers) {
        const bucket = byRepo.get(blocker.repo);
        if (bucket === undefined) {
            byRepo.set(blocker.repo, [blocker]);
        } else {
            bucket.push(blocker);
        }
    }
    return [...byRepo]
        .map(([repo, group]) =>
            [repo, ...group.map((blocker) => `  - ${blocker.path}${reasons ? `, ${REASON_BRIEF[blocker.reason]}` : ``}`)].join(`\n`),
        )
        .join(`\n`);
};

// Builds an ERRAND turn (errands.ts); the opening paragraph must match the registry text or the transcript stops
// recognizing it. Required for the turn to succeed:
// - commit first (rebase refuses a dirty tree)
// - name the main branch
// - keep both sides of each conflict
// Named main line, when every conflicted repo agrees (the normal case, since a workspace's repos branch
// together). Falls back to self-discovery when repos disagree or a name is missing.
const sharedMainBranch = (conflicts: readonly LandConflict[] | undefined): string | undefined => {
    const names = new Set((conflicts ?? []).map((conflict) => conflict.mainBranch));
    const only = names.size === 1 ? [...names][0] : undefined;
    return only === undefined || only === `` ? undefined : only;
};

export const resolvePrompt = (conflicts: readonly LandConflict[] | undefined): string => {
    const blockers = blockersOf(conflicts);
    const mine = agentBlockers(blockers);
    const theirs = userBlockers(blockers);
    const main = sharedMainBranch(conflicts);
    return errandPrompt(errands().landConflict, [
        [
            `1. \`git add -A && git commit\`: a rebase refuses to start on a dirty tree.`,
            main === undefined
                ? `2. \`git rebase <branch>\`, where \`<branch>\` is the one in brackets on the FIRST line of \`git worktree list\`, the user's main line. If the rebase gets away from you: \`git rebase --abort\`, then \`git merge <branch>\` instead.`
                : `2. \`git rebase ${main}\`, that is the user's main line. If the rebase gets away from you: \`git rebase --abort\`, then \`git merge ${main}\` instead.`,
            `3. Resolve each conflict keeping the intent of BOTH sides: your change and whatever moved underneath it. Do not take one side wholesale.`,
            `4. Check what you resolved: re-run the tests of the files the conflicts were in, not the project's whole suite; CI runs the rest on what is pushed.`,
        ].join(`\n`),
        `What blocked the land:\n${listing(mine, true)}`,
        ...(theirs.length === 0
            ? []
            : [
                  `Leave these alone: the user has uncommitted edits on them, which only they can clear; rebasing will not unblock them:\n${listing(theirs, false)}`,
              ]),
        `Stay inside your own worktree: never edit, stage or commit in the user's checkout. The app re-lands automatically when your turn ends, stop once the rebase is clean.`,
    ]);
};
