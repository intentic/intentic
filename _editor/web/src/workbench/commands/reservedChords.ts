import { chordSignature } from "./keybindings";

// Chords a page never receives, by who takes them first. The operating system's are gone in every window; the browser's
// only in a tab, since an app window reserves nothing (windowKind.ts). A default chord on either list is a shortcut that
// cannot fire, and one a person records is one their browser or system answers instead.

export type ChordKeeper = `system` | `browser`;

// macOS's own, answered before any app sees them: hide, hide others, minimise, quit, the app and window switchers,
// Spotlight, Mission Control, the screenshot keys, lock, full screen, the emoji picker, the Dock, force quit.
const MAC_SYSTEM = [
    `Mod+H`,
    `Mod+Alt+H`,
    `Mod+M`,
    `Mod+Q`,
    `Mod+Tab`,
    `Mod+Space`,
    `Mod+\``,
    `Ctrl+ArrowLeft`,
    `Ctrl+ArrowRight`,
    `Ctrl+ArrowUp`,
    `Ctrl+ArrowDown`,
    `Mod+Shift+3`,
    `Mod+Shift+4`,
    `Mod+Shift+5`,
    `Ctrl+Mod+Q`,
    `Ctrl+Mod+F`,
    `Ctrl+Mod+Space`,
    `Mod+Alt+D`,
    `Mod+Alt+Escape`,
];
// Chromium's reserved commands as a Mac binds them (close tab and window, new tab, window and private window, reopen
// tab, every tab switch: accelerator_table.cc and global_keyboard_shortcuts_mac.mm), and Safari's ⌥⌘W, which closes
// every other tab.
const MAC_BROWSER = [
    `Mod+W`,
    `Mod+Shift+W`,
    `Mod+T`,
    `Mod+Shift+T`,
    `Mod+N`,
    `Mod+Shift+N`,
    `Mod+Shift+]`,
    `Mod+Shift+[`,
    `Mod+Alt+ArrowRight`,
    `Mod+Alt+ArrowLeft`,
    `Ctrl+PageDown`,
    `Ctrl+PageUp`,
    `Ctrl+Tab`,
    `Ctrl+Shift+Tab`,
    `Mod+Alt+W`,
];
const OTHER_SYSTEM = [`Alt+Tab`, `Alt+F4`];
const OTHER_BROWSER = [`Ctrl+W`, `Ctrl+Shift+W`, `Ctrl+T`, `Ctrl+Shift+T`, `Ctrl+N`, `Ctrl+Shift+N`, `Ctrl+Tab`, `Ctrl+Shift+Tab`, `Ctrl+PageDown`, `Ctrl+PageUp`];

const signatures = (bindings: readonly string[], isMac: boolean): ReadonlySet<string> => new Set(bindings.map((binding) => chordSignature(binding, isMac)));
const KEPT = {
    mac: { system: signatures(MAC_SYSTEM, true), browser: signatures(MAC_BROWSER, true) },
    other: { system: signatures(OTHER_SYSTEM, false), browser: signatures(OTHER_BROWSER, false) },
};

/** Who answers this chord before the page does, in this kind of window, or undefined when the page gets it. */
export const chordKeeper = (binding: string, isMac: boolean, appWindow: boolean): ChordKeeper | undefined => {
    const kept = isMac ? KEPT.mac : KEPT.other;
    const signature = chordSignature(binding, isMac);
    if (kept.system.has(signature)) {
        return `system`;
    }
    return !appWindow && kept.browser.has(signature) ? `browser` : undefined;
};
