// The extension's one setting, read by both halves: the viewer offers it where the wait is felt, the backend acts on
// it at boot. Declared in intentic-extension.json; the host persists it in .intentic/config/extension-settings.json.
export const AUTO_START = "autoStart";

// Whether the owner asked for the document server to come up with the sandbox. Anything but a true boolean is off:
// the setting is typed boolean, and a store that answers otherwise is not to be guessed at.
export const autoStartOf = (settings: Record<string, unknown> | undefined): boolean => settings?.[AUTO_START] === true;
