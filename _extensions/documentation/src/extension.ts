import type { ExtensionContext, IntenticApi } from "@intentic/extension-api";
import { documentationBadge, startDocumentationAttention } from "./attention.js";
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
 * It activates for every repo rather than only documented ones because `detect()` is synchronous over the public
 * facts and cannot read a file; the honest refinement is a `docs` fact on RepoFacts (one line beside `userStories`
 * in the daemon's panels route), and until that exists an undocumented repo gets an empty state that offers to
 * generate — which is the same answer the rail gives. */
export const activate = (api: IntenticApi, context: ExtensionContext): void => {
    bindHost(api);
    // Before the registrations, so the tile can badge on its first render rather than a minute later.
    context.subscriptions.push(startDocumentationAttention());

    context.subscriptions.push(
        api.views.register({
            id: `documentation`,
            label: `Documentation`,
            surface: `rail`,
            // `align-left` because the icon set has no `book` — and `Activation.icon` is a deliberately OPEN
            // string (a third-party bundle may name an icon this package has never heard of), so a name that is
            // not in the set is not a compile error: the rail silently renders its fallback. builtins.test.ts
            // now checks every compiled-in extension's icons against the real set for exactly that reason.
            detect: (repos) => (repos.length > 0 ? [{ key: `documentation`, title: `Documentation`, icon: `align-left` }] : []),
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

    context.subscriptions.push(
        api.commands.register(`documentation.generate`, () => {
            // The command palette's job here is to get the user to the surface that can start a run; the run needs
            // a scope, and choosing it is a decision the dialog exists to take.
            api.navigate(`/ext/documentation`);
        }),
    );
};
