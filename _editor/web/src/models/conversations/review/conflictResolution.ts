import { STATE_DIR } from "@intentic/constants";
import type { IconName, Tip } from "@intentic/ui";
import type { LandConflict, LandConflictReason } from "@intentic/sandbox-contract/schemas/agents";
import { blockersOf, landConflictPrompt, userBlockers, type Blocker } from "@intentic/sandbox-contract/events/land-conflict";
import { t } from "@intentic/ui/i18n";

// Land conflict causes, and who can clear each:
// - diverged: main moved under the agent; the agent rebases and resolves in its own worktree
// - binary: no automatic merge; the agent re-creates the file or picks a side
// - workspace: user has uncommitted edits; only the user can commit or stash

// The blocked paths and the resolve turn are the contract's (events/land-conflict.ts): the daemon sends a home
// conversation the same turn this app sends on a Resolve press.
export { agentBlockers, blockersOf, userBlockers, type Blocker } from "@intentic/sandbox-contract/events/land-conflict";

// Repo-qualified like a review row's label: the root repo's paths read as themselves, a nested repo's carry the
// repo prefix.
export const blockerLabel = (blocker: Blocker): string => (blocker.repo === `root` ? blocker.path : `${blocker.repo}/${blocker.path}`);

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

// Every refused path is a "conflict" to the reader, whatever its cause: one word and one glyph across the bar, the
// filter and the rows. The cause lives in the row's hover card, two words and what clears it.
export const CONFLICT_ICON: IconName = `exclamation-triangle`;
export const reasonCopy = (): Record<LandConflictReason, { row: Tip }> => ({
    diverged: { row: { title: t(`agents.conflictResolution.rowTip.diverged.title`), note: t(`agents.conflictResolution.rowTip.diverged.note`) } },
    workspace: { row: { title: t(`agents.conflictResolution.rowTip.workspace.title`), note: t(`agents.conflictResolution.rowTip.workspace.note`) } },
    binary: { row: { title: t(`agents.conflictResolution.rowTip.binary.title`), note: t(`agents.conflictResolution.rowTip.binary.note`) } },
});

// Why these files conflict, in one line: the cause alone when they share one, a count per cause when they don't.
// `settingsPages` names the Sandbox pages behind the user's half when they wrote all of it.
export const causeLine = (blockers: readonly Blocker[], settingsPages: string | undefined): string | undefined => {
    const counts = new Map<LandConflictReason, number>();
    for (const blocker of blockers) {
        counts.set(blocker.reason, (counts.get(blocker.reason) ?? 0) + 1);
    }
    const said = (reason: LandConflictReason, count: number, alone: boolean): string => {
        const key = reason === `workspace` && settingsPages !== undefined ? `settings` : reason;
        return alone
            ? t(`agents.conflictResolution.cause.${key}`, { pages: settingsPages ?? `` })
            : t(`agents.conflictResolution.causeCount.${key}`, { pages: settingsPages ?? ``, count }, count);
    };
    const reasons = ([`diverged`, `binary`, `workspace`] as const).filter((reason) => counts.has(reason));
    if (reasons.length === 0) {
        return undefined;
    }
    const alone = reasons.length === 1;
    return reasons.map((reason) => said(reason, counts.get(reason) ?? 0, alone)).join(` · `);
};

// The turn a Resolve press sends: the contract's, so the transcript recognises it by the opening it starts with.
export const resolvePrompt = landConflictPrompt;
