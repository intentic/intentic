import { tintedGround } from "@intentic/ui";
import { useTheme } from "@intentic/ui/theme";
import { computed, watch } from "vue";
import { useSandbox } from "../../../../client/sandbox/useSandbox";
import { sandboxColor } from "./sandboxColor";

// THE OPEN SANDBOX'S COLOUR, ON <html>: `--sandbox-color` for the stylesheet to mix from, and `data-sandbox-color` so a
// rule that tints something applies only while there is a sandbox to be told apart (a desktop window on a folder of
// this computer has none, and keeps the look's own chrome). What gets tinted is skins/sandboxColor.css's to say; the
// colour is the sandbox's (sandboxColor.ts), never this reader's. Installed once per window from main.ts, beside the
// look's own composables.

const ATTRIBUTE = `data-sandbox-color`;
const PROPERTY = `--sandbox-color`;
// The boot frame's own values (index.html), put back when no sandbox is open.
const PLAIN_CHROME = { light: `#f4f1ec`, dark: `#141210` } as const;

const sandbox = useSandbox();
const { scheme } = useTheme();
const color = computed(() => (sandbox.active.value === undefined ? undefined : sandboxColor(sandbox.active.value)));

const apply = ([hex, mode]: readonly [string | undefined, `light` | `dark`]): void => {
    const root = document.documentElement;
    if (hex === undefined) {
        root.removeAttribute(ATTRIBUTE);
        root.style.removeProperty(PROPERTY);
    } else {
        root.setAttribute(ATTRIBUTE, hex);
        root.style.setProperty(PROPERTY, hex);
    }
    // The browser's own chrome (a phone's address bar, an installed app's title bar) wears the tinted rail's ground, so
    // the cue reaches past the page's edge.
    document.querySelector(`meta[name="theme-color"]`)?.setAttribute(`content`, hex === undefined ? PLAIN_CHROME[mode] : tintedGround(hex, mode === `dark`));
};

// `sync` for the reason the look's own composables use it: a frame in the previous sandbox's colour is the bug.
watch(() => [color.value, scheme.value] as const, apply, { immediate: true, flush: `sync` });

/** Starts painting <html> in the open sandbox's colour; called once per window. */
export const installSandboxColor = (): void => {
    useSandboxColor();
};

export function useSandboxColor() {
    return { color };
}
