import type { IconName } from "@intentic/ui";
import { documentsAt } from "../../../core-views/documentRegistry";

// One model for every icon a directory row offers. Documents differ from the management panel: per directory,
// contributed by an extension, not known here. The tree just renders what it's given and runs the click; this module
// decides what those are.

export interface RowAction {
    // Stable per row, the v-for key, and what a test names.
    readonly id: string;
    readonly icon: IconName;
    // Names the action ("Open management panel", not "Management panel").
    readonly tooltip: string;
    // True when the icon itself is evidence (e.g. a page exists); actions you can do to a repo stay hover-only.
    readonly standing: boolean;
    readonly run: () => void;
}

// The affordances the app itself puts on a row, plus whatever the open document providers offer for it.
export interface RowActionSources {
    // A maker's row: what the directory is (documents) and what can be opened (manage); the persona and check
    // affordances are a developer's and stay off.
    readonly plain?: boolean;
    // Directory paths a directory-surface extension serves. One cog per repository, behind which sit its git history,
    // docs, health, apps and dependencies as tabs, rather than an icon each on the row.
    readonly manageableDirs: ReadonlySet<string>;
    // Count of personas starting here, not a set: the icon says whether there's one or several.
    readonly personaDirs: ReadonlyMap<string, number>;
    // Repositories that declare checks of their own, and whether those are running: the icon is evidence the file
    // exists, and its tooltip is the one thing a reader wants from it, which is whether anything happens.
    readonly checkDirs: ReadonlyMap<string, { readonly adopted: boolean; readonly changed: boolean }>;
    readonly openDirectory: (dir: string) => void;
    readonly openPersonas: (dir: string) => void;
    readonly openChecks: (dir: string) => void;
    readonly openDocument: (extension: string, provider: string, path: string, title: string, icon: string) => void;
}

// Actions in reading order: what the directory is (documents), what it carries (personas, checks), and the one thing
// that can be done to it (open its management panel). Called per row on every render, so lookups here stay cheap.
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
    if (sources.plain === true) {
        return [...actions, ...manageAction(dir, sources)];
    }
    // Shown only once a folder has a persona (standing: true), evidence-tier like a document. Personas are set up in
    // sandbox settings; an empty folder offers no hover action either.
    const personaCount = sources.personaDirs.get(dir) ?? 0;
    if (personaCount > 0) {
        actions.push({
            id: `personas`,
            icon: `user`,
            tooltip: personaCount === 1 ? `Change who works here: 1 persona` : `Change who works here, ${personaCount} personas`,
            standing: true,
            run: (): void => sources.openPersonas(dir),
        });
    }
    /* A repository check action points to the checked file, not the repository itself. */
    const checks = sources.checkDirs.get(dir);
    if (checks !== undefined) {
        actions.push({
            id: `checks`,
            icon: `shield`,
            tooltip: checks.changed
                ? `Its checks changed since you switched them on, so they are not running`
                : checks.adopted
                  ? `Checks this repository runs on its own code`
                  : `This repository declares checks, not switched on`,
            standing: true,
            run: (): void => sources.openChecks(dir),
        });
    }
    return [...actions, ...manageAction(dir, sources)];
};

// The one affordance a directory row carries, hover-only and the half of the row both audiences get: everything a
// repository offers to be read or run lives behind it, as a tab.
const manageAction = (dir: string, sources: RowActionSources): RowAction[] =>
    sources.manageableDirs.has(dir)
        ? [
              {
                  id: `directory`,
                  icon: `cog`,
                  tooltip: `Open management panel`,
                  standing: false,
                  run: (): void => sources.openDirectory(dir),
              },
          ]
        : [];
