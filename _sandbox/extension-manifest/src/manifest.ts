import { z } from "zod";
import { MARK_FIELDS } from "./mark.js";
import { contributesSchema } from "./points/index.js";

/* The extension manifest: `intentic-extension.json` at the extension repo root (deliberately NOT inside
 * .claude-plugin/, that directory is Claude Code's namespace with its own semantics). The manifest is the
 * approval surface: the install dialog shows exactly these declared contributions before the owner confirms,
 * and the host refuses runtime registrations (views, commands) whose ids the approved manifest never declared.
 *
 * This file is the ENVELOPE only, who the extension is, which host it needs, what code it ships, how far it
 * may reach. What it may CONTRIBUTE is one file per contribution point under points/, assembled here; see
 * contribution-point.ts for why the description travels with the schema instead of sitting in a comment. */

export const ExtensionManifestSchema = z.object({
    /* The authoring schema this manifest is written against, editors read it and give the author completion,
     * hover text and a red squiggle on a misspelt key. Declared so it survives the parse rather than being
     * silently stripped, which is what would otherwise happen to the one field an author is most likely to add
     * by hand. Nothing at runtime reads it. */
    $schema: z.string().optional().describe("The authoring schema, for editor completion and validation. Nothing at runtime reads it."),
    publisher: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    // The extension's own semver, display/identity only; the installed code identity is the pinned commit sha.
    version: z.string().min(1).describe("Your own semver — display and identity only. The installed code's identity is the pinned commit sha."),
    /* The section this extension sits under in the Sandbox hub's Extensions tab, a grouping by what it is FOR,
     * declared because it cannot be derived. Nine of the first-party extensions contribute a rail tile, so a
     * grouping read off `contributes` puts more than half the list in one section and says nothing about any of
     * them. Deliberately a loose string, exactly like a connector's `catalog.category`: the vocabulary belongs
     * to the surface that renders it (extensionCategories.ts in the web app), and an extension declaring a
     * section this app has never heard of lands in "Other" rather than failing to install. */
    category: z
        .string()
        .min(1)
        .optional()
        .describe(
            "Which section of the Extensions tab this sits under — a grouping by what it is FOR, which cannot be derived from what it contributes. A section this app has never heard of lands in “Other” rather than failing to install.",
        ),
    /* What the extension is drawn as wherever it is LISTED rather than used, the Extensions tab, a registry
     * being browsed, the gallery. Deliberately here and not on a view: `Activation.icon` is the glyph of one
     * rail tile, it only exists once the extension's code has activated in this browser, and nine of the
     * first-party extensions register no view at all. An extension that is switched off, daemon-only, or not
     * yet installed still has to look like something. See MARK_FIELDS. */
    ...MARK_FIELDS,
    // Semver range over the host's extension API version (extensionApiVersion), checked before activation.
    engines: z
        .object({ intentic: z.string().min(1) })
        .describe("A semver range over the host's extension API version, checked before your code is activated."),
    // Repo-relative path of the prebuilt single-file ESM bundle (built with `vue` and `@intentic/extension-api`
    // as externals); absent ⇒ an extension with no UI entry.
    entry: z
        .string()
        .min(1)
        .refine((value) => !value.split("/").includes(".."), { message: "entry must stay inside the checkout" })
        .optional()
        .describe(
            "Repo-relative path of your prebuilt single-file ESM bundle, built with `vue` and `@intentic/extension-api` as externals. Absent ⇒ an extension with no UI.",
        ),
    /* Repo-relative path of the prebuilt single-file node ESM SERVER bundle, the extension's BACKEND half,
     * exporting `activateServer(api, context)`. Loaded by the daemon's backend host (a separate supervised
     * process, so a toggle or a live edit is a host restart rather than a daemon death) and served under the
     * extension's own route namespace `/x/<id>/…`, which the daemon proxies. Self-contained by construction:
     * the host provides no import map and the baked checkout has no node_modules, so everything but node
     * builtins must be bundled in. Absent ⇒ the extension has no backend. */
    server: z
        .string()
        .min(1)
        .refine((value) => !value.split("/").includes(".."), { message: "server must stay inside the checkout" })
        .optional()
        .describe(
            "Repo-relative path of your prebuilt single-file node ESM server bundle, exporting `activateServer`. Served under your own route namespace, which the daemon proxies. Nothing is provided at runtime but node builtins, so bundle everything else in. Absent ⇒ no backend.",
        ),
    // Declared reach, both halves in one grammar, "<METHOD> <path-glob>" where `*` matches one path segment
    // (e.g. "GET /panels", "POST /panels/*/start"), so the install dialog, the gate and the usage ledger read
    // one vocabulary.
    //   sandbox, the daemon routes the UI half may call through api.sandbox (the host refuses undeclared
    //             ones). An extension's OWN namespace `/x/<its id>/…` needs no entry: its backend is its own.
    //   daemon , the daemon routes the SERVER half may call through api.daemon, enforced by the daemon's
    //             extension-token grant. Separate from `sandbox` because the halves run as different
    //             principals: the UI acts with the owner's session, the backend with a minted per-extension
    //             token, and a grant to one must never quietly widen the other.
    // Absent (or an absent key) ⇒ that half makes no daemon calls.
    permissions: z
        .object({
            sandbox: z
                .array(z.string())
                .optional()
                .describe("Daemon routes your UI half may call. Your own backend namespace needs no entry — its backend is your own code."),
            daemon: z
                .array(z.string())
                .optional()
                .describe(
                    "Daemon routes your SERVER half may call. Separate from `sandbox` because the two halves run as different principals — the UI as the owner's session, the backend as a minted per-extension token — so a grant to one must never quietly widen the other.",
                ),
        })
        .optional()
        .describe(
            'How far this extension may reach into the daemon, as "<METHOD> <path-glob>" entries where `*` matches one path segment — e.g. "GET /panels", "POST /panels/*/start". The install dialog shows these, the host refuses anything undeclared, and the usage ledger records which were actually earned.',
        ),
    contributes: contributesSchema.optional(),
});
export type ExtensionManifest = z.infer<typeof ExtensionManifestSchema>;

// The extension's identity everywhere (capability entries, /ext routes, settings namespaces), derived, never
// declared, so it can't contradict the publisher/name the install dialog showed.
export const extensionIdOf = (manifest: Pick<ExtensionManifest, "publisher" | "name">): string => `${manifest.publisher}.${manifest.name}`;
