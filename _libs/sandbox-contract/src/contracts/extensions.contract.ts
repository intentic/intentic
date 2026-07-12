import { oc } from "@orpc/contract";
import {
    CapabilityIdParamSchema,
    ExtensionSettingsInputSchema,
    ExtensionSettingsSchema,
    ExtensionsListSchema,
    OkSchema,
} from "../schemas.js";

// Installed extensions resolved to their approved manifests — what the web extension host boots from. The
// bundle itself is a plain Hono route (GET /extensions/{id}/bundle): raw ESM bytes are not an oRPC payload.
// `settings`/`setSettings` carry the extension's own contributes.settings values; keys the manifest never
// declared are refused, the same honesty rule the host applies to runtime view/command registrations.
export const extensionsContract = {
    list: oc.route({ method: "GET", path: "/extensions" }).output(ExtensionsListSchema),
    settings: oc.route({ method: "GET", path: "/extensions/{id}/settings" }).input(CapabilityIdParamSchema).output(ExtensionSettingsSchema),
    setSettings: oc.route({ method: "POST", path: "/extensions/{id}/settings" }).input(ExtensionSettingsInputSchema).output(OkSchema),
};
