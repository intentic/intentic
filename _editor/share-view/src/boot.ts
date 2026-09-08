import { addCollection } from "@iconify/vue";
import Icon from "@intentic/ui/icon";
import { BUNDLED_ICONS } from "@intentic/ui/src/icons/iconData.generated.js";
import { vTooltip } from "@intentic/ui/src/lib/tooltip.js";
import type { App } from "vue";

// Registers only `<Icon>` and `v-tooltip`, not `installUi` (which also pulls PrimeVue) — this page renders no
// PrimeVue component, so that bundle weight has no reason to ship. Icon collections are bundled, never fetched,
// since a shared link is opened by a stranger to this sandbox.
export const installShareUi = (app: App): void => {
    BUNDLED_ICONS.forEach((collection) => addCollection(collection));
    app.component(`Icon`, Icon);
    app.directive(`tooltip`, vTooltip);
};
