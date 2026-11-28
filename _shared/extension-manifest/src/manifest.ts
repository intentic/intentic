import { z } from "zod";
import { MARK_FIELDS } from "./mark.js";
import { declaredReachOf, EXTENSION_FIRE_HANDLER, permissionProblem } from "./permissions.js";
import { contributesSchema } from "./points/index.js";

// The extension manifest (`intentic-extension.json`, not under .claude-plugin/): the approval surface the install
// dialog renders, and the host refuses any runtime registration whose id it didn't declare here. This file is the
// envelope only; contributions are assembled from points/.

// One "<METHOD> <path-glob>" entry, refused at parse when malformed (permissions.ts), so a bad manifest fails where it is
// read instead of inside the route gate on its first call.
const permissionEntry = (): z.ZodString =>
    z.string().superRefine((entry, ctx) => {
        const problem = permissionProblem(entry);
        if (problem !== undefined) {
            ctx.addIssue({ code: "custom", message: problem });
        }
    });

const ManifestShape = z.object({
    // Declared so it survives the parse instead of being silently stripped; nothing at runtime reads it.
    $schema: z.string().optional().describe("The authoring schema, for editor completion and validation. Nothing at runtime reads it."),
    publisher: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    // Own semver, display/identity only; the installed code's identity is the pinned commit sha.
    version: z.string().min(1).describe("Your own semver, display and identity only. The installed code's identity is the pinned commit sha."),
    // Extensions-tab section; not derivable from `contributes`. An unrecognized value falls back to "Other".
    category: z
        .string()
        .min(1)
        .optional()
        .describe(
            "Which section of the Extensions tab this sits under: a grouping by what it is FOR, which cannot be derived from what it contributes. A section this app has never heard of lands in 'Other' rather than failing to install.",
        ),
    // How the extension is drawn wherever it's listed, not where it runs; see MARK_FIELDS.
    ...MARK_FIELDS,
    // Semver range over extensionApiVersion, checked before activation.
    engines: z
        .object({ intentic: z.string().min(1) })
        .describe("A semver range over the host's extension API version, checked before your code is activated."),
    // Repo-relative path of the prebuilt single-file ESM UI bundle; absent means no UI entry.
    entry: z
        .string()
        .min(1)
        .refine((value) => !value.split("/").includes(".."), { message: "entry must stay inside the checkout" })
        .meta({ power: { key: "entry", sentence: "runs a UI bundle in your browser" } })
        .optional()
        .describe(
            "Repo-relative path of your prebuilt single-file ESM bundle, built with `vue` and `@intentic/extension-api` as externals. Absent ⇒ an extension with no UI.",
        ),
    // Repo-relative path of the server bundle; must bundle in everything but node builtins. Absent ⇒ no backend.
    server: z
        .string()
        .min(1)
        .refine((value) => !value.split("/").includes(".."), { message: "server must stay inside the checkout" })
        .meta({ power: { key: "server", sentence: "runs a backend bundle inside the daemon's extension host" } })
        .optional()
        .describe(
            "Repo-relative path of your prebuilt single-file node ESM server bundle, exporting `activateServer`. Served under your own route namespace, which the daemon proxies. Nothing is provided at runtime but node builtins, so bundle everything else in. Absent ⇒ no backend.",
        ),
    // Declared reach, one grammar for both halves: "<METHOD> <path-glob>" entries, `*` matches one path segment.
    // sandbox: daemon routes the UI half may call via api.sandbox; the extension's own namespace needs no entry.
    // daemon: daemon routes the backend may call via api.daemon, enforced separately since the UI and backend run as
    // different principals.
    permissions: z
        .object({
            sandbox: z
                .array(permissionEntry().meta({ power: { key: "sandbox:${value}", sentence: "its UI calls the sandbox route ${value}" } }))
                .optional()
                .describe("Daemon routes your UI half may call. Your own backend namespace needs no entry: its backend is your own code."),
            daemon: z
                .array(permissionEntry().meta({ power: { key: "daemon:${value}", sentence: "its backend calls the daemon route ${value}" } }))
                .optional()
                .describe(
                    "Daemon routes your SERVER half may call. Separate from `sandbox` because the two halves run as different principals: the UI as the owner's session, the backend as a minted per-extension token, so a grant to one must never quietly widen the other.",
                ),
            // (2026-11-26) What the backend and processes may hear, hold, run and be woken by beyond their routes
            // (permissions.ts EXTENSION_DECLARED_EVENTS and the rest); the daemon refuses each undeclared.
            events: z
                .array(
                    z.union([
                        z.literal("run").meta({ power: { key: "events:run", sentence: "its backend hears when a conversation it started finishes a turn" } }),
                        z
                            .literal("activity")
                            .meta({ power: { key: "events:activity", sentence: "its backend hears whether any agent turn is running in the sandbox" } }),
                        // (2026-11-26) The CI feed's frames, as the core hears them from the forges.
                        z
                            .literal("ci")
                            .meta({ power: { key: "events:ci", sentence: "its backend hears every CI run and job the workspace's forges report" } }),
                    ]),
                )
                .optional()
                .describe(
                    "Events your backend hears through `api.events` beyond its settings and the workspace's changes: `run`, a turn ending in a conversation it started through POST /agent with its own token; `activity`, whether any agent turn is running in the sandbox; `ci`, each run and job the workspace's GitHub and GitLab forges report as it is heard (the CI feed).",
                ),
            work: z
                .boolean()
                .meta({ power: { key: "work", sentence: "its backend keeps the sandbox awake, and a restart waiting, while it holds work in flight" } })
                .optional()
                .describe(
                    "Whether your backend may hold work in flight with `api.work.hold(label)`: while held, the sandbox stays awake and an update or restart waits for it, as for an agent's turn.",
                ),
            exec: z
                .array(
                    z.union([
                        z.literal("command").meta({ power: { key: "exec:command", sentence: "its backend runs commands, admitted like an agent's" } }),
                        z
                            .literal("toolchain")
                            .meta({ power: { key: "exec:toolchain", sentence: "its backend runs heavy tools, queued with the sandbox's builds and tests" } }),
                    ]),
                )
                .optional()
                .describe(
                    "The workload classes `api.exec` may run a command under: `command`, admitted and ranked as an agent's shell command; `toolchain`, a heavy tool (a build, a test run, an analyser), which also takes turns in the sandbox's heavy-command queue.",
                ),
            fires: z
                .array(
                    z
                        .string()
                        .regex(EXTENSION_FIRE_HANDLER, "a handler is a lowercase word: letters, digits and dashes")
                        .meta({ power: { key: "fires:${value}", sentence: 'the sandbox\'s automations wake its backend\'s "${value}" handler' } }),
                )
                .optional()
                .describe(
                    "Handlers an automation may fire in your backend (`api.automations.onFire(name, handler)`): an automation whose target is `{ kind: \"extension\" }` names this extension and one of these, and fires it on its trigger under the scheduler's admission, holds and journal, without an agent.",
                ),
            // (2026-11-26) What its agent tools may do with the calling turn's grants (permissions.ts
            // EXTENSION_TURN_POWERS); the daemon refuses each undeclared, and anything the turn does not hold either way.
            turn: z
                .array(
                    z.union([
                        z.literal("browser").meta({
                            power: {
                                key: "turn:browser",
                                sentence: "its agent tools drive the sandbox's signed-in browsers, for the accounts the calling turn holds and on those accounts' own sites",
                            },
                        }),
                        z
                            .literal("owner-browser")
                            .meta({ power: { key: "turn:owner-browser", sentence: "its agent tools use the owner's own browser when the calling turn holds it" } }),
                        z.literal("jobs").meta({ power: { key: "turn:jobs", sentence: "its agent tools start background jobs in the calling conversation" } }),
                    ]),
                )
                .optional()
                .describe(
                    "What your agent tools (`contributes.tools`, served by `api.tools.serve`) may do with the grants of the turn that calls them: `browser`, drive the sandbox's signed-in browser of an account the turn holds, on that account's own sites (`api.browser.call`); `owner-browser`, call the owner's own browser the turn holds (`api.ownerBrowser.call`); `jobs`, start a background job in the calling conversation that the agent collects with `wait` (`api.jobs.start`). Never more than the turn holds.",
                ),
            // (2026-11-28) What it may do as this sandbox's identity (permissions.ts EXTENSION_IDENTITY_VERBS); the daemon
            // signs for it and refuses each undeclared verb. The key never leaves the daemon.
            identity: z
                .array(
                    z.literal("sign").meta({
                        power: {
                            key: "identity:sign",
                            sentence: "its backend signs records as this sandbox, which anyone can verify with the sandbox's public key",
                        },
                    }),
                )
                .optional()
                .describe(
                    "What your backend may do as this sandbox's identity: `sign`, have the daemon sign a JSON record as this sandbox (`api.identity.sign(purpose, payload)`), under a domain naming your extension and the record's purpose, which anyone verifies with the sandbox's published keys. The key never reaches your code.",
                ),
        })
        .optional()
        .describe(
            'How far this extension may reach into the daemon, as "<METHOD> <path-glob>" entries where `*` matches one path segment: e.g. "GET /panels", "POST /panels/*/start". The install dialog shows these, the host refuses anything undeclared, and the usage ledger records which were actually earned.',
        ),
    contributes: contributesSchema.optional(),
});

