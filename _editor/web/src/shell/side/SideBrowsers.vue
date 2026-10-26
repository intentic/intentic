<script setup lang="ts">
import { Button, EmptyState } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, useTemplateRef, watch } from "vue";
import { useRoute } from "vue-router";
import { useBrowsersQuery } from "../../features/browsers/browsersQuery";
import { useBrowsersFloating } from "../../workbench/browsers/browsersFloating";
import { tabKey } from "../../workbench/browsers/browsersPaths";
import {
    BROWSERS_SIDE_VIEW,
    browsersFront,
    browsersSideInput,
    browsersTabOfInput,
    markBrowsersOpened,
    showTab,
} from "../../workbench/browsers/browsersSurface";
import type { LineJump } from "../../models/workspace/tabs/workspaceTabs";
import { publishSlot, sideBrowsersSlot } from "../../workbench/window/panelSlots";
import { closeTabs, openBeside, sideTabId, tabsOfView, type SideInput } from "../../workbench/side/sideTabs";
import { shownSideActive, shownSideTabs } from "../../workbench/side/sideViews";

// Browsers beside the section: the one body every Browsers side tab shares (a `shared` side view). It publishes the view's
// side slot and the one Browsers view a window has moves in (PoppablePanels.vue), drawn there without a strip of its own:
// each of its tabs (the running app, a web window, the desktop) is a side tab, so the panel's strip is the only one. This
// keeps the two in step: the side tab on screen is the tab in front, and a tab the view puts in front by itself (a new
// tab, an app it picked) gets a side tab of its own. The /browsers section outranks this slot, and a window of its own
// takes the view from both.

// The side panel's contract for every body: the input of whichever Browsers tab is on screen.
const { input } = defineProps<{ input: SideInput; jump?: LineJump }>();

const t = useT();
const { floats, dock } = useBrowsersFloating();

// Standing here is what makes the view exist at all, as on /browsers: a tab restored after a reload has no control that
// marked it.
markBrowsersOpened();

const slot = useTemplateRef(`slot`);
publishSlot(sideBrowsersSlot, () => slot.value);

// Whether one of the view's side tabs is the one on screen, with the view in it rather than in a window of its own or on
// its way to /browsers, whose section takes it once mounted: by then the route has already put its own tab in front.
const route = useRoute();
const shown = computed(
    () =>
        !floats.value &&
        route.name !== `browsers` &&
        shownSideTabs.value.find((tab) => tab.id === shownSideActive.value)?.view === BROWSERS_SIDE_VIEW,
);
const sideKey = computed(() => tabKey(browsersTabOfInput(input)));
const frontKey = computed(() => tabKey(browsersFront.value));

// A side tab picked (or come back to) puts its tab in front; the view putting another in front opens that one's side tab,
// in place of the web as it stands, which is a new tab's page until something is opened from it. The first look adopts
// the tab in front for a side tab that names none, which is what the panel's one Browsers tab was before each tab was
// its own.
const replaceUnnamed = (key: string): void => {
    openBeside(BROWSERS_SIDE_VIEW, browsersSideInput(browsersFront.value), { keep: true });
    if (key === ``) {
        closeTabs(new Set([sideTabId(BROWSERS_SIDE_VIEW, {})]));
    }
};
let looked = false;
watch(
    [shown, sideKey, frontKey],
    ([on, key, front], before) => {
        if (!on) {
            return;
        }
        const first = !looked;
        looked = true;
        if (first && key === `` && front !== ``) {
            replaceUnnamed(key);
            return;
        }
        // The first run's `before` is empty.
        const [wasOn, keyBefore] = before;
        if (wasOn !== true || key !== keyBefore) {
            showTab(browsersTabOfInput(input));
            return;
        }
        if (front !== key) {
            replaceUnnamed(key);
        }
    },
    { immediate: true },
);

// A web window that closed takes its side tab with it, as closing a browser's window takes its tabs: one seen open
// since this body mounted, or, at the daemon's first answer, one a tab restored after a reload names that is open no more.
// A window just opened may not be listed yet, so it is never closed for being missing before it was seen.
const { sessions, listed } = useBrowsersQuery();
const seen = new Set<string>();
let answered = false;
watch(
    [sessions, listed],
    ([list, ready]) => {
        if (!ready) {
            return;
        }
        const open = new Set(list.filter((session) => session.running).map((session) => session.name));
        const firstAnswer = !answered;
        answered = true;
        const gone = tabsOfView(BROWSERS_SIDE_VIEW).filter((tab) => {
            const live = browsersTabOfInput(tab.input);
            return live.kind === `web` && live.session !== undefined && !open.has(live.session) && (firstAnswer || seen.has(live.session));
        });
        for (const name of open) {
            seen.add(name);
        }
        if (gone.length > 0) {
            closeTabs(new Set(gone.map((tab) => tab.id)));
        }
    },
    { immediate: true },
);
</script>

<template>
    <div class="relative flex min-h-0 flex-1 flex-col">
        <!-- Published even while another window holds the view, so "Bring it back here" lands it in this tab. -->
        <div ref="slot" class="contents"></div>
        <EmptyState v-if="floats" icon="external-link" :title="t(`browsers.area.inOwnWindow`)" class="absolute inset-0 p-6">
            <template #actions>
                <Button tier="accent" size="small" @click="dock()"> <Icon name="sign-in" />{{ t(`browsers.area.bringBackHere`) }} </Button>
            </template>
        </EmptyState>
    </div>
</template>
