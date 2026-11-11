// allow(kit-check): the desktop app mounts this catalog itself, having no extension host to mount it.
import { registerExtensionMessages } from "@intentic/extension-ui/i18n";
import { messages, PASSWORDS_EXTENSION_ID } from "../i18n.js";

// The Passwords app as its host mounts it: the desktop app, over its Tauri port, as This computer's Passwords. No sandbox
// hosts it (2026-11-11): a sandbox lists the pointers it was given as secrets. The one entry a package outside
// _extensions may import (_tools/checks/lib/extension-deps.mjs CONSUMERS).
export * from "./model.js";
export * from "./port.js";
export type { PasswordsSelection } from "./selection.js";
export { default as PasswordsApp } from "./PasswordsApp.vue";
export { messages as passwordsMessages, PASSWORDS_EXTENSION_ID } from "../i18n.js";

// The app's words, mounted by the host before it draws the app: the catalog under its extension-style id, which is
// what `t` reads it by.
export const registerPasswordsMessages = (): Promise<void> => registerExtensionMessages(PASSWORDS_EXTENSION_ID, messages);
