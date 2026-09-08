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
import Icon from "./components/primitives/Icon.vue";
import { BUNDLED_ICONS } from "./icons/iconData.generated.js";
import { Theme } from "./styles/theme.js";
import { vAction } from "./lib/pressAction.js";
import { vLongpress } from "./lib/longPress.js";
import { stabilizeStyleWrites } from "./lib/styleStability.js";
import { vTooltip } from "./lib/tooltip.js";

// Every `primevue/<component>/style` module exports a default at runtime, but its declared types omit it (and the
// loader methods `BaseStyle` doesn't declare), so a default import types as the namespace. This interface is the
// shape those modules actually export.
interface PrimeComponentStyle {
    name: string;
    getComponentTheme: () => { css?: string | undefined; style?: string | undefined };
    load: (css: string | undefined, options: { name: string }) => unknown;
    loadStyle: (options: { name: string }, style: string | undefined) => unknown;
}
const asComponentStyle = (style: unknown): PrimeComponentStyle => style as PrimeComponentStyle;
const primeComponentStyles = [ButtonStyle, CheckboxStyle, ContextMenuStyle, DialogStyle, DrawerStyle, PopoverStyle, ToggleSwitchStyle].map(asComponentStyle);

// PrimeVue writes component theme CSS at runtime, not in the app stylesheet, so a component first reached via a
// lazy route would append its `<style>` nodes late. Preload every PrimeVue import here at boot, alongside the
// common theme, so navigation never changes stylesheet ownership.
const preloadPrimeComponentStyles = (): void => {
    for (const style of primeComponentStyles) {
        const component = style.getComponentTheme();
        style.load(component.css, { name: `${style.name}-variables` });
        style.loadStyle({ name: `${style.name}-style` }, component.style);
    }
};

// Design system's single entry point: wires the PrimeVue preset, dark-mode selector, and `cssLayer` order
// (`utilities` last, so Tailwind always beats PrimeVue). Call once from the app's main.ts.
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
    // PrimeVue re-writes its style nodes' bytes on every `updated` hook, flashing the document; hold them stable before
    // the first write.
    stabilizeStyleWrites(`style[data-primevue-style-id]`);
    preloadPrimeComponentStyles();
    // Registers `v-tooltip` globally so it works in any component; this is the app's own directive, not PrimeVue's.
    app.directive(`tooltip`, vTooltip);
    // Touch counterpart of the context menu: `v-longpress` opens bottom sheets on coarse-pointer devices.
    app.directive(`longpress`, vLongpress);
    // `v-action` gives hand-styled controls (non-`<Button>`) Button's press-to-lock-and-wait behavior; global since
    // call sites are spread across every view.
    app.directive(`action`, vAction);
    // Register the icon primitive globally so every `<Icon name="…">` resolves without a per-file import.
    app.component(`Icon`, Icon);
}