// (2026-11-26) A watch kind's check is answered by the backend, and the cards whose gateway addresses it is handed are
// this extension's own: one extension never reaches another's connections through a check.
const servedChecks = (manifest: z.infer<typeof ManifestShape>, ctx: z.RefinementCtx): void => {
    const kinds = manifest.contributes?.watchKinds ?? [];
    if (kinds.length > 0 && manifest.server === undefined) {
        ctx.addIssue({ code: "custom", path: ["contributes", "watchKinds"], message: "watch kinds need a `server` bundle to answer their checks" });
    }
    const cards = new Set((manifest.contributes?.capabilities ?? []).map((card) => card.id));
    for (const [index, kind] of kinds.entries()) {
        const foreign = (kind.capabilities ?? []).find((card) => !cards.has(card));
        if (foreign !== undefined) {
            ctx.addIssue({ code: "custom", path: ["contributes", "watchKinds", index, "capabilities"], message: `"${foreign}" is not one of this extension's own capability cards` });
        }
    }
    const ids = kinds.map((kind) => kind.id);
    const doubled = ids.find((id, index) => ids.indexOf(id) !== index);
    if (doubled !== undefined) {
        ctx.addIssue({ code: "custom", path: ["contributes", "watchKinds"], message: `the watch kind "${doubled}" is declared twice` });
    }
};

