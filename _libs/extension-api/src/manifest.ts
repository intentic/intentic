import { z } from "zod";

/* The extension manifest: `intentic-extension.json` at the extension repo root (deliberately NOT inside
 * .claude-plugin/ — that directory is Claude Code's namespace with its own semantics). The manifest is the
 * approval surface: the install dialog shows exactly these declared contributions before the owner confirms,
 * and the host refuses runtime registrations (views, commands) whose ids the approved manifest never declared. */

// A sidebar element family the extension may register at runtime (api.views.register): `rail` = a global
// left-rail tile routed at /ext/:ext/:key; `directory` = a per-repo panel opened from the Workspace tree.
export const ViewContributionSchema = z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    label: z.string().min(1),
    surface: z.enum(["rail", "directory"]),
});
export type ViewContribution = z.infer<typeof ViewContributionSchema>;

// A command the extension may register a handler for (api.commands.register); surfaced in the command palette.
export const CommandContributionSchema = z.object({
    command: z.string().regex(/^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/),
    title: z.string().min(1),
    icon: z.string().optional(),
});
export type CommandContribution = z.infer<typeof CommandContributionSchema>;

// A typed setting descriptor the host renders schema-driven into the Settings page and persists daemon-side —
// `enum` lists the choices for type "enum" and is meaningless otherwise.
export const SettingContributionSchema = z.object({
    key: z.string().regex(/^[a-z0-9][a-zA-Z0-9-]*$/),
    type: z.enum(["boolean", "string", "number", "enum"]),
    title: z.string().min(1),
    description: z.string().optional(),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
    enum: z.array(z.string()).optional(),
});
export type SettingContribution = z.infer<typeof SettingContributionSchema>;

// A long-lived background process the daemon runs for the extension (tmux-managed, like panel dev servers).
// `port: "auto"` assigns a free port injected as PORT; `preview` exposes it on a tunneled preview hostname;
// `autoStart` launches it on install and daemon boot. `cwd` is relative to the extension checkout.
export const ProcessContributionSchema = z.object({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    command: z.string().min(1),
    cwd: z.string().optional(),
    port: z.literal("auto").optional(),
    preview: z.boolean().optional(),
    autoStart: z.boolean().optional(),
});
export type ProcessContribution = z.infer<typeof ProcessContributionSchema>;

// "This checkout is ALSO a Claude Code plugin": the daemon hands the directory (`path` relative to the
// checkout; absent ⇒ the checkout root) to the Agent SDK's plugin loader, which reads skills/agents/hooks/
// commands/.mcp.json each turn — the daemon never parses plugin internals.
export const AgentContributionSchema = z.object({
    path: z.string().optional(),
});
export type AgentContribution = z.infer<typeof AgentContributionSchema>;

export const ExtensionManifestSchema = z.object({
    publisher: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    // The extension's own semver — display/identity only; the installed code identity is the pinned commit sha.
    version: z.string().min(1),
    // Semver range over the host's extension API version (extensionApiVersion) — checked before activation.
    engines: z.object({ intentic: z.string().min(1) }),
    // Repo-relative path of the prebuilt single-file ESM bundle (built with `vue` and `@intentic/extension-api`
    // as externals); absent ⇒ an agent-only extension with no UI entry.
    entry: z
        .string()
        .min(1)
        .refine((value) => !value.split("/").includes(".."), { message: "entry must stay inside the checkout" })
        .optional(),
    contributes: z
        .object({
            views: z.array(ViewContributionSchema).optional(),
            commands: z.array(CommandContributionSchema).optional(),
            settings: z.array(SettingContributionSchema).optional(),
            processes: z.array(ProcessContributionSchema).optional(),
            agent: AgentContributionSchema.optional(),
        })
        .optional(),
});
export type ExtensionManifest = z.infer<typeof ExtensionManifestSchema>;

// The extension's identity everywhere (capability entries, /ext routes, settings namespaces) — derived, never
// declared, so it can't contradict the publisher/name the install dialog showed.
export const extensionIdOf = (manifest: Pick<ExtensionManifest, "publisher" | "name">): string => `${manifest.publisher}.${manifest.name}`;
