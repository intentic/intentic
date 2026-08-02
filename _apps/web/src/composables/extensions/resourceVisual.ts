import type { ResourceGroup } from "@intentic-app/api-contract";
import type { IconName } from "@intentic/ui";

/* How a desired-state resource looks in the dependency graph: the icon (or brand logo) that says what it is,
 * and the category accent that says which coarse group it belongs to. One source of truth so the graph node,
 * the details panel, and the legend stay in lockstep — the visual sibling of reconcileStatus.ts (which owns
 * the orthogonal reconcile-status axis). Kept out of the ResourceView wire schema: type + group already ride
 * the wire, and these are pure presentation. Tables are keyed by the open `type` string (the web app doesn't
 * depend on @intentic/resources) with a fallback, mirroring GROUPS in workspaceStateProjection.ts. */

// A semantic glyph per resource kind, always available offline. Shared vocabulary: store → database, partition
// / sub-resource → folder, people-group → users, repo → folder, CI/pipeline → list-check, notify → send.
// Every value is a real IconName, so no bundled icon-data regeneration is needed.
const ICONS: Readonly<Record<string, IconName>> = {
    host: `server`,
    cloudflare: `cloud`,
    "cf-route": `globe`,
    tunnel: `link`,
    github: `github`,
    gitlab: `gitlab`,
    forgejo: `code`,
    "forgejo-user": `user`,
    "forgejo-org": `users`,
    "forgejo-team": `users`,
    "forgejo-runner": `bolt`,
    repo: `folder`,
    "control-repo": `sitemap`,
    ci: `list-check`,
    "gh-repo": `folder`,
    "gh-ci": `list-check`,
    "gl-repo": `folder`,
    "gl-ci": `list-check`,
    komodo: `cog`,
    "komodo-server": `server`,
    "komodo-periphery": `desktop`,
    "komodo-user": `user`,
    deployment: `box`,
    stripe: `credit-card`,
    discord: `comments`,
    "forgejo-notify": `send`,
    "komodo-notify": `send`,
    signoz: `wave-pulse`,
    outline: `file-edit`,
    paperless: `file-pdf`,
    openproject: `list-check`,
    invoiceninja: `credit-card`,
    infisical: `lock`,
    postgres: `database`,
    "postgres-database": `folder`,
    valkey: `database`,
    "valkey-namespace": `folder`,
    authentik: `shield`,
    "authentik-client": `key`,
    garage: `database`,
    "garage-bucket": `folder`,
    workspace: `th-large`,
    backup: `save`,
};
export const resourceIcon = (type: string): IconName => ICONS[type] ?? `box`;

// simple-icons slugs for kinds backed by a real product, rendered via https://cdn.simpleicons.org/<slug> with
// an <img @error> fallback to the semantic glyph — so a missing/renamed slug degrades gracefully. undefined for
// infra-native / generic / sub-resource kinds (host, tunnel, komodo*, repo, ci, deployment, backup, buckets…).
// `github/f5f5f5` forces a near-white glyph (GitHub's near-black brand color is invisible on the dark card).
const LOGOS: Readonly<Record<string, string>> = {
    cloudflare: `cloudflare`,
    discord: `discord`,
    stripe: `stripe`,
    outline: `outline/f5f5f5`,
    paperless: `paperlessngx`,
    openproject: `openproject`,
    invoiceninja: `invoiceninja`,
    postgres: `postgresql`,
    valkey: `valkey`,
    authentik: `authentik`,
    forgejo: `forgejo`,
    github: `github/f5f5f5`,
    "gh-repo": `github/f5f5f5`,
    "gh-ci": `github/f5f5f5`,
    gitlab: `gitlab`,
    "gl-repo": `gitlab`,
    "gl-ci": `gitlab`,
};
// The full simple-icons CDN URL for a product-backed kind, else undefined (infra-native/generic → semantic
// glyph). Consumers guard on it (v-if) and pass it straight to <img :src>; the @error path clears it per node.
export const resourceLogoUrl = (type: string): string | undefined => {
    const slug = LOGOS[type];
    return slug === undefined ? undefined : `https://cdn.simpleicons.org/${slug}`;
};

// The category color, on the axis orthogonal to reconcile-status: `frame` tints the icon box (subtle /10+/30,
// never a saturated fill, so a green deploy frame never reads as an "in sync" signal), `bar` is the solid fill
// for the node's left stripe and the legend swatch. Placement, not hue, separates this from the status dot:
// category sits on the left, the reconcile-status dot on the right. All tokens auto-flip light/dark.
const GROUP_ACCENT: Readonly<Record<ResourceGroup, { readonly frame: string; readonly bar: string }>> = {
    infra: { frame: `border-info/30 bg-info/10 text-info`, bar: `bg-info` },
    git: { frame: `border-primary-500/30 bg-primary-600/10 text-primary-500`, bar: `bg-primary-500` },
    deploy: { frame: `border-success/30 bg-success/10 text-success`, bar: `bg-success` },
    data: { frame: `border-warning/30 bg-warning/10 text-warning`, bar: `bg-warning` },
    notify: { frame: `border-danger/30 bg-danger/10 text-danger`, bar: `bg-danger` },
    other: { frame: `border-subtle/30 bg-subtle/10 text-subtle`, bar: `bg-subtle` },
};
export const groupAccent = (group: ResourceGroup): { readonly frame: string; readonly bar: string } => GROUP_ACCENT[group];