// One job per id within a manifest: a second declaration of an id would name the same stored choice twice.
const declaredRoles = (manifest: z.infer<typeof ManifestShape>, ctx: z.RefinementCtx): void => {
    const ids = (manifest.contributes?.modelRoles ?? []).map((role) => role.id);
    const doubled = ids.find((id, index) => ids.indexOf(id) !== index);
    if (doubled !== undefined) {
        ctx.addIssue({ code: "custom", path: ["contributes", "modelRoles"], message: `the model role "${doubled}" is declared twice` });
    }
};

// (2026-11-26) A public route is answered by the backend, and one scoped to an automation reads that automation from this
// extension's own listener provider: a door never opens onto another extension's automations.
const servedPublicRoutes = (manifest: z.infer<typeof ManifestShape>, ctx: z.RefinementCtx): void => {
    const routes = manifest.contributes?.publicRoutes ?? [];
    if (routes.length > 0 && manifest.server === undefined) {
        ctx.addIssue({ code: "custom", path: ["contributes", "publicRoutes"], message: "public routes need a `server` bundle to answer them" });
    }
    for (const [index, route] of routes.entries()) {
        if (route.automation === true && manifest.contributes?.listener === undefined) {
            ctx.addIssue({
                code: "custom",
                path: ["contributes", "publicRoutes", index, "automation"],
                message: "a route scoped to an automation reads it from this extension's own `contributes.listener`, which it does not declare",
            });
        }
    }
};

// What each field means taken together, which no one field's schema can say: tools need something to serve them.
const servedTools = (manifest: z.infer<typeof ManifestShape>, ctx: z.RefinementCtx): void => {
    const contributes = manifest.contributes;
    const tools = contributes?.tools;
    const cards = contributes?.capabilities ?? [];
    for (const card of cards) {
        if (card.kind === "cli" && card.mcp !== undefined && manifest.server === undefined) {
            ctx.addIssue({ code: "custom", path: ["contributes", "capabilities"], message: `card "${card.id}" declares \`mcp\`, which only a \`server\` bundle can answer` });
        }
    }
    servedChecks(manifest, ctx);
    declaredRoles(manifest, ctx);
    servedPublicRoutes(manifest, ctx);
    if (tools === undefined) {
        return;
    }
    if (tools.process !== undefined) {
        const process = contributes?.processes?.find((entry) => entry.name === tools.process);
        if (process?.port !== "auto") {
            ctx.addIssue({
                code: "custom",
                path: ["contributes", "tools", "process"],
                message: `tools.process must name a process in contributes.processes declared with port: "auto"`,
            });
        }
        if (tools.path === undefined) {
            ctx.addIssue({ code: "custom", path: ["contributes", "tools", "path"], message: "tools served by a process need the path its MCP endpoint answers at" });
        }
    } else if (manifest.server === undefined) {
        ctx.addIssue({ code: "custom", path: ["contributes", "tools"], message: "tools need a `server` bundle to serve them, or a `process` that does" });
    }
    if (tools.perCard !== undefined && !cards.some((card) => card.kind === "cli" && card.id === tools.perCard)) {
        ctx.addIssue({ code: "custom", path: ["contributes", "tools", "perCard"], message: `tools.perCard must name one of this extension's cli cards` });
    }
};

export const ExtensionManifestSchema = ManifestShape.superRefine(servedTools);
export type ExtensionManifest = z.infer<typeof ExtensionManifestSchema>;

// (2026-11-26) What a manifest declares its backend may hear, hold, run and be woken by (its `permissions`), and the
// watch kinds whose checks it answers, as the backend host is told them.
export const declaredOfBackend = (manifest: Pick<ExtensionManifest, "permissions" | "contributes">) => ({
    declared: declaredReachOf(manifest.permissions),
    watchKinds: (manifest.contributes?.watchKinds ?? []).map((kind) => kind.id),
});

// The extension's identity everywhere (capability entries, /ext routes, settings namespaces); derived, never declared,
// so it can't contradict the manifest's publisher/name.
export const extensionIdOf = (manifest: Pick<ExtensionManifest, "publisher" | "name">): string => `${manifest.publisher}.${manifest.name}`;
