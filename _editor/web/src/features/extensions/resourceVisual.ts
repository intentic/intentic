import type { ResourceGroup } from "@intentic/api-contract";
import { type IconName, type Tone, toneDot, toneInk, toneTint } from "@intentic/ui";

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

// Each group borrows a tone for its colour. `frame` is the tone's tinted box in its own ink, a wash rather than a solid,
// so it is never mistaken for the status dot; `bar` is the solid stripe/legend fill.
const accent = (tone: Tone): { readonly frame: string; readonly bar: string } => ({
    frame: toneTint(tone, `strong`, toneInk(tone)),
    bar: toneDot(tone),
});

const GROUP_ACCENT: Readonly<Record<ResourceGroup, { readonly frame: string; readonly bar: string }>> = {
    infra: accent(`info`),
    git: accent(`primary`),
    deploy: accent(`success`),
    data: accent(`warning`),
    notify: accent(`danger`),
    other: accent(`neutral`),
};
export const groupAccent = (group: ResourceGroup): { readonly frame: string; readonly bar: string } => GROUP_ACCENT[group];
