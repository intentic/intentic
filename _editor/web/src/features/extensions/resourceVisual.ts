import type { ResourceGroup } from "@intentic/api-contract";
import type { IconName } from "@intentic/ui";

// Icon and category accent for a desired-state resource in the dependency graph; one source of truth so the graph node,
// details panel, and legend match, the visual sibling of reconcileStatus.ts. Tables key on the open `type` string,
// mirroring GROUPS in workspaceStateProjection.ts.

// Semantic glyph per resource kind, always available offline; every value is a real IconName.
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

// simple-icons slugs for product-backed kinds; `github/f5f5f5` forces a near-white glyph for the dark card.
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
// CDN URL for a product-backed kind, else undefined. Consumers guard with v-if and clear it per node on the img's
// @error.
export const resourceLogoUrl = (type: string): string | undefined => {
    const slug = LOGOS[type];
    return slug === undefined ? undefined : `https://cdn.simpleicons.org/${slug}`;
};

// `frame` stays subtle, never mistaken for the status dot; `bar` is the solid stripe/legend fill.
const GROUP_ACCENT: Readonly<Record<ResourceGroup, { readonly frame: string; readonly bar: string }>> = {
    infra: { frame: `border-info/30 bg-info/10 text-info`, bar: `bg-info` },
    git: { frame: `border-primary-500/30 bg-primary-600/10 text-primary-500`, bar: `bg-primary-500` },
    deploy: { frame: `border-success/30 bg-success/10 text-success`, bar: `bg-success` },
    data: { frame: `border-warning/30 bg-warning/10 text-warning`, bar: `bg-warning` },
    notify: { frame: `border-danger/30 bg-danger/10 text-danger`, bar: `bg-danger` },
    other: { frame: `border-subtle/30 bg-subtle/10 text-subtle`, bar: `bg-subtle` },
};
export const groupAccent = (group: ResourceGroup): { readonly frame: string; readonly bar: string } => GROUP_ACCENT[group];
