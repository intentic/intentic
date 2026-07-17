import { addCollection } from "@iconify/vue";
import PrimeVue from "primevue/config";
import Tooltip from "primevue/tooltip";
import type { App } from "vue";
import Icon from "../components/Icon.vue";
import { BUNDLED_ICONS } from "../icons/iconData.generated.js";
import { Theme } from "../styles/theme.js";
import { vLongpress } from "./longPress.js";

/* Single entry point for the design system: wires the bridged PrimeVue preset, the dark-mode selector
 * (kept in sync by useTheme), and — crucially — the cssLayer order so the cascade is deterministic:
 * `utilities` is last, so Tailwind utility classes always beat PrimeVue's component styles. Call it once
 * from the app's main.ts as `installUi(app)`. */
export function installUi(app: App): void {
    // Register the bundled icon sets so every <Icon> resolves locally — no runtime Iconify API fetch.
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
    // Register the tooltip directive globally so `v-tooltip` works in any component (the rail, composer, …).
    app.directive(`tooltip`, Tooltip);
    // Touch counterpart of the context menu: `v-longpress` opens bottom sheets on coarse-pointer devices.
    app.directive(`longpress`, vLongpress);
    // Register the icon primitive globally so every `<Icon name="…">` resolves without a per-file import.
    app.component(`Icon`, Icon);
}
