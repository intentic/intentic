import type { IntenticApi } from "@intentic/extension-api";
import { t } from "@intentic/ui/i18n";
import type { RouteLocationNormalizedLoaded } from "vue-router";
import { type LaunchEffects, launchAgent } from "../models/fleet/launches/agentLaunches";
import { useNotifications } from "../workbench/notifications/notifications";
import { navigation } from "../workbench/navigation/navigation";
import { registeredViews } from "../workbench/views/registry";
import { here, isPage, page } from "../lib/routes/links";

// `api.chat.launchAgent`'s hold on the app (models/fleet/launches/agentLaunches.ts): the router it opens the board with and reads
// the reader's place from, and the notification lane a refusal goes to once the reader has left the board.

// What the place a press was made is called: the extension view's own label (only an extension calls launchAgent), else
// nothing, and the refused card says a bare "Back".
const placeName = (route: RouteLocationNormalizedLoaded): string | undefined => {
    if (!isPage(route, `extension`)) {
        return undefined;
    }
    const ext = [route.params[`ext`]].flat()[0];
    return registeredViews().find(({ registration }) => registration.id === ext)?.registration.label;
};

const boardLaunchEffects = (): LaunchEffects => ({
    here: () => {
        const route = navigation().currentRoute.value;
        return isPage(route, `agents`) ? undefined : { path: route.fullPath, label: placeName(route) };
    },
    openBoard: () => {
        if (!isPage(navigation().currentRoute.value, `agents`)) {
            void navigation().push(here(page.agents()));
        }
    },
    onBoard: () => isPage(navigation().currentRoute.value, `agents`),
    // The board's own handoff (cardSelection.ts): it waits for the card, rings it and opens its chat.
    focus: (conversationId) => {
        const route = navigation().currentRoute.value;
        void navigation().replace({ path: route.path, query: { ...route.query, focus: conversationId } });
    },
    refused: (title, message) => {
        useNotifications().report({ tone: `problem`, title: t(`agents.launchCard.didNotStart`, { title }), detail: message });
    },
});

/** The host's `api.chat.launchAgent`: the board opens at the press with a card standing in for the agent. */
export const hostLaunchAgent: IntenticApi[`chat`][`launchAgent`] = (card, start) => launchAgent(card, start, boardLaunchEffects());
