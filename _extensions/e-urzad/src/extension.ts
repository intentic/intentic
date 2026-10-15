import type { ExtensionContext, IntenticApi } from "@intentic/extension-api";
import { bindHost } from "./host.js";
import { t } from "./i18n.js";
import { officeCards } from "./view/facts.js";

// intentic.e-urzad in the browser: one rail tile per connected office card (EZD RP or e-Doręczenia), keyed by the
// card's id so two offices are two tiles. No card, no tile: the extension is inert until an office connects one.
export const activate = (api: IntenticApi, context: ExtensionContext): void => {
    bindHost(api);
    context.subscriptions.push(
        api.views.register({
            id: `e-urzad`,
            label: t(`title`),
            surface: `rail`,
            detect: (_repos, capabilities) =>
                officeCards(capabilities).map((card) => ({
                    key: card.id,
                    title: `${card.service === `ezd-rp` ? `EZD RP` : `e-Doręczenia`} · ${card.id}`,
                    icon: card.service === `ezd-rp` ? `folder-open` : `envelope`,
                    props: { account: card.id, service: card.service },
                })),
            view: async () => (await import(`./view/OfficeView.vue`)).default,
        }),
    );
};
