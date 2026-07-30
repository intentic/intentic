import { z } from "zod";

/* The extension manifest: `intentic-extension.json` at the extension repo root (deliberately NOT inside
 * .claude-plugin/ — that directory is Claude Code's namespace with its own semantics). The manifest is the
 * approval surface: the install dialog shows exactly these declared contributions before the owner confirms,
 * and the host refuses runtime registrations (views, commands) whose ids the approved manifest never declared. */

// A sidebar element family the extension may register at runtime (api.views.register): `rail` = a global
// left-rail tile routed at /ext/:ext/:key?; `directory` = a per-repo panel opened from the Workspace tree;
// `sandbox` = a tab on the Sandbox hub, for a view whose subject is the BOX rather than the work (see
// ViewRegistration.surface).
export const ViewContributionSchema = z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    label: z.string().min(1),
    surface: z.enum(["rail", "directory", "sandbox"]),
    // Whether this view may badge its tile (ViewRegistration.badge). Declared here, like a command's
    // keybinding, because it is consequential: a badge interrupts the user from every other screen in the app.
    // Absent ⇒ the host drops any badge the extension registers.
    badge: z.boolean().optional(),
});
export type ViewContribution = z.infer<typeof ViewContributionSchema>;

// A custom file viewer the extension may register at runtime (api.viewers.register): the host resolves an open
// file to this viewer by extension, fetches its bytes (`fetch: "blob"`) or text (`fetch: "text"`), and renders
// the registered component with them — the host keeps the fetch + open-file lifecycle; the extension only renders.
// `extensions` are bare file extensions (no dot), e.g. ["docx"]. This is the non-sidebar contribution point.
export const ViewerContributionSchema = z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    extensions: z.array(z.string().regex(/^[a-z0-9]+$/)).min(1),
    fetch: z.enum(["text", "blob"]),
});
export type ViewerContribution = z.infer<typeof ViewerContributionSchema>;

// A command the extension may register a handler for (api.commands.register); surfaced in the command palette.
export const CommandContributionSchema = z.object({
    command: z.string().regex(/^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/),
    title: z.string().min(1),
    icon: z.string().optional(),
    // An optional global keyboard shortcut, in the host's chord notation (`Mod`/`Ctrl`/`Shift`/`Alt` + key, e.g.
    // "Mod+Shift+K"; `Mod` = ⌘ on Apple, Ctrl elsewhere). It is DECLARED here so it rides the install dialog's
    // approval surface — a global shortcut is consequential, so like title/icon the manifest value is authoritative
    // and the host binds only what was approved. Whitespace-free; an unparseable chord simply never fires.
    keybinding: z.string().regex(/^\S+$/).optional(),
});
export type CommandContribution = z.infer<typeof CommandContributionSchema>;

