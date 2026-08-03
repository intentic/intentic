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

/* WHICH WORKSPACE FILE MAKES THIS EXTENSION'S VIEW STALE — the extension's half of the core's
 * WORKSPACE_STATE_FILES table (@intentic/sandbox-contract), in the same two fields so the browser can union them
 * without translating.
 *
 * An intentic workspace is file-first: the agent edits /work with its own file tools, out of band from every
 * HTTP route, and the daemon's filesystem watcher is the ONLY thing that can tell a browser its view went stale.
 * Before this contribution point existed an extension had no way into that push, so every one of them polled —
 * and the core's table had to hardcode `automations`/`automation-approvals`, query keys owned by an extension,
 * because the extension itself couldn't declare them. Declaring is now the extension's job and unioning is the
 * host's.
 *
 * It rides the manifest rather than a runtime api.workspace.onDidChangeFiles for two reasons: the owner sees at
 * install which of their files an extension reads, and there is nothing imperative left to get wrong — no
 * subscribe, no unsubscribe, no listener that quietly stops firing. */
export const FileContributionSchema = z.object({
    /* Workspace-root-relative, forward-slash — the space the watcher's changed paths arrive in. Matched by
     * PREFIX, so one entry covers an exact file (`.intentic/automations.json`), a directory (`.intentic/drafts/`
     * — keep the trailing slash so it cannot match a sibling file) or a name family (`.intentic/environment.`).
     * Deliberately not a glob: prefix is the whole matching rule on both sides of this union. */
    path: z
        .string()
        .min(1)
        .refine((value) => !value.startsWith("/") && !value.split("/").includes(".."), {
            message: "path must be workspace-root-relative and stay inside the workspace",
        }),
    /* The browser query keys those contents feed — the first element of the extension's own
     * `api.sandbox.key(...)` keys, which is what makes them match (the sandbox id is a SUFFIX). Empty is not
     * allowed: a path that makes nothing stale is a declaration with no effect, and saying so at install beats
     * discovering it as a view that never refreshes.
     *
     * Keep the paths as narrow as the view actually needs. A broad prefix costs every connected browser a
     * refetch per matching write, and a write-heavy path (an index, a transcript, a log) turns that into a
     * request storm — the reason the core table leaves the daemon's own machine state off the push entirely. */
    invalidates: z.array(z.string().min(1)).min(1),
});
export type FileContribution = z.infer<typeof FileContributionSchema>;

/* A custom file viewer the extension may register at runtime (api.viewers.register): the host resolves an open
 * file to this viewer by extension, gets its content, and renders the registered component with it — the host
 * keeps the fetch + open-file lifecycle and the daemon credentials; the extension only renders. `extensions`
 * are bare file extensions (no dot), e.g. ["docx"]. This is the non-sidebar contribution point.
 *
 * `fetch` is how much of the file the host puts in the extension's hands, and it is a real choice:
 *   text — decoded utf8 (`text` prop). For a format that IS text: svg, a subtitle track, a notebook.
 *   blob — the whole file in memory (`blob` prop). For a format that must be parsed end to end before any of
 *          it can be shown: a .docx, a spreadsheet. Bounded by the daemon's raw-read cap.
 *   url  — a streaming URL the component points an element at (`src` prop), never the bytes. For anything
 *          RANGE-READ rather than parsed: audio and video, where the file may be gigabytes and the player
 *          wants the header, the index and the seconds around the playhead — not the file. The host mints
 *          the credential on that URL and keeps it out of the extension.
 */
export const ViewerContributionSchema = z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    extensions: z.array(z.string().regex(/^[a-z0-9]+$/)).min(1),
    fetch: z.enum(["text", "blob", "url"]),
});
export type ViewerContribution = z.infer<typeof ViewerContributionSchema>;

/* A per-directory document family the extension may register at runtime (api.documents.register): the provider
 * marks the directory rows it can explain in the Workspace tree, and the host opens its component as a tab —
 * see DocumentProviderRegistration.
 *
 * Only the id is declared, deliberately. The consequential part of a viewer is which FILES it takes over, and of
 * a command its global shortcut — both are decided here because the owner must see them. A document provider
 * takes nothing over: it adds an icon to rows it has something for, and every one of those rows is evidence the
 * owner can see for themselves. So the manifest gates WHETHER the extension may mark up the tree at all, and the
 * per-row wording stays with the provider, which is the only thing that knows what it found. */
export const DocumentContributionSchema = z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    // The family's human name, shown in the install dialog beside the extension's other contributions.
    label: z.string().min(1),
});
export type DocumentContribution = z.infer<typeof DocumentContributionSchema>;

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

// A field the "+" install dialog renders for a capability's config form (a slug key, a label, secret/optional
// flags, an optional select, a `when` gate). Mirrors the platform catalog's field shape so the web can render
// contributed cards from installed extensions exactly like core capability cards.
export const CapabilityFieldSchema = z.object({
    key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9]*$/),
    label: z.string().min(1),
    placeholder: z.string().optional(),
    secret: z.boolean().optional(),
    optional: z.boolean().optional(),
    multiline: z.boolean().optional(),
    default: z.string().optional(),
    options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
    when: z.object({ key: z.string(), value: z.string() }).optional(),
    // A fixed value baked into the config rather than asked for — how a card pins a discriminator
    // (platform="reddit", provider="stripe"). Rendered as nothing; sent as itself.
    value: z.string().optional(),
});
export type CapabilityField = z.infer<typeof CapabilityFieldSchema>;

