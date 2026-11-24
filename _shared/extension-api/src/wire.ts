// THE SLICE OF THE WIRE CONTRACT AN EXTENSION MAY READ. @intentic/sandbox-contract is versioned with the product release
// (1.3xx), so an extension that takes `^1.x` of it would meet a reshaped schema with nothing saying so. An extension may
// import the bare package and these subpaths only, and the extension API versions exactly them: surface.json records,
// per extensionApiVersion, each one's runtime export names and a digest of every zod schema it exports (`wireExports`),
// and surface-guard.test.ts fails when they move without a new entry.
//
// Held to it: the `_extensions/**` lint override in .oxlintrc.json (_tools/checks/lib/extension-deps.mjs keeps the two
// in step) and the kit's published `intentic-kit-check`, which reads the list off the newest surface record's
// `wireExports` so it runs in a standalone extension's typecheck with no build and no network.
//
// Taken on 2026-11-23 from what the in-repo `_extensions/*` and the standalone checkouts beside this repository import.
// A subpath joins with a minor of the extension API; one leaves only in a major.
export const EXTENSION_WIRE = [
    "@intentic/sandbox-contract",
    "@intentic/sandbox-contract/app-routes",
    "@intentic/sandbox-contract/batch-runs",
    "@intentic/sandbox-contract/capability-env",
    "@intentic/sandbox-contract/chores",
    "@intentic/sandbox-contract/ids/conversation-ids",
    "@intentic/sandbox-contract/message-limits",
    "@intentic/sandbox-contract/models/agent-catalog",
    "@intentic/sandbox-contract/oauth/google-workspace",
    "@intentic/sandbox-contract/policy/capability-env",
    "@intentic/sandbox-contract/policy/command-run",
    "@intentic/sandbox-contract/policy/keyring-origins",
    "@intentic/sandbox-contract/policy/role-capability",
    "@intentic/sandbox-contract/protocol/doors/listener-protocol",
    "@intentic/sandbox-contract/schemas/access-profiles",
    "@intentic/sandbox-contract/schemas/activity",
    "@intentic/sandbox-contract/schemas/agent",
    "@intentic/sandbox-contract/schemas/agents",
    "@intentic/sandbox-contract/schemas/approvals",
    "@intentic/sandbox-contract/schemas/automations",
    "@intentic/sandbox-contract/schemas/ci",
    "@intentic/sandbox-contract/schemas/git/git",
    "@intentic/sandbox-contract/schemas/git/git-history",
    "@intentic/sandbox-contract/schemas/history",
    "@intentic/sandbox-contract/schemas/keyring",
    "@intentic/sandbox-contract/schemas/ports",
    "@intentic/sandbox-contract/schemas/public",
    "@intentic/sandbox-contract/schemas/roles",
    "@intentic/sandbox-contract/schemas/services",
    "@intentic/sandbox-contract/schemas/share",
    "@intentic/sandbox-contract/schemas/shared",
    "@intentic/sandbox-contract/schemas/terminal",
    "@intentic/sandbox-contract/schemas/workspace/workspace-graph",
    "@intentic/sandbox-contract/schemas/workspace/workspace-repos",
    "@intentic/sandbox-contract/session-names",
    "@intentic/sandbox-contract/state/fix-attempt-plan",
    "@intentic/sandbox-contract/state/fix-stance",
    "@intentic/sandbox-contract/time",
    "@intentic/sandbox-contract/workspace-state",
] as const;

export type ExtensionWireSpecifier = (typeof EXTENSION_WIRE)[number];

/** Whether an import specifier names the wire contract at all, allowed or not. */
export const namesWireContract = (specifier: string): boolean =>
    specifier === `@intentic/sandbox-contract` || specifier.startsWith(`@intentic/sandbox-contract/`);

const allowed: ReadonlySet<string> = new Set(EXTENSION_WIRE);

/** Whether an extension may import `specifier` from the wire contract. */
export const isExtensionWire = (specifier: string): boolean => allowed.has(specifier);
