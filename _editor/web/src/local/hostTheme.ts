import { useImportedTheme } from "../composables/theme/useImportedTheme";

/* THE HOST'S THEME CHANNEL — how an embedding application recolors the local posture to match itself.
 *
 * A host (an editor extension's webview, an iframe parent) owns the chrome around these panels; panels that
 * keep their own colors read as a foreign website inside it. The lever already exists for people — the
 * VSCode-theme import in Settings (composables/theme/) — and this is the same lever held out to the HOST:
 * hand over a theme document (the VSCode color-theme JSON shape, the de-facto interchange format for editor
 * themes), and the same mapper reskins the chrome, flips light/dark, and themes syntax highlighting.
 *
 * Two roads in, because a host has two moments:
 *   - at load: `window.env.local.theme` (beside the posture declaration) — applied before first paint matters,
 *     and how a fresh webview opens already matching.
 *   - live: a `message` event `{ type: "intentic:theme", theme }` — how a mid-session editor theme switch
 *     follows into the panel. `theme: null` clears back to the app's own look.
 *
 * Local posture only (main.ts registers it there and nowhere else): in the platform posture the theme is the
 * USER's setting, and no page a hosted deployment embeds gets to repaint the workspace. The channel carries
 * colors and nothing else — a hostile document can make the panel ugly, not make it act. */

const THEME_MESSAGE = "intentic:theme";

const applyDocument = (theme: unknown): void => {
    const { importThemeJson, clearImportedTheme } = useImportedTheme();
    if (theme === null || theme === undefined) {
        clearImportedTheme();
        return;
    }
    try {
        importThemeJson(JSON.stringify(theme));
    } catch {
        // A malformed document changes nothing — the previous look stands, which is the safe failure.
    }
};

export const listenForHostTheme = (): void => {
    const initial = (window.env?.local as { theme?: unknown } | undefined)?.theme;
    if (initial !== undefined) {
        applyDocument(initial);
    }
    window.addEventListener("message", (event: MessageEvent) => {
        const data: unknown = event.data;
        if (typeof data !== "object" || data === null || (data as { type?: unknown }).type !== THEME_MESSAGE) {
            return;
        }
        applyDocument((data as { theme?: unknown }).theme);
    });
};
