import { oc } from "@orpc/contract";
import { OkSchema, SandboxSettingsSchema } from "../schemas.js";

// Per-sandbox agent settings (.intentic/settings.json). `get` returns the current flags with defaults applied
// when the file is absent; `set` overwrites them. Today: whether the agent may search this sandbox's past chats.
export const settingsContract = {
    get: oc.route({ method: "GET", path: "/settings" }).output(SandboxSettingsSchema),
    set: oc.route({ method: "POST", path: "/settings" }).input(SandboxSettingsSchema).output(OkSchema),
};
