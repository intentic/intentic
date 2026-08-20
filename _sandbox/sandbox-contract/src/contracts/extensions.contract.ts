import { oc } from "@orpc/contract";
import {
    CapabilityIdParamSchema,
    ExtensionEnabledInputSchema,
    ExtensionProcessParamSchema,
    ExtensionProcessStatusSchema,
    ExtensionSettingsInputSchema,
    ExtensionSettingsSchema,
    ExtensionReadinessSchema,
    ExtensionUpdateActionSchema,
    ExtensionUpdateAppliedSchema,
    ExtensionUpdatePolicyInputSchema,
    ExtensionUpdatePreviewSchema,
    ExtensionUpdatesCheckedSchema,
    ExtensionUsageInputSchema,
    ExtensionsListSchema,
    OkSchema,
    WorkspaceExtensionCreatedSchema,
    WorkspaceExtensionCreateSchema,
} from "../schemas.js";

// Installed extensions resolved to their approved manifests, what the web extension host boots from. The
// bundle itself is a plain Hono route (GET /extensions/{id}/bundle): raw ESM bytes are not an oRPC payload.
// `settings`/`setSettings` carry the extension's own contributes.settings values; keys the manifest never
// declared are refused, the same honesty rule the host applies to runtime view/command registrations.
export const extensionsContract = {
    list: oc.route({ method: "GET", path: "/extensions" }).output(ExtensionsListSchema),
    // Author a new extension in place: writes a running one into .intentic/config/workspace-extensions/<name>/. The only
    // creating route here, and it exists because that directory is otherwise reachable exclusively through an
    // agent's file tools, which is a fine way to CHANGE an extension and a poor way to meet the idea of one.
    create: oc.route({ method: "POST", path: "/extensions/workspace" }).input(WorkspaceExtensionCreateSchema).output(WorkspaceExtensionCreatedSchema),
    settings: oc.route({ method: "GET", path: "/extensions/{id}/settings" }).input(CapabilityIdParamSchema).output(ExtensionSettingsSchema),
    setSettings: oc.route({ method: "POST", path: "/extensions/{id}/settings" }).input(ExtensionSettingsInputSchema).output(OkSchema),
    // The owner's on/off switch. Disabling stops the extension's declared processes here and now; its agent
    // plugin dir and PATH entry are rebuilt per turn, and an `environment` fragment only at the next image
    // rebuild, the Extensions tab states which of those an extension actually has.
    setEnabled: oc.route({ method: "POST", path: "/extensions/{id}/enabled" }).input(ExtensionEnabledInputSchema).output(OkSchema),
    // The host reporting which declared routes it just let through. Written by the browser because that is where
    // the permission gate runs (apiImpl.ts), the daemon sees an extension's traffic as ordinary authenticated
    // requests and cannot tell which extension, or which declared entry, any of it belongs to.
    recordUsage: oc.route({ method: "POST", path: "/extensions/{id}/usage" }).input(ExtensionUsageInputSchema).output(OkSchema),
    /* Whether this extension is fit for somebody else to run, the checks answerable from its files alone. Read
     * on demand rather than carried on the list: it reads the bundle off disk per extension, and it is looked at
     * when an author is about to publish, not every time the tab renders. */
    readiness: oc.route({ method: "GET", path: "/extensions/{id}/readiness" }).input(CapabilityIdParamSchema).output(ExtensionReadinessSchema),
    /* The update lifecycle for a GIT-INSTALLED extension. The list carries what the periodic registry check
     * found (update/advisory/health per row); these are the verbs around it. `checkUpdates` runs the comparison
     * now (the tab's "check now"). `updatePreview` stages the offered sha and answers with the version story +
     * the mechanical powers diff, the read BEFORE the click, costing one throwaway clone like a registry
     * browse. `applyUpdate` is the transaction: re-clone, validate, quiesce, swap (keeping the outgoing
     * checkout one back), restart, health-watch, on the EXISTING capability config, so a private-source token
     * survives what a bare re-add would lose. `revert` swaps the kept-previous checkout back. Update and revert
     * change the code that runs, so like install they are owner-only. */
    checkUpdates: oc.route({ method: "POST", path: "/extensions/updates/check" }).output(ExtensionUpdatesCheckedSchema),
    updatePreview: oc
        .route({ method: "POST", path: "/extensions/{id}/update/preview" })
        .input(ExtensionUpdateActionSchema)
        .output(ExtensionUpdatePreviewSchema),
    applyUpdate: oc
        .route({ method: "POST", path: "/extensions/{id}/update" })
        .input(ExtensionUpdateActionSchema)
        .output(ExtensionUpdateAppliedSchema),
    revert: oc.route({ method: "POST", path: "/extensions/{id}/revert" }).input(CapabilityIdParamSchema).output(ExtensionUpdateAppliedSchema),
    // The owner's standing answer per extension (notify / agent / auto, and the advisory opt-out), see
    // ExtensionUpdatePolicySchema for what each rung means.
    setUpdatePolicy: oc.route({ method: "POST", path: "/extensions/{id}/update-policy" }).input(ExtensionUpdatePolicyInputSchema).output(OkSchema),
    // Declared background processes (contributes.processes): tmux-managed through the panel machinery
    // (session `panel-ext-<id>-<name>`, PORT-assigned, optional tunneled preview route).
    processStatus: oc
        .route({ method: "GET", path: "/extensions/{id}/processes/{name}" })
        .input(ExtensionProcessParamSchema)
        .output(ExtensionProcessStatusSchema),
    processStart: oc.route({ method: "POST", path: "/extensions/{id}/processes/{name}/start" }).input(ExtensionProcessParamSchema).output(OkSchema),
    processStop: oc.route({ method: "POST", path: "/extensions/{id}/processes/{name}/stop" }).input(ExtensionProcessParamSchema).output(OkSchema),
};
