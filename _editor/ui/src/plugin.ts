import { addCollection } from "@iconify/vue";
import PrimeVue from "primevue/config";
import ButtonStyle from "primevue/button/style";
import CheckboxStyle from "primevue/checkbox/style";
import ContextMenuStyle from "primevue/contextmenu/style";
import DialogStyle from "primevue/dialog/style";
import DrawerStyle from "primevue/drawer/style";
import PopoverStyle from "primevue/popover/style";
import ToggleSwitchStyle from "primevue/toggleswitch/style";
import type { App } from "vue";
import Icon from "./components/Icon.vue";
import { BUNDLED_ICONS } from "./icons/iconData.generated.js";
import { Theme } from "./styles/theme.js";
import { vAction } from "./lib/pressAction.js";
import { vLongpress } from "./lib/longPress.js";
import { stabilizeStyleWrites } from "./lib/styleStability.js";
import { vTooltip } from "./lib/tooltip.js";

/* Every `primevue/<component>/style` entry ends in `export { XStyle as default }`, but its shipped declaration
 * names only the class-name enum: no default, and the `BaseStyle` interface it does declare is missing the
 * loader methods the runtime object carries. A default import therefore types as the module NAMESPACE, and
 * every property read below is an error. This is the shape those modules actually export. */
interface PrimeComponentStyle {
    name: string;
    getComponentTheme: () => { css?: string | undefined; style?: string | undefined };
    load: (css: string | undefined, options: { name: string }) => unknown;
    loadStyle: (options: { name: string }, style: string | undefined) => unknown;
}
const asComponentStyle = (style: unknown): PrimeComponentStyle => style as PrimeComponentStyle;
const primeComponentStyles = [ButtonStyle, CheckboxStyle, ContextMenuStyle, DialogStyle, DrawerStyle, PopoverStyle, ToggleSwitchStyle].map(asComponentStyle);

/* PrimeVue owns component theme CSS at runtime rather than in the app stylesheet. A component first reached
 * through a lazy route therefore appends two <style> nodes while DevTools is open, which replaces every row in
 * its Styles editor. These are all PrimeVue value imports in app and extension source; load their themes at
 * boot, alongside PrimeVue's common theme, so navigating cannot change stylesheet ownership. */
const preloadPrimeComponentStyles = (): void => {
    for (const style of primeComponentStyles) {
        const component = style.getComponentTheme();
        style.load(component.css, { name: `${style.name}-variables` });
        style.loadStyle({ name: `${style.name}-style` }, component.style);
    }
};

/* Single entry point for the design system: wires the bridged PrimeVue preset, the dark-mode selector
 * (kept in sync by useTheme), and the cssLayer order so the cascade is deterministic:
 * `utilities` is last, so Tailwind utility classes always beat PrimeVue's component styles. Call it once
 * from the app's main.ts as `installUi(app)`. */
export function installUi(app: App): void {
    // Register the bundled icon sets so every <Icon> resolves locally, no runtime Iconify API fetch.
    BUNDLED_ICONS.forEach((collection) => addCollection(collection));
    app.use(PrimeVue, {
        ripple: true,
        theme: {
            preset: Theme,
            options: {
                darkModeSelector: `[data-mode="dark"]`,
                cssLayer: {
                    name: `primeng`,
                    order: `theme, base, primeng, components, utilities`,
                },
            },
        },
    });
    /* PrimeVue 4.5 reloads its directive styles from every `updated` hook: its loader finds the existing
     * `<style data-primevue-style-id="base">` and assigns the same bytes again, which replaces the sheet and
     * flashes the document (styleStability.ts carries the full argument). Ordinary request state — a loading
     * label, a disabled button, a notification — is enough to trigger it, so hold PrimeVue's own nodes stable
     * before its first one is written. */
    stabilizeStyleWrites(`style[data-primevue-style-id]`);
    preloadPrimeComponentStyles();
    // Register the tooltip directive globally so `v-tooltip` works in any component (the rail, composer, …).
    // Ours, not PrimeVue's, see lib/tooltip.ts for why a popped-out panel forces the issue.
    app.directive(`tooltip`, vTooltip);
    // Touch counterpart of the context menu: `v-longpress` opens bottom sheets on coarse-pointer devices.
    app.directive(`longpress`, vLongpress);
    /* `v-action` is <Button>'s behaviour for the hand-styled controls that are not it: a press that starts
     * async work locks its element and shows the wait. Global for the same reason the tooltip is — the
     * elements that need it are spread across every view, and a per-file import is a thing to forget. */
    app.directive(`action`, vAction);
    // Register the icon primitive globally so every `<Icon name="…">` resolves without a per-file import.
    app.component(`Icon`, Icon);
}
