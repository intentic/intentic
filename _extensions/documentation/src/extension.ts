import type { ExtensionContext, IntenticApi } from "@intentic/extension-api";
import { documentationBadge, startDocumentationAttention } from "./attention.js";
import { documentAt, startDocumentPresence } from "./docPresence.js";
import { bindHost } from "./host.js";

/* ext-documentation activation: bind the host handle, start the badge's background poll, then register the two
 * surfaces documentation legitimately has.
 *
 * ONE RAIL TILE, WORKSPACE-WIDE. Documentation is read to answer "how does this system work", and a system is
 * rarely one repository — so the area is workspace-wide and the repo is a dimension inside it, the same shape and
 * for the same reason as Acceptance. A tile per repo would fragment the one thing a reader wants, which is the map.
 *
 * IT ACTIVATES ON ANY REPO, not on documents already existing. This view is where the FIRST document set gets
 * generated, so gating it on documents being present would mean a workspace that has none can never reach the
 * surface that creates them. "There is code here that could be explained" is the honest evidence for offering the
 * area.
 *
 * THE PER-REPO SURFACE IS `directory` AND `auxiliary`. Opened from the Workspace tree beside whatever else serves
 * that repo — auxiliary because a docs browser renders no preview, so claiming the repo would drop the dev-server
 * tile for nothing. The extension API's own comment names "a docs browser" as the example of exactly this case.
 * It activates for every repo rather than only documented ones DELIBERATELY, and not for want of a fact to gate
 * on: `RepoFacts.docs` now says which repos carry documentation (docPresence spends it to avoid reading anything
 * from the rest), but gating the surface on it would hide the one place a first document set gets generated from
 * every repo that needs one. An undocumented repo gets an empty state that offers to generate — the same answer
 * the rail gives. */
export const activate = (api: IntenticApi, context: ExtensionContext): void => {
    bindHost(api);
    // Before the registrations, so the tile can badge on its first render rather than a minute later.
    context.subscriptions.push(startDocumentationAttention());

    context.subscriptions.push(
        api.views.register({
            id: `documentation`,
            label: `Documentation`,
            surface: `rail`,
            /* `question-circle`: the icon set has no `book`, and the two obvious alternatives both collide at
             * rail size. `align-left` (the first attempt) is a stack of horizontal lines, which is Acceptance's
             * `list-check` with the ticks removed — indistinguishable in a 20px tile. `file` is a page outline,
             * which is every other boxy glyph in the rail at a glance (`desktop`, and Workspace's `folder` until
             * that tile moved to `file-tree`). A ring with a mark inside shares its silhouette with
             * nothing else in the rail, and "?" is the most widely understood "read about this" affordance.
             * `clock` (Automations) is the only other round glyph, so RAIL_ORDER keeps the two apart.
             *
             * `Activation.icon` is a deliberately OPEN string (a third-party bundle may name an icon this app has
             * never heard of), so a name outside the set is not a compile error — the rail silently renders its
             * fallback, which is how the tile shipped blank once. builtins.test.ts now checks every compiled-in
             * extension's icons against the real vocabulary. */
            detect: (repos) => (repos.length > 0 ? [{ key: `documentation`, title: `Documentation`, icon: `question-circle` }] : []),
            // Newly generated sets nobody has read yet — see attention.ts for why that is the bar rather than a
            // count of what is undocumented or stale.
            badge: () => documentationBadge(),
            view: async () => (await import(`./DocsView.vue`)).default,
        }),
    );

    context.subscriptions.push(
        api.views.register({
            id: `documentation-repo`,
            label: `Docs`,
            surface: `directory`,
            auxiliary: true,
            detect: (repos) => repos.map((repo) => ({ key: repo.repo, title: `Docs`, repo: repo.repo })),
            view: async () => (await import(`./DocsView.vue`)).default,
        }),
    );

    /* THE PER-DIRECTORY SURFACE — an icon on every documented directory in the Workspace tree, opening that
     * directory's page as a tab.
     *
     * This is the grain the other two surfaces cannot reach. The rail tile is workspace-wide and the directory
     * panel is per REPO, but a document is per PACKAGE: fifty-five of them in this monorepo, each mirroring a
     * directory that is already sitting in the tree. Reaching one meant leaving the file you were reading, opening
     * an area, and finding the package again in a list — for an answer ("what is this thing?") that is only ever
     * asked while looking at the thing.
     *
     * The row's tooltip carries the package's one-liner rather than the word "documentation": the icon already
     * says there is something to read, so the hover is worth spending on what it SAYS. */
    context.subscriptions.push(startDocumentPresence());
    context.subscriptions.push(
        api.documents.register({
            id: `architecture`,
            detect: (path) => {
                const present = documentAt(path);
                if (present === undefined) {
                    return undefined;
                }
                const draft = present.draft ? ` (draft)` : ``;
                return {
                    // The rail tile's own glyph, so the two read as one thing. Its neighbours on a row are
                    // `wave-pulse`, `sitemap` and `cog`, and a ring with a mark inside shares a silhouette with
                    // none of them (see the rail registration for the alternatives that failed).
                    icon: `question-circle`,
                    tooltip: present.oneLiner === `` ? `Open architecture doc${draft}` : `${present.oneLiner}${draft}`,
                    title: `Architecture`,
                    /* THE ICON IS THE ANSWER TO "WHICH OF THESE HAS A PAGE?", so the row keeps it at rest. Every
                     * row icon used to be revealed on hover, which is right for an action and wrong for this: a
                     * repo's row is one row and gets found, while fifty-five package rows that look identical to
                     * fifty-five undocumented ones hide the whole per-package layer. Reading the tree now also
                     * reads the coverage — and a package that is missing one is visible too. */
                    evidence: true,
                };
            },
            view: async () => (await import(`./DocTab.vue`)).default,
        }),
    );

    context.subscriptions.push(
        api.commands.register(`documentation.generate`, () => {
            // The command palette's job here is to get the user to the surface that can start a run; the run needs
            // a scope, and choosing it is a decision the dialog exists to take.
            api.navigate(`/ext/documentation`);
        }),
    );
};
