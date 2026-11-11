import type { CapabilityField } from "@intentic/extension-manifest";
import type { CapabilityCatalogEntry } from "./index.js";

// The two tiles that install from a git repository, a Claude Code plugin and an intentic extension, with the fields they
// share. Their own module since the git connection fields grew them past what the catalog file holds.

// A plugin's or extension's repository, read with the GitHub or GitLab card connected for its host (2026-11-11): the
// form draws this as which card reads it (capabilities/connect/GitConnectionField.vue), and only while one matches the
// URL's host; an agent names one by id. The token is the override for a repository none of them can read.
const GIT_CONNECTION_FIELD: CapabilityField = {
    key: "gitConnection",
    label: "GitHub or GitLab connection",
    optional: true,
    hint: "The connected card whose token reads a private repository on its host. Left empty, the first by name.",
};
const GIT_TOKEN_FIELD: CapabilityField = {
    key: "token",
    label: "Access token",
    secret: true,
    optional: true,
    advanced: true,
    hint: "Only for a repository none of your GitHub or GitLab connections can read: used instead of them.",
};

export const PLUGIN_ENTRY: CapabilityCatalogEntry = {
    id: "plugin",
    name: "Claude plugin",
    kind: "plugin",
    category: "extend",
    description: "A Claude Code plugin from a git repo.",
    fields: [
        { key: "url", label: "Git URL", placeholder: "https://github.com/owner/plugin" },
        GIT_CONNECTION_FIELD,
        { key: "ref", label: "Branch, tag or commit", optional: true },
        { key: "path", label: "Subdirectory", optional: true },
        GIT_TOKEN_FIELD,
    ],
    hint: "Pinned to the commit it installs at and loaded by the agent next turn. Re-adding the same name updates it to the newest commit.",
    guide: {
        scopes: "private repos: read access (e.g. GitHub `repo`)",
        steps: [
            "Point at a git repo holding a Claude Code plugin.",
            "Private repo on GitHub or GitLab: your connected card for it reads it, with nothing to paste.",
            "Anywhere else: an access token with read access, under Advanced.",
            "Or browse a marketplace above to pre-fill this form.",
        ],
    },
};

export const EXTENSION_ENTRY: CapabilityCatalogEntry = {
    id: "extension",
    name: "Extension",
    kind: "extension",
    category: "extend",
    description: "An intentic extension from a git repo.",
    fields: [
        { key: "url", label: "Git URL", placeholder: "https://github.com/owner/extension" },
        GIT_CONNECTION_FIELD,
        // A full sha, not a branch: extension code runs trusted, so installs pin exactly the reviewed commit. The
        // app resolves the branch or release picked here into that sha (capabilities/GitRefField.vue).
        { key: "ref", label: "Version" },
        { key: "path", label: "Subdirectory", optional: true },
        GIT_TOKEN_FIELD,
    ],
    guide: {
        scopes: "private repos: read access (e.g. GitHub `repo`)",
        steps: [
            "Point at a repo with an `intentic-extension.json`.",
            "Private repo on GitHub or GitLab: your connected card for it reads it; anywhere else, a token under Advanced.",
            "Pick a branch or release: it is pinned to that commit, and an install never follows it.",
            "Reload the app after installing to load its UI.",
        ],
    },
};
