import type { Engine } from "./contract.js";

// The extension's settings, read by both halves: the viewer passes the engine with every open and offers auto-start
// where the wait is felt, the backend acts on both at boot. Declared in intentic-extension.json; the host persists them
// in .intentic/config/extension-settings.json.
export const AUTO_START = "autoStart";
export const ENGINE = "engine";

// Whether the owner asked for the editor to be prepared with the sandbox: the browser engine's download, or the
// document server's container. Anything but a true boolean is off: the setting is typed boolean, and a store that
// answers otherwise is not to be guessed at.
export const autoStartOf = (settings: Record<string, unknown> | undefined): boolean => settings?.[AUTO_START] === true;

// The engine the owner chose. Only the document server is ever chosen by name; anything else is the browser engine,
// the default that needs no Docker.
export const engineOf = (settings: Record<string, unknown> | undefined): Engine => (settings?.[ENGINE] === "server" ? "server" : "browser");
