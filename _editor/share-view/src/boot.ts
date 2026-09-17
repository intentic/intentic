import Icon from "@intentic/ui/icon";
import { installI18n } from "@intentic/ui/i18n";
import { vTooltip } from "@intentic/ui/src/lib/tooltip.js";
import type { App } from "vue";

// Registers only `<Icon>` and `v-tooltip`, not `installUi` (which also pulls PrimeVue) — this page renders no
// PrimeVue component. Icon draws its own SVG paths and needs no collection registration or network request.
export const installShareUi = (app: App): void => {
    app.component(`Icon`, Icon);
    app.directive(`tooltip`, vTooltip);
    // Named here rather than inherited from `installUi`, which this page deliberately does not call. The chat
    // components it compiles in are the app's own, and they translate their own labels.
    installI18n(app);
};
