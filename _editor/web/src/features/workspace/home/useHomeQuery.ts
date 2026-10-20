import type { WorkspaceTreeEntry } from "@intentic/sandbox-contract/schemas/workspace/workspace-tree";
import { useT } from "@intentic/ui/i18n";
import { computed, inject } from "vue";
import { HOME_SEARCH } from "../../../models/workspace/home/useHome";
import { contentMatches, nameMatches } from "./homeResults";

// The query: the sidebar's own (HOME_SEARCH), answered here under the open folder. Names the home matches itself over
// the loaded tree; text and smart are the daemon's, and the home draws the files its groups name. Typing on the home
// writes the same query, so the tree narrows with it.

export interface HomeQueryContext {
    // The open folder, and its entries (undefined until a folder the walk skipped has been listed).
    readonly dir: () => string;
    readonly children: () => readonly WorkspaceTreeEntry[] | undefined;
    // The tree's lookups: an entry by path, a folder's listing.
    readonly entryAt: (path: string | undefined) => WorkspaceTreeEntry | undefined;
    readonly listingOf: (dir: string) => readonly WorkspaceTreeEntry[] | undefined;
    // The explorer's switches, so the home never lists what the tree hides.
    readonly shows: (entry: WorkspaceTreeEntry) => boolean;
}

export const useHomeQuery = ({ dir, children, entryAt, listingOf, shows }: HomeQueryContext) => {
    const t = useT();
    const search = inject(HOME_SEARCH, undefined);
    const query = computed<string>({
        get: () => search?.filter.value ?? ``,
        set: (value) => {
            if (search !== undefined) {
                search.filter.value = value;
            }
        },
    });
    const querying = computed(() => query.value.trim() !== ``);
    const searching = computed(() => search?.searching.value === true);
    const results = computed(() => {
        if (search === undefined || !querying.value) {
            return [];
        }
        return search.contentMode.value
            ? contentMatches(
                  search.groups.value.map((group) => group.path),
                  dir(),
                  entryAt,
              )
            : nameMatches(query.value, dir(), children() ?? [], (folder) => listingOf(folder.path), shows);
    });
    // The folder each result sits in, for the line under its name; "" (the open folder itself) draws nothing.
    const whereByPath = computed(() => new Map(results.value.map((result) => [result.entry.path, result.where])));
    const placeholder = computed(() =>
        search?.scope.value === `text`
            ? t(`workspace.homeView.searchText`)
            : search?.scope.value === `smart`
              ? t(`workspace.homeView.smartSearch`)
              : t(`workspace.homeView.filterNames`),
    );
    return { search, query, querying, searching, results, whereByPath, placeholder };
};
