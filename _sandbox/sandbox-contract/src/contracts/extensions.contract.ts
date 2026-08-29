import { oc } from "@orpc/contract";
import { CapabilityIdParamSchema } from "../schemas/capabilities.js";
import {
    ExtensionEnabledInputSchema,
    ExtensionProcessParamSchema,
    ExtensionProcessStatusSchema,
    ExtensionSettingsInputSchema,
    ExtensionSettingsSchema,
    ExtensionsListSchema,
    ExtensionUpdateActionSchema,
    ExtensionUpdateAppliedSchema,
    ExtensionUpdatePolicyInputSchema,
    ExtensionUpdatePreviewSchema,
    ExtensionUpdatesCheckedSchema,
    ExtensionUsageInputSchema,
    WorkspaceExtensionCreatedSchema,
    WorkspaceExtensionCreateSchema,
} from "../schemas/extension-updates.js";
import { ExtensionReadinessSchema } from "../schemas/maintenance.js";
import { OkSchema } from "../schemas/shared.js";

// Installed extensions resolved to their approved manifests, what the web extension host boots from. The
// bundle itself is a plain Hono route (GET /extensions/{id}/bundle): raw ESM bytes are not an oRPC payload.
// `settings`/`setSettings` carry the extension's own contributes.settings values; keys the manifest never
// declared are refused, the same honesty rule the host applies to runtime view/command registrations.
export const extensionsContract = {
    list: oc
        .route({
            method: "GET",
            path: "/extensions",
            summary: "Installed extensions",
            description:
                "Every extension installed here, resolved to the manifest the owner approved, which is what the app boots its extension host from. The code itself is served separately, because raw script bytes are not a JSON answer.",
        })
        .output(ExtensionsListSchema),
    // Author a new extension in place: writes a running one into .intentic/config/workspace-extensions/<name>/. The only
    // creating route here, and it exists because that directory is otherwise reachable exclusively through an
    // agent's file tools, which is a fine way to CHANGE an extension and a poor way to meet the idea of one.
    create: oc
        .route({
            method: "POST",
            path: "/extensions/workspace",
            summary: "Write a new extension in place",
            description:
                "Scaffolds a working extension into this workspace and installs it. The only call here that creates one, and it exists because that folder is otherwise reachable only through an agent's file tools, which is a fine way to change an extension and a poor way to meet the idea of one.",
        })
        .input(WorkspaceExtensionCreateSchema)
        .output(WorkspaceExtensionCreatedSchema),
    settings: oc
        .route({
            method: "GET",
            path: "/extensions/{id}/settings",
            summary: "An extension's settings",
            description: "The current values for the settings this extension declared it has.",
        })
        .input(CapabilityIdParamSchema)
        .output(ExtensionSettingsSchema),
    setSettings: oc
        .route({
            method: "POST",
            path: "/extensions/{id}/settings",
            summary: "Change an extension's settings",
            description:
                "Writes new values. A key the extension never declared is refused rather than quietly stored, the same honesty rule that governs everything else an extension claims.",
        })
        .input(ExtensionSettingsInputSchema)
        .output(OkSchema),
    // The owner's on/off switch. Disabling stops the extension's declared processes here and now; its agent
    // plugin dir and PATH entry are rebuilt per turn, and an `environment` fragment only at the next image
    // rebuild, the Extensions tab states which of those an extension actually has.
    setEnabled: oc
        .route({
            method: "POST",
            path: "/extensions/{id}/enabled",
            summary: "Turn an extension on or off",
            description:
                "The owner's switch. Turning one off stops its background processes at once. What it contributes to an agent's tools is rebuilt at the start of the next turn, and anything it adds to the sandbox image only at the next rebuild.",
        })
        .input(ExtensionEnabledInputSchema)
        .output(OkSchema),
    // The host reporting which declared routes it just let through. Written by the browser because that is where
    // the permission gate runs (apiImpl.ts), the daemon sees an extension's traffic as ordinary authenticated
    // requests and cannot tell which extension, or which declared entry, any of it belongs to.
    recordUsage: oc
        .route({
            method: "POST",
            path: "/extensions/{id}/usage",
            summary: "Record what an extension just used",
            description:
                "Written by the app rather than measured by the daemon, because the permission gate runs in the browser: from the sandbox's side an extension's traffic is indistinguishable from anyone else's. This is how the record of which powers an extension actually exercises gets kept.",
        })
        .input(ExtensionUsageInputSchema)
        .output(OkSchema),
    /* Whether this extension is fit for somebody else to run, the checks answerable from its files alone. Read
     * on demand rather than carried on the list: it reads the bundle off disk per extension, and it is looked at
     * when an author is about to publish, not every time the tab renders. */
    readiness: oc
        .route({
            method: "GET",
            path: "/extensions/{id}/readiness",
            summary: "Whether an extension is fit to share",
            description:
                "The checks that can be answered from an extension's own files, for an author about to publish. Read on demand rather than carried on the list, because it reads the code off disk each time.",
        })
        .input(CapabilityIdParamSchema)
        .output(ExtensionReadinessSchema),
    /* The update lifecycle for a GIT-INSTALLED extension. The list carries what the periodic registry check
     * found (update/advisory/health per row); these are the verbs around it. `checkUpdates` runs the comparison
     * now (the tab's "check now"). `updatePreview` stages the offered sha and answers with the version story +
     * the mechanical powers diff, the read BEFORE the click, costing one throwaway clone like a registry
     * browse. `applyUpdate` is the transaction: re-clone, validate, quiesce, swap (keeping the outgoing
     * checkout one back), restart, health-watch, on the EXISTING capability config, so a private-source token
     * survives what a bare re-add would lose. `revert` swaps the kept-previous checkout back. Update and revert
     * change the code that runs, so like install they are owner-only. */
    checkUpdates: oc
        .route({
            method: "POST",
            path: "/extensions/updates/check",
            summary: "Look for extension updates now",
            description:
                "Compares every installed extension against its source and reports what is newer, what carries an advisory and what looks unhealthy. This also happens on a schedule; call it to check on demand.",
        })
        .output(ExtensionUpdatesCheckedSchema),
    updatePreview: oc
        .route({
            method: "POST",
            path: "/extensions/{id}/update/preview",
            summary: "What an update would change",
            description:
                "The read before the click: which versions are involved and exactly which powers the new code asks for that the running one does not. Costs one throwaway copy of the source, the same as browsing a registry entry.",
        })
        .input(ExtensionUpdateActionSchema)
        .output(ExtensionUpdatePreviewSchema),
    applyUpdate: oc
        .route({
            method: "POST",
            path: "/extensions/{id}/update",
            summary: "Update an extension",
            description:
                "The whole swap as one transaction: fetch, check, quiet the running one, replace it while keeping the outgoing copy one step back, restart and watch it come up. The existing configuration is kept, so a token for a private source survives what removing and re-adding would lose. Owner only, because it changes what code runs.",
        })
        .input(ExtensionUpdateActionSchema)
        .output(ExtensionUpdateAppliedSchema),
    revert: oc
        .route({
            method: "POST",
            path: "/extensions/{id}/revert",
            summary: "Go back to the previous version",
            description: "Swaps the copy kept from before the last update back into place. Owner only, for the same reason updating is.",
        })
        .input(CapabilityIdParamSchema)
        .output(ExtensionUpdateAppliedSchema),
    // The owner's standing answer per extension (notify / agent / auto, and the advisory opt-out), see
    // ExtensionUpdatePolicySchema for what each rung means.
    setUpdatePolicy: oc
        .route({
            method: "POST",
            path: "/extensions/{id}/update-policy",
            summary: "How an extension should handle its own updates",
            description:
                "The owner's standing answer for one extension: tell me, have an agent look at it, or just do it. Security advisories can be opted out of separately.",
        })
        .input(ExtensionUpdatePolicyInputSchema)
        .output(OkSchema),
    // Declared background processes (contributes.processes): tmux-managed through the panel machinery
    // (session `panel-ext-<id>-<name>`, PORT-assigned, optional tunneled preview route).
    processStatus: oc
        .route({
            method: "GET",
            path: "/extensions/{id}/processes/{name}",
            summary: "Whether an extension's background process is up",
            description: "The state of one process an extension declared, with the port it was given and its preview address if it has one.",
        })
        .input(ExtensionProcessParamSchema)
        .output(ExtensionProcessStatusSchema),
    processStart: oc
        .route({
            method: "POST",
            path: "/extensions/{id}/processes/{name}/start",
            summary: "Start an extension's background process",
            description: "Brings one of an extension's declared processes up in an attachable terminal.",
        })
        .input(ExtensionProcessParamSchema)
        .output(OkSchema),
    processStop: oc
        .route({
            method: "POST",
            path: "/extensions/{id}/processes/{name}/stop",
            summary: "Stop an extension's background process",
            description: "Shuts one of an extension's declared processes down and frees its port.",
        })
        .input(ExtensionProcessParamSchema)
        .output(OkSchema),
};
