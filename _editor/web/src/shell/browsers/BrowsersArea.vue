<!-- The /browsers route: the Browsers view's full-area home, and the address of the tab in front. On a desktop shell the
     view itself lives above the router (PoppablePanels.vue) and this lends it a slot, so a move here from the side panel
     or back from its own window keeps every app's state; a phone mounts no poppable panels, so the view is drawn right
     here. Either way the URL and the tab in front follow each other: a link to /browsers/<tab> brings that tab to front,
     and picking another tab rewrites the URL, so a reload reopens it. -->
<script setup lang="ts">
import { Button, EmptyState, useDevice } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { useTemplateRef, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { browsersFront, markBrowsersOpened, requestDefaultPreview, showTab } from "../../workbench/browsers/browsersSurface";
import { browsersPath, parseTabKey, tabKey } from "../../workbench/browsers/browsersPaths";
import { useBrowsersFloating } from "../../workbench/browsers/browsersFloating";
import LiveBrowser from "./LiveBrowser.vue";
import { browsersSlot, publishSlot } from "../../workbench/window/panelSlots";
import { floatingWindowPanel } from "../../workbench/window/floating";

const t = useT();
const route = useRoute();
const router = useRouter();
const { mobile } = useDevice();
const { floats, dock } = useBrowsersFloating();

// Standing here is what makes the view exist at all: a bookmark or a typed /browsers arrives without any control having
// marked it, and a slot nothing mounts into would be a blank page.
markBrowsersOpened();

// The shell has no poppable panels on a phone (WorkspaceRuntime.vue), so the view is this route's own there.
const inline = (): boolean => mobile.value && floatingWindowPanel.value === undefined;

const routeKey = (): string => {
    const raw = route.params[`tab`];
    return typeof raw === `string` ? raw : Array.isArray(raw) ? raw.join(`/`) : ``;
};

// Arriving: a named tab comes to front; a bare /browsers keeps whatever was in front and says so in the URL; `?preview`
// (the old /preview address, the palette) asks the view for the app most worth seeing.
watch(
    () => [routeKey(), route.query[`preview`] !== undefined] as const,
    ([key, wantsPreview]) => {
        if (wantsPreview) {
            requestDefaultPreview();
            void router.replace(browsersPath(browsersFront.value));
            return;
        }
        if (key !== ``) {
            showTab(parseTabKey(key));
        } else if (tabKey(browsersFront.value) !== ``) {
            void router.replace(browsersPath(browsersFront.value));
        }
    },
    { immediate: true },
);

// Picking a tab rewrites the address in place: a tab is a look, not a step the back button should walk through.
watch(browsersFront, (tab) => {
    if (route.name === `browsers` && tabKey(tab) !== routeKey()) {
        void router.replace(browsersPath(tab));
    }
});

const slot = useTemplateRef(`slot`);
publishSlot(browsersSlot, () => slot.value);
</script>

<template>
    <LiveBrowser v-if="inline()" />
    <div v-else class="relative h-full w-full">
        <!-- Published even while another window holds the view, so "Bring it back here" lands it in this slot the instant the window goes. -->
        <div ref="slot" class="contents"></div>
        <EmptyState
            v-if="floats"
            icon="external-link"
            :title="t(`browsers.area.inOwnWindow`)"
            :line="t(`browsers.area.bringBackToFill`)"
            size="page"
            class="absolute inset-0 p-6"
        >
            <template #actions>
                <Button size="small" @click="dock()"> <Icon name="sign-in" />{{ t(`browsers.area.bringBackHere`) }} </Button>
            </template>
        </EmptyState>
    </div>
</template>
