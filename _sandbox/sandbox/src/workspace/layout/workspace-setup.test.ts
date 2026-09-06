import { MIRRORED_DIRS } from "@intentic/constants/mirror-roots";
import { MANIFESTS, recipeFor } from "@intentic/workspace-setup";
import { expect, test } from "vitest";

/* THE SEAM BETWEEN READINESS AND ISOLATION, which is not visible from either side alone.
 *
 * `setupStateOf` decides whether a project is installed by looking for its recipe's MARKER, and it looks on the
 * MAIN tree, because that is the tree the daemon holds. Every reader of that answer is an agent turn standing
 * in its own worktree, and a worktree carries tracked files only. So a marker that isolated turns do not mirror
 * makes the daemon report `ready` — "its type-checks, linters and tests mean what they say" — to a turn whose
 * own tree has nothing installed at all, and the model then spends the failure on its own code. That is what
 * `.venv` did before it joined MIRRORED_DIRS: python's marker was in the recipes and in nothing else.
 *
 * Derived from the recipe table rather than listing the two markers that exist today, so the next ecosystem
 * added there (rust's `target`, ruby's `vendor/bundle`) arrives here as a failure naming itself instead of as
 * the same silence. A marker must also be a bare directory NAME: the mirror walk matches names anywhere in the
 * tree (agents/worktrees/isolation.ts), so a nested path could never be found even if it were listed. */
test("every manifest the recipes know yields a marker that isolated turns mirror by name", () => {
    // A node lockfile only names a project alongside its package.json; a python manifest stands alone. Asking
    // both ways is what keeps this about markers rather than about which files a shape needs.
    const markers = [...MANIFESTS].map((manifest) => [manifest, (recipeFor([manifest]) ?? recipeFor([manifest, "package.json"]))?.marker] as const);

    expect(markers.filter(([, marker]) => marker === undefined)).toEqual([]);
    expect(markers.filter(([, marker]) => marker !== undefined && marker.includes("/"))).toEqual([]);
    expect(markers.filter(([, marker]) => marker !== undefined && !MIRRORED_DIRS.has(marker))).toEqual([]);
});
