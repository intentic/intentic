// allow(kit-check): the desktop app mounts this catalog itself; the rail bundle never calls registerPasswordsMessages.
import { registerExtensionMessages } from "@intentic/extension-ui/i18n";
import { messages, PASSWORDS_EXTENSION_ID } from "../i18n.js";

// The Passwords app as any host mounts it: the desktop app over its Tauri port, this extension's rail view over the
// sandbox's. The one entry a package outside _extensions may import (_tools/checks/lib/extension-deps.mjs CONSUMERS).
export * from "./model.js";
export * from "./port.js";
export type { PasswordsSelection } from "./selection.js";
export { default as PasswordsApp } from "./PasswordsApp.vue";
export { messages as passwordsMessages, PASSWORDS_EXTENSION_ID } from "../i18n.js";

// The app's words mounted where the extension host would have mounted them, for a host with no extension host (the
// desktop app): the same catalog under the same id, so `t` reads alike in both.
export const registerPasswordsMessages = (): Promise<void> => registerExtensionMessages(PASSWORDS_EXTENSION_ID, messages);
