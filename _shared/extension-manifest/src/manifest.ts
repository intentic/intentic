import { z } from "zod";
import { MARK_FIELDS } from "./mark.js";
import { contributesSchema } from "./points/index.js";

// The extension manifest (`intentic-extension.json`, not under .claude-plugin/): the approval surface the install
// dialog renders, and the host refuses any runtime registration whose id it didn't declare here. This file is the
// envelope only; contributions are assembled from points/.

export const ExtensionManifestSchema = z.object({
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
        .optional()
        .describe(
            "Repo-relative path of your prebuilt single-file ESM bundle, built with `vue` and `@intentic/extension-api` as externals. Absent ⇒ an extension with no UI.",
        ),
    // Repo-relative path of the server bundle; must bundle in everything but node builtins. Absent ⇒ no backend.
    server: z
        .string()
        .min(1)
        .refine((value) => !value.split("/").includes(".."), { message: "server must stay inside the checkout" })
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
                .array(z.string())
                .optional()
                .describe("Daemon routes your UI half may call. Your own backend namespace needs no entry: its backend is your own code."),
            daemon: z
                .array(z.string())
                .optional()
                .describe(
                    "Daemon routes your SERVER half may call. Separate from `sandbox` because the two halves run as different principals: the UI as the owner's session, the backend as a minted per-extension token, so a grant to one must never quietly widen the other.",
                ),
        })
        .optional()
        .describe(
            'How far this extension may reach into the daemon, as "<METHOD> <path-glob>" entries where `*` matches one path segment: e.g. "GET /panels", "POST /panels/*/start". The install dialog shows these, the host refuses anything undeclared, and the usage ledger records which were actually earned.',
        ),
    contributes: contributesSchema.optional(),
});
export type ExtensionManifest = z.infer<typeof ExtensionManifestSchema>;

// The extension's identity everywhere (capability entries, /ext routes, settings namespaces); derived, never declared,
// so it can't contradict the manifest's publisher/name.
export const extensionIdOf = (manifest: Pick<ExtensionManifest, "publisher" | "name">): string => `${manifest.publisher}.${manifest.name}`;