// The "+" card an entry renders: how it looks in the grid and how the user gets the credential it asks for.
// Shared by every arm below, because none of that varies with the kind.
const CatalogSchema = z.object({
    name: z.string().min(1),
    logo: z.string().optional(),
    // An @intentic/ui IconName fallback glyph, rendered when no simple-icons `logo` fits the brand.
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
});

// Every arm carries these: the slug that becomes the card's /capabilities/<id> route AND the discriminator
// value the daemon's handler resolves (a cli `provider`, a browser/host `platform`), plus the card and its form.
const contributionBase = { id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/), catalog: CatalogSchema, fields: z.array(CapabilityFieldSchema) };

/* A CAPABILITY CARD AS DATA. The catalog is the extensible layer; the HANDLERS are core — so an entry names one
 * of the kinds whose daemon-side machinery is fully generic over its data, and the machinery stays put. The
 * kinds NOT listed here are the ones whose card is one-to-one with a handler that owns real privilege (`docker`
 * bakes --privileged, `vpn` bakes NET_ADMIN, `extension` installs extensions, `devops` scaffolds repos): their
 * cards live in the platform catalog because separating card from handler would split one concept in two, and
 * because a manifest that could name them would be a manifest that grants itself privilege. That restriction is
 * this discriminated union, not a comment — a manifest naming any other kind fails to parse.
 *
 * `${id}` in a skill file is substituted with the instance name at apply time (so a host pack's tool names read
 * `mcp__my-laptop__run_command`), and, for `cli`, each `$ENVVAR` becomes its per-instance suffixed name. */
export const CapabilityContributionSchema = z.discriminatedUnion("kind", [
    // A CLI tool the AGENT gets, authenticated: the env vars its shell receives (value templates over the
    // fields — `${field}` substitutes, `${field:uri}` percent-encodes), a SKILL.md cheatsheet, and an optional
    // image fragment holding the client binary (psql, mysql, whisper).
    z.object({
        ...contributionBase,
        kind: z.literal("cli"),
        fields: z.array(CapabilityFieldSchema).min(1),
        env: z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), z.string()),
        skill: z.string().min(1),
        fragment: z.string().min(1).optional(),
    }),
    // A site the agent acts on AS THE OWNER, through the shared logged-in Chromium. `loginUrl` is what the
    // guided-login window opens; the profile it persists is the credential. No `env` and no `fragment`: the
    // browser itself is core (one Chromium install serves every platform), only the identity is per-entry.
    z.object({ ...contributionBase, kind: z.literal("browser"), loginUrl: z.url(), skill: z.string().min(1) }),
    // An operating system a connected computer can run — the skill pack that teaches the agent THAT machine's
    // shell. The enrollment, the socket and the scope enforcement are core; only the pack varies.
    z.object({ ...contributionBase, kind: z.literal("host"), skill: z.string().min(1) }),
    /* A PRESET over a core kind: no payload at all, just a named card whose `fields` carry the defaults. What an
     * ACP agent needs is a command, so "OpenCode" is entirely a name, a logo and a filled-in form — which is
     * exactly what a catalog row is. */
    z.object({ ...contributionBase, kind: z.literal("agent") }),
]);
export type CapabilityContribution = z.infer<typeof CapabilityContributionSchema>;
// The arms carrying a per-instance SKILL.md — the daemon templates and installs these identically.
export type SkillContribution = Extract<CapabilityContribution, { skill: string }>;

/* The config key a kind's cards PIN to their own id, so a stored capability can be traced back to the card that
 * made it — the daemon resolves the entry's handler data through it, and the web tells one card's instances from
 * another's. `agent` has none on purpose: its cards are presets over one config shape, differing only in their
 * defaults, so every agent instance belongs to every agent card equally.
 *
 * Here, beside the schema, because it is a fact about the contribution shape — the daemon, the catalog and the
 * web all need it, and three copies of it is three chances for a card's instances to go missing. `satisfies`
 * rather than a lookup table so a new arm above is a compile error until this answers for it. */
const DISCRIMINATOR = { cli: "provider", browser: "platform", host: "platform", agent: undefined } satisfies Record<
    CapabilityContribution["kind"],
    string | undefined
>;
export const contributionDiscriminator = (kind: string): string | undefined => DISCRIMINATOR[kind as keyof typeof DISCRIMINATOR];

export const ExtensionManifestSchema = z.object({
    publisher: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    // The extension's own semver — display/identity only; the installed code identity is the pinned commit sha.
    version: z.string().min(1),
    /* The section this extension sits under in the Sandbox hub's Extensions tab — a grouping by what it is FOR,
     * declared because it cannot be derived. Nine of the first-party extensions contribute a rail tile, so a
     * grouping read off `contributes` puts more than half the list in one section and says nothing about any of
     * them. Deliberately a loose string, exactly like a connector's `catalog.category`: the vocabulary belongs
     * to the surface that renders it (extensionCategories.ts in the web app), and an extension declaring a
     * section this app has never heard of lands in "Other" rather than failing to install. */
    category: z.string().min(1).optional(),
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
            // Which workspace files back those views — the extension's entry into the daemon's file-change push,
            // in place of a poll. See FileContributionSchema.
            files: z.array(FileContributionSchema).optional(),
            viewers: z.array(ViewerContributionSchema).optional(),
            documents: z.array(DocumentContributionSchema).optional(),
            commands: z.array(CommandContributionSchema).optional(),
            settings: z.array(SettingContributionSchema).optional(),
            processes: z.array(ProcessContributionSchema).optional(),
            agent: AgentContributionSchema.optional(),
            environment: EnvironmentContributionSchema.optional(),
            capabilities: z.array(CapabilityContributionSchema).optional(),
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
