import type { ActiveExtension } from "../../../core-views/registry";

// Which tabs one directory's management panel shows, and in what order. Everything a repository offers to be read or
// run is a tab here, which is why its tree row carries one cog rather than an icon per surface. Pure: the live read is
// useDirectoryTabs.ts, which this module must not import back or it stops being testable without a DOM.

// The Git tab: named here because a second surface offers a way into it (the agent review's "show the graph"), and an
// id nothing can find is a button that silently does nothing.
export const GIT_TAB = `git-history-repo`;

// Reading order: what the repository has been (Git), what it says it is (Docs), how it is holding up (Health,
// Maintenance), and what it runs (Apps, Dependencies, UI). Git leads because it is what a repository is opened for
// most; whatever is first here is also what the panel opens on. An unlisted view (a third-party directory surface)
// keeps its detection order at the end.
const TAB_ORDER: readonly string[] = [GIT_TAB, `documentation-repo`, `codebase-health`, `maintenance-repo`, `apps`, `dependencies`, `directory-ui`];

const tabRank = (id: string): number => (TAB_ORDER.includes(id) ? TAB_ORDER.indexOf(id) : TAB_ORDER.length);

// A developer's tabs, hidden from a maker in place: the same audience read the tree row makes (rowActions.ts,
// `plain`), moved here with the surfaces it used to gate.
const DEVELOPER_TABS: ReadonlySet<string> = new Set([GIT_TAB, `codebase-health`]);

// The panel's tabs for `dir`, drawn from every activation the registry resolved.
export const directoryTabs = (activations: readonly ActiveExtension[], dir: string, maker: boolean): readonly ActiveExtension[] =>
    activations
        .filter(
            ({ extension, activation }) =>
                extension.surface === `directory` && activation.repo === dir && !(maker && DEVELOPER_TABS.has(extension.id)),
        )
        .toSorted((left, right) => tabRank(left.extension.id) - tabRank(right.extension.id));
