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
import { vTooltip } from "./lib/tooltip.js";

/* PrimeVue 4.5 reloads its directive styles from every `updated` hook. Its style loader finds the existing
 * `<style data-primevue-style-id="base">` node and assigns the same textContent again; assigning identical
 * text still replaces the node's text child, so Chrome DevTools invalidates and rebuilds the whole Styles
 * editor whenever a PrimeVue button updates. That turns ordinary request state (loading labels, disabled
 * buttons, notifications) into a flash that also discards an in-progress CSS edit.
 *
 * Protect only PrimeVue-owned style nodes, and only make an IDENTICAL assignment a no-op. A new component's
 * first stylesheet write happens normally, as does a genuinely changed preset. The observer covers styles
 * introduced by lazy views; the microtask covers the styles PrimeVue inserts during the synchronous app
 * mount immediately after installUi returns. */
const stabilizedPrimeStyles = new WeakSet<HTMLStyleElement>();
const primeStyleObservers = new WeakMap<Document, MutationObserver>();
const primeComponentStyles = [ButtonStyle, CheckboxStyle, ContextMenuStyle, DialogStyle, DrawerStyle, PopoverStyle, ToggleSwitchStyle] as const;

const stabilizePrimeStyle = (style: HTMLStyleElement): void => {
    if (stabilizedPrimeStyles.has(style)) {
        return;
    }
    const descriptor = Object.getOwnPropertyDescriptor(Node.prototype, `textContent`);
    if (descriptor?.get === undefined || descriptor.set === undefined) {
        return;
    }
    stabilizedPrimeStyles.add(style);
    Object.defineProperty(style, `textContent`, {
        configurable: true,
        enumerable: descriptor.enumerable,
        get() {
            return descriptor.get!.call(this) as string | null;
        },
        set(value: string | null) {
            if (descriptor.get!.call(this) !== value) {
                descriptor.set!.call(this, value);
            }
        },
    });
};

const stabilizePrimeStylesIn = (root: ParentNode): void => {
    if (root instanceof HTMLStyleElement && root.hasAttribute(`data-primevue-style-id`)) {
        stabilizePrimeStyle(root);
    }
    root.querySelectorAll<HTMLStyleElement>(`style[data-primevue-style-id]`).forEach(stabilizePrimeStyle);
};

const stabilizePrimeStyleWrites = (): void => {
    if (typeof document === `undefined` || primeStyleObservers.has(document)) {
        return;
    }
    const observer = new MutationObserver((records) => {
        for (const record of records) {
            record.addedNodes.forEach((node) => {
                if (node instanceof Element || node instanceof DocumentFragment) {
                    stabilizePrimeStylesIn(node);
                }
            });
        }
    });
    observer.observe(document.head, { childList: true });
    primeStyleObservers.set(document, observer);
    queueMicrotask(() => stabilizePrimeStylesIn(document.head));
};

/* PrimeVue owns component theme CSS at runtime rather than in the app stylesheet. A component first reached
 * through a lazy route therefore appends two <style> nodes while DevTools is open, which replaces every row in
 * its Styles editor. These are all PrimeVue value imports in app and extension source; load their themes at
 * boot, alongside PrimeVue's common theme, so navigating cannot change stylesheet ownership. */
const preloadPrimeComponentStyles = (): void => {
    for (const style of primeComponentStyles) {
        const component = style.getComponentTheme() ?? {};
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
    stabilizePrimeStyleWrites();
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
