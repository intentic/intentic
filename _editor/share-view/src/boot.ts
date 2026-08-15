import { addCollection } from "@iconify/vue";
import Icon from "@intentic/ui/src/components/Icon.vue";
import { BUNDLED_ICONS } from "@intentic/ui/src/icons/iconData.generated.js";
import { vTooltip } from "@intentic/ui/src/lib/tooltip.js";
import type { App } from "vue";

/* THE DESIGN SYSTEM, TO THE EXTENT THIS PAGE USES IT — the icon primitive and the hover label, and nothing
 * else.
 *
 * The app boots the kit with `installUi`, which also stands up PrimeVue: its theme preset, its cascade layer,
 * its ripple. This page renders no PrimeVue component — a transcript is prose, cards and a fold — so calling
 * installUi here would put a component framework into a bundle a stranger downloads to read a conversation,
 * for nothing. Reaching past the barrel is what keeps it out: importing anything from `@intentic/ui` pulls
 * `installUi` into the module graph, and a bundler is right to be conservative about dropping a call it cannot
 * prove is unreachable.
 *
 * The two that ARE registered are registered because the shared tool card renders them globally: `<Icon>` in
 * its header and `v-tooltip` on its rows. Both come from the design system's own files, so the glyphs and the
 * label behave exactly as they do in the app.
 *
 * The icon collections are bundled, never fetched. A shared link is opened by someone with no relationship to
 * this sandbox, and a page that reached out to an icon CDN would be a page that told a third party who is
 * reading what. */
export const installShareUi = (app: App): void => {
    BUNDLED_ICONS.forEach((collection) => addCollection(collection));
    app.component(`Icon`, Icon);
    app.directive(`tooltip`, vTooltip);
};
