import type { IconName } from "@intentic/ui";
import { documentsAt } from "../../../core-views/documentRegistry";

// One model for every icon a directory row offers. Documents differ from repo-based actions (health, history,
// management): per directory, contributed by an extension, not known here. The tree just renders what it's given and
// runs the click; this module decides what those are.

export interface RowAction {
    // Stable per row, the v-for key, and what a test names.
    readonly id: string;
    readonly icon: IconName;
    // Names the action ("Open git history", not "Git history").
    readonly tooltip: string;
    // True when the icon itself is evidence (e.g. a page exists); actions you can do to a repo stay hover-only.
    readonly standing: boolean;
    readonly run: () => void;
}

// The affordances the app itself puts on a row, plus whatever the open document providers offer for it.
export interface RowActionSources {
    // Directory paths that are git repos, each carries its own health report.
    readonly repoDirs: ReadonlySet<string>;
    // Directory paths a directory-surface extension serves (Apps, the repo's own UI).
    readonly manageableDirs: ReadonlySet<string>;
    // Directory paths the Preview area can show live (a runnable repo, or a monorepo whose apps preview).
    readonly previewableDirs: ReadonlySet<string>;
    // Count of personas starting here, not a set: the icon says whether there's one or several.
    readonly personaDirs: ReadonlyMap<string, number>;
    readonly openHealth: (repo: string) => void;
    readonly openDirectory: (dir: string) => void;
    readonly openPersonas: (dir: string) => void;
    // Opens the Preview area's rail panel with this repo's target selected, not an in-tree tab.
    readonly openPreview: (dir: string) => void;
    readonly openDocument: (extension: string, provider: string, path: string, title: string, icon: string) => void;
}

// Actions in reading order: what the directory is (documents), has been (health, history), and can be done to (persona,
// manage), matching the rail. Called per row on every render, so lookups here stay cheap.
export const rowActionsFor = (dir: string, sources: RowActionSources): readonly RowAction[] => {
    const actions: RowAction[] = documentsAt(dir).map(({ provider, offer }) => ({
        id: `document:${provider.owner}:${provider.id}`,
        // Extension icon is a free string; an unknown name falls back to the icon set's default, not a failure.
        icon: offer.icon as IconName,
        tooltip: offer.tooltip,
        // Standing only when the provider marks its offer as evidence, not an affordance every directory has.
        standing: offer.evidence === true,
        run: (): void => sources.openDocument(provider.owner, provider.id, dir, offer.title, offer.icon),
    }));
    if (sources.repoDirs.has(dir)) {
        actions.push({
            id: `health`,
            icon: `wave-pulse`,
            tooltip: `Open codebase health`,
            standing: false,
            run: (): void => sources.openHealth(dir),
        });
    }
    // Shown only once a folder has a persona (standing: true), evidence-tier like a document. Personas are set up in
    // sandbox settings; an empty folder offers no hover action either.
    const personaCount = sources.personaDirs.get(dir) ?? 0;
    if (personaCount > 0) {
        actions.push({
            id: `personas`,
            icon: `user`,
            tooltip:
                personaCount === 1
                    ? `Change who works here: 1 persona`
                    : `Change who works here, ${personaCount} personas`,
            standing: true,
            run: (): void => sources.openPersonas(dir),
        });
    }
    // Door into the Preview area with this repo's target selected; hover-only, alongside the other things you can do to
    // a repo.
    if (sources.previewableDirs.has(dir)) {
        actions.push({
            id: `preview`,
            icon: `eye`,
            tooltip: `Open live preview`,
            standing: false,
            run: (): void => sources.openPreview(dir),
        });
    }
    if (sources.manageableDirs.has(dir)) {
        actions.push({
            id: `directory`,
            icon: `cog`,
            tooltip: `Open management panel`,
            standing: false,
            run: (): void => sources.openDirectory(dir),
        });
    }
    return actions;
};