// A typed setting descriptor the host renders schema-driven into the Settings page and persists daemon-side —
// `enum` lists the choices for type "enum" and is meaningless otherwise. `secret: true` masks the value in the
// UI and strips it from reads (a set secret round-trips as "still set", never its value). `env` injects the
// stored value into the agent's shell environment under that name every turn — the way a connector's
// credential reaches the agent's CLI tools, but declared by the extension.
export const SettingContributionSchema = z.object({
    key: z.string().regex(/^[a-z0-9][a-zA-Z0-9-]*$/),
    type: z.enum(["boolean", "string", "number", "enum"]),
    title: z.string().min(1),
    description: z.string().optional(),
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
    enum: z.array(z.string()).optional(),
    secret: z.boolean().optional(),
    env: z
        .string()
        .regex(/^[A-Z][A-Z0-9_]*$/)
        .optional(),
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

// A realtime listener the extension's gateway process (contributes.processes) implements: `provider` is the
// slug its automation triggers fire on (Trigger.provider) and `eventTypes` the kinds those triggers may narrow
// to (Trigger.eventType). The daemon validates listener automations against these, and serves the gateway a
// provider-scoped control surface — GET /listeners/<provider>/state to reconcile, POST …/dispatch to wake an
// automation (optionally holding a turn-stream), …/failure + …/status to report. The daemon holds no provider
// connection itself; the extension's process does.
export const ListenerContributionSchema = z.object({
    provider: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    eventTypes: z.array(z.string().regex(/^[a-z0-9][a-z0-9_]*$/)).min(1),
});
export type ListenerContribution = z.infer<typeof ListenerContributionSchema>;

// A Dockerfile fragment baked into the sandbox image overlay so the extension's tools are present at runtime
// (a whisper binary, a psql client, …). `fragment` is a checkout-relative path to a file holding ONLY RUN/ENV
// instructions — the daemon rejects FROM and privileged `# intentic:runtime` directives from extension
// fragments (those stay daemon-owned), and the owner approves the composed overlay + rebuilds out-of-band.
export const EnvironmentContributionSchema = z.object({
    fragment: z
        .string()
        .min(1)
        .refine((value) => !value.split("/").includes(".."), { message: "fragment must stay inside the checkout" }),
});
export type EnvironmentContribution = z.infer<typeof EnvironmentContributionSchema>;

// A field the "+" install dialog renders for a connector's config form (a slug key, a label, secret/optional
// flags, an optional select, a `when` gate). Mirrors the platform catalog's field shape so the web can render
// connector cards from installed extensions exactly like core capability cards.
export const ConnectorFieldSchema = z.object({
    key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/),
    label: z.string().min(1),
    placeholder: z.string().optional(),
    secret: z.boolean().optional(),
    optional: z.boolean().optional(),
    multiline: z.boolean().optional(),
    default: z.string().optional(),
    options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
    when: z.object({ key: z.string(), value: z.string() }).optional(),
});
export type ConnectorField = z.infer<typeof ConnectorFieldSchema>;

// A CLI-tool connector as DATA: the "+" card, the config fields, the env vars the agent's shell gets (value
// templates over the fields — `${field}` substitutes, `${field:uri}` percent-encodes), the SKILL.md cheatsheet
// path, and an optional image fragment path (a psql/whisper client). The daemon's cli handler resolves a
// provider to its spec through the connector registry instead of a hardcoded table, so a connector is one
// manifest entry + two files, no daemon change.
export const ConnectorContributionSchema = z.object({
    provider: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    kind: z.literal("cli"),
    catalog: z.object({
        name: z.string().min(1),
        logo: z.string().optional(),
        // An @intentic-app/ui IconName fallback glyph, rendered when no simple-icons `logo` fits the brand.
        icon: z.string().optional(),
        description: z.string().min(1),
        category: z.string().min(1),
        hint: z.string().optional(),
        // The credential-creation walkthrough the install dialog renders (the platform catalog's guide shape).
        guide: z
            .object({
                url: z.string().optional(),
                urlFromField: z.string().optional(),
                path: z.string().optional(),
                linkLabel: z.string().optional(),
                scopes: z.string().optional(),
                steps: z.array(z.string()).optional(),
            })
            .optional(),
    }),
    fields: z.array(ConnectorFieldSchema).min(1),
    env: z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), z.string()),
    skill: z.string().min(1),
    fragment: z.string().min(1).optional(),
});
export type ConnectorContribution = z.infer<typeof ConnectorContributionSchema>;

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
    // The daemon routes this extension may call through api.sandbox.request/json — each "<METHOD> <path-glob>"
    // where `*` matches one path segment (e.g. "GET /panels", "POST /panels/*/start"). The host refuses any
    // api.sandbox call whose method+path isn't declared here, so an extension's backend reach is explicit and
    // reviewable instead of an ambient client to the whole daemon. Absent ⇒ the extension makes no api.sandbox calls.
    permissions: z.object({ sandbox: z.array(z.string()) }).optional(),
    contributes: z
        .object({
            views: z.array(ViewContributionSchema).optional(),
            viewers: z.array(ViewerContributionSchema).optional(),
            commands: z.array(CommandContributionSchema).optional(),
            settings: z.array(SettingContributionSchema).optional(),
            processes: z.array(ProcessContributionSchema).optional(),
            agent: AgentContributionSchema.optional(),
            environment: EnvironmentContributionSchema.optional(),
            connectors: z.array(ConnectorContributionSchema).optional(),
            listener: ListenerContributionSchema.optional(),
            // A checkout-relative directory of executables the daemon prepends to the AGENT's PATH each turn —
            // how an extension ships a command-line tool for the agent (the CLI-tools path). The files ARE the
            // approved code (they ride the sha-pinned checkout); the daemon only adds the dir to PATH.
            bin: z
                .string()
                .min(1)
                .refine((value) => !value.split("/").includes(".."), { message: "bin must stay inside the checkout" })
                .optional(),
        })
        .optional(),
});
export type ExtensionManifest = z.infer<typeof ExtensionManifestSchema>;

// The extension's identity everywhere (capability entries, /ext routes, settings namespaces) — derived, never
// declared, so it can't contradict the publisher/name the install dialog showed.
export const extensionIdOf = (manifest: Pick<ExtensionManifest, "publisher" | "name">): string => `${manifest.publisher}.${manifest.name}`;
