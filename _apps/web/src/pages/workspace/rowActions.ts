import type { IconName } from "@intentic/ui";
import { documentsAt } from "../../core-views/documentRegistry";

/* WHAT A DIRECTORY ROW OFFERS BESIDE ITS NAME — one model for every icon on the right-hand end of a tree row.
 *
 * These were three hardcoded blocks in WorkspaceTree (health, git history, the management cog), each with its own
 * prop, its own emit and its own handler doing the identical two things. That was already one special case too
 * many when documents arrived as a fourth, and documents differ from the other three in a way the old shape could
 * not express at all: they are per DIRECTORY (fifty-five documented packages in one repo) rather than per repo,
 * and they are contributed by an EXTENSION rather than known here.
 *
 * So the tree stopped knowing what its icons mean. It renders whatever actions the row is given and runs the one
 * that is clicked; this module is where the app decides what those are. */

export interface RowAction {
    // Stable per row — the v-for key, and what a test names.
    readonly id: string;
    readonly icon: IconName;
    // Names the ACTION, since that is how a tooltip on an icon is read: "Open git history", not "Git history".
    readonly tooltip: string;
    readonly run: () => void;
}

// The affordances the app itself puts on a row, plus whatever the open document providers offer for it.
export interface RowActionSources {
    // Directory paths that are git repos — each carries its own health report.
    readonly repoDirs: ReadonlySet<string>;
    // Directory paths a directory-surface extension serves (Apps, the repo's own UI, the dev-server preview).
    readonly manageableDirs: ReadonlySet<string>;
    readonly openHealth: (repo: string) => void;
    readonly openDirectory: (dir: string) => void;
    readonly openDocument: (extension: string, provider: string, path: string, title: string, icon: string) => void;
}

/* One directory's actions, in reading order: what this thing IS first (its documents), then what it has been
 * (health, history), then what you can do to it (manage). Same narrowing as the rail's own order, and it puts the
 * newcomer where a reader looks first rather than at the end of a queue it happens to have joined last.
 *
 * Called per visible row on every render of the tree, so everything here is a set membership or a provider's own
 * lookup — see DocumentProviderRegistration.detect. Reading the document registry here (rather than being handed
 * a precomputed set) is also what makes the icons appear the moment an extension activates or its documents land:
 * the caller is a computed, and this touches the registry's ref. */
export const rowActionsFor = (dir: string, sources: RowActionSources): readonly RowAction[] => {
    const actions: RowAction[] = documentsAt(dir).map(({ provider, offer }) => ({
        id: `document:${provider.owner}:${provider.id}`,
        // An extension's icon is an open string (a bundle may name one this app has never heard of) — an unknown
        // name renders the icon set's fallback rather than failing the row.
        icon: offer.icon as IconName,
        tooltip: offer.tooltip,
        run: (): void => sources.openDocument(provider.owner, provider.id, dir, offer.title, offer.icon),
    }));
    if (sources.repoDirs.has(dir)) {
        actions.push({ id: `health`, icon: `wave-pulse`, tooltip: `Open codebase health`, run: (): void => sources.openHealth(dir) });
    }
    if (sources.manageableDirs.has(dir)) {
        actions.push({ id: `directory`, icon: `cog`, tooltip: `Open management panel`, run: (): void => sources.openDirectory(dir) });
    }
    return actions;
};
