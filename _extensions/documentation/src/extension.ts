import type { ExtensionContext, IntenticApi } from "@intentic/extension-api";
import { documentationBadge, startDocumentationAttention } from "./attention.js";
import { documentAt, startDocumentPresence } from "./docPresence.js";
import { bindHost } from "./host.js";

// Registers documentation's three surfaces: one workspace-wide rail tile, a per-repo directory panel, and a per-package
// tree icon. Activates on every repo, undocumented ones included, since this is where a first set gets generated.
export const activate = (api: IntenticApi, context: ExtensionContext): void => {
    bindHost(api);
    // Before the registrations, so the tile can badge on its first render rather than a minute later.
    context.subscriptions.push(startDocumentationAttention());

    context.subscriptions.push(
        api.views.register({
            id: `documentation`,
            label: `Documentation`,
            surface: `rail`,
            // `icon` is an open string with no compile check; a typo silently falls back blank. `builtins.test.ts`
            // guards every built-in extension's icons against the real set.
            detect: (repos) => (repos.length > 0 ? [{ key: `documentation`, title: `Documentation`, icon: `question-circle` }] : []),
            // Newly generated sets nobody has read yet, not a count of what's undocumented or stale.
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

    // Per-package icon on every documented directory in the tree: the grain the workspace tile and per-repo panel can't
    // reach. Tooltip carries the one-liner, since the icon already signals there's something to read.
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
                    // Matches the rail tile's glyph; distinct in silhouette from its neighbours (`wave-pulse`,
                    // `sitemap`, `cog`).
                    icon: `question-circle`,
                    tooltip: present.oneLiner === `` ? `Open architecture doc${draft}` : `${present.oneLiner}${draft}`,
                    title: `Architecture`,
                    // Visible at rest, not just on hover: many identical package rows would hide which have a page if
                    // hover-only.
                    evidence: true,
                };
            },
            view: async () => (await import(`./DocTab.vue`)).default,
        }),
    );

    context.subscriptions.push(
        api.commands.register(`documentation.generate`, () => {
            // Only navigates to the surface; choosing a scope for the run is the dialog's job, not the palette's.
            api.navigate(`/ext/documentation`);
        }),
    );
};
