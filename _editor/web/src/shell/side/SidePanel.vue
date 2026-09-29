<script setup lang="ts">
import type { Disposable } from "@intentic/extension-api";
import { ContextMenu, ResizeSeam, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import type { MenuItem } from "primevue/menuitem";
import { type Component, computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, useId, useTemplateRef } from "vue";
import { chatInSidePanel } from "../../features/chat/panel/chatPanelLayout";
import { SIDE_PANEL } from "../commands/categories";
import { type CommandRegistration, registerCommand } from "../commands/useCommands";
import { chatSlot } from "../window/panelSlots";
import { toAppPx, toScreenPx, uiLength } from "../window/uiScale";
import {
    DEFAULT_SIDE_SPLIT,
    defaultChatWidth,
    defaultFloatingSideWidth,
    maxChatWidth,
    maxFloatingSideWidth,
    MIN_CHAT_WIDTH,
    useLayout,
} from "../window/useLayout";
import { closeAllTabs, closeOtherTabs, closeTab, cycleTab, keepTab, activateTab, type SideTab, toggleCollapsed, useSidePanel } from "./sideTabs";
import { describeTab, homeOf, shownSideActive, shownSideTabs, type SideViewEntry, type SideViewLabel, sideViewOf } from "./sideViews";
import SideStrip, { type SideStripItem } from "./SideStrip.vue";
import SideUnavailable from "./SideUnavailable.vue";

// THE SHELL'S RIGHT-HAND COLUMN: what the reader opened beside the section the rail put in the main area, over the chat
// when the chat's home is the side. Peeks stack above the chat rather than hiding it behind a tab, so the chat that
// linked to a file, or the preview it is changing, stays in reach while you look. The column's width is the one the chat
// column always had (`ui-chat-width`), so nobody's width moved when the chat became one of the panel's two parts.

// `floating`: drawn in a popped-out chat's window, beside the chat rather than over it, at that window's own width.
const { floating = false } = defineProps<{ floating?: boolean }>();

const t = useT();
const layout = useLayout();
const panel = useSidePanel();
const uid = useId();

// Heights in app pixels: the least a peek can be read at, and the least the chat needs for its bar and composer.
const MIN_PEEK_PX = 160;
const MIN_CHAT_PX = 240;

const tabsOnScreen = computed(() => shownSideTabs.value.length > 0);
// The chat under the tabs splits the column; alone, the tabs take all of it.
const stacked = computed(() => tabsOnScreen.value && chatInSidePanel.value);
const folded = computed(() => stacked.value && panel.collapsed.value);

// The column's own element; the split's seam measures against its height.
const root = useTemplateRef<HTMLElement>(`root`);
const height = ref(0);
let observer: ResizeObserver | undefined;
onMounted(() => {
    // A component-test DOM has no observer; nothing measures there, and the split draws from its fraction alone.
    if (root.value === null || !(`ResizeObserver` in globalThis)) {
        return;
    }
    observer = new ResizeObserver(([entry]) => {
        height.value = entry?.contentRect.height ?? height.value;
    });
    observer.observe(root.value);
});
onBeforeUnmount(() => observer?.disconnect());

// The seams speak pointer pixels; what is stored is app pixels for the width and a fraction for the split.
const widthSeam = computed<number>({
    get: () => toScreenPx(floating ? layout.floatingSideWidth.value : layout.chatWidth.value),
    set: (px) => (floating ? layout.setFloatingSideWidth(toAppPx(px)) : layout.setChatWidth(toAppPx(px))),
});
const splitSeam = computed<number>({
    get: () => Math.round(layout.sideSplit.value * height.value),
    set: (px) => {
        if (height.value > 0) {
            layout.setSideSplit(px / height.value);
        }
    },
});
// Drawn from the fraction in CSS rather than the measured height, so the first paint is already the right split.
const tabsStyle = computed(() =>
    stacked.value && !folded.value
        ? { height: `${layout.sideSplit.value * 100}%`, minHeight: uiLength(MIN_PEEK_PX), maxHeight: `calc(100% - ${uiLength(MIN_CHAT_PX)})` }
        : undefined,
);

// One element id per tab for as long as the panel lives, since a tab's own id is JSON and no fit for an attribute.
const domIds = new Map<string, string>();
const domIdOf = (id: string): string => {
    const known = domIds.get(id);
    if (known !== undefined) {
        return known;
    }
    const minted = `${uid}-tab-${domIds.size}`;
    domIds.set(id, minted);
    return minted;
};

// One async component per side view, kept for the panel's life, so switching tabs never reloads a body.
const bodies = new WeakMap<SideViewEntry, Component>();
const bodyOf = (tab: SideTab): Component => {
    const entry = sideViewOf(tab.view);
    if (entry === undefined) {
        return SideUnavailable;
    }
    const known = bodies.get(entry);
    if (known !== undefined) {
        return known;
    }
    const body = defineAsyncComponent(entry.component);
    bodies.set(entry, body);
    return body;
};

// A tab whose side view is not registered still draws, under the only name it has left: the view's own id.
const labelOf = (tab: SideTab): SideViewLabel => describeTab(tab) ?? { title: tab.view.slice(tab.view.lastIndexOf(`/`) + 1), icon: `extensions` };
const items = computed<readonly SideStripItem[]>(() => shownSideTabs.value.map((tab) => ({ id: tab.id, label: labelOf(tab) })));
const activeTab = computed(() => shownSideTabs.value.find((tab) => tab.id === shownSideActive.value));
const activeHome = computed(() => (activeTab.value === undefined ? undefined : homeOf(activeTab.value)));

// "Open in …" moves the thing into the main area, so its tab has nothing left to show beside it.
const openHome = (tab: SideTab): void => {
    const home = homeOf(tab);
    if (home !== undefined) {
        home.open();
        closeTab(tab.id);
    }
};

// The tab's right-click: its own verbs, then the strip's.
const tabMenu = ref<{ show: (event: Event) => void }>();
const menuTab = ref<SideTab>();
const menuItems = computed<MenuItem[]>(() => {
    const tab = menuTab.value;
    if (tab === undefined) {
        return [];
    }
    const home = homeOf(tab);
    const own: MenuItem[] = [
        ...(tab.id === panel.peek.value ? [{ label: t(`ui.action.keepOpen`), command: (): void => keepTab(tab.id) }] : []),
        ...(home === undefined ? [] : [{ label: t(`shell.sidePanel.openIn`, { section: home.label }), command: (): void => openHome(tab) }]),
    ];
    return [
        ...own,
        ...(own.length > 0 ? [{ separator: true }] : []),
        { label: t(`ui.action.close`), command: (): void => closeTab(tab.id) },
        { label: t(`shell.sidePanel.closeOthers`), disabled: shownSideTabs.value.length < 2, command: (): void => closeOtherTabs(tab.id) },
        { label: t(`shell.sidePanel.closeAll`), command: closeAllTabs },
    ];
});
const onTabMenu = (id: string, event: MouseEvent): void => {
    menuTab.value = shownSideTabs.value.find((tab) => tab.id === id);
    tabMenu.value?.show(event);
};

let commandDisposables: readonly Disposable[] = [];
onMounted(() => {
    const acting = (act: (tab: SideTab) => void) => (): void => {
        if (activeTab.value !== undefined) {
            act(activeTab.value);
        }
    };
    const entries: Omit<CommandRegistration, `owner` | `category`>[] = [
        {
            command: `side.nextTab`,
            title: t(`ui.action.next`),
            keybinding: `Alt+PageDown`,
            when: `tabSurface == 'side'`,
            handler: () => cycleTab(1, shownSideTabs.value),
        },
        {
            command: `side.previousTab`,
            title: t(`shell.sidePanel.previous`),
            keybinding: `Alt+PageUp`,
            when: `tabSurface == 'side'`,
            handler: () => cycleTab(-1, shownSideTabs.value),
        },
        {
            command: `side.closeTab`,
            title: t(`ui.action.close`),
            icon: `times`,
            keybinding: `Ctrl+Shift+X`,
            when: `tabSurface == 'side'`,
            handler: acting((tab) => closeTab(tab.id)),
        },
        {
            command: `side.closeOtherTabs`,
            title: t(`shell.sidePanel.closeOthers`),
            icon: `times`,
            keybinding: `Ctrl+Shift+,`,
            when: `tabSurface == 'side'`,
            handler: acting((tab) => closeOtherTabs(tab.id)),
        },
        {
            command: `side.closeAllTabs`,
            title: t(`shell.sidePanel.closeAll`),
            icon: `times`,
            keybinding: `Ctrl+Shift+Backspace`,
            when: `tabSurface == 'side'`,
            handler: closeAllTabs,
        },
        { command: `side.keepTab`, title: t(`ui.action.keepOpen`), icon: `pin`, handler: acting((tab) => keepTab(tab.id)) },
        { command: `side.openInSection`, title: t(`shell.sidePanel.openInSection`), icon: `expand`, handler: acting(openHome) },
        { command: `side.toggleFold`, title: t(`shell.sidePanel.fold`), icon: `chevron-up`, handler: toggleCollapsed },
    ];
    commandDisposables = entries.map((entry) => registerCommand({ owner: `builtin`, category: SIDE_PANEL, ...entry }));
});
onBeforeUnmount(() => {
    for (const disposable of commandDisposables) {
        disposable.dispose();
    }
    commandDisposables = [];
});
</script>

<template>
    <aside ref="root" class="side-panel relative flex min-h-0 min-w-0 flex-col border-l border-line bg-card" style="grid-area: side">
        <!-- The column's width, dragged from its left edge; an overlay seam, since the panel's own axis is the vertical stack. -->
        <ResizeSeam
            v-model="widthSeam"
            place="edge"
            pane="after"
            :min="toScreenPx(MIN_CHAT_WIDTH)"
            :max="toScreenPx(floating ? maxFloatingSideWidth() : maxChatWidth())"
            :reset="toScreenPx(floating ? defaultFloatingSideWidth() : defaultChatWidth())"
            :title="t(`ui.resizeSeam.doubleClickResets`)"
        />

        <!-- What was opened beside: the strip, then every tab's body stacked in one box, the one on screen visible. -->
        <section v-if="tabsOnScreen" class="side-tabs flex min-h-0 flex-col" :class="stacked ? `` : `flex-1`" :style="tabsStyle" :aria-label="t(`shell.sidePanel.tabs`)">
            <!-- `.view-header`, so the desktop app's window buttons take their corner from this bar when it reaches it. -->
            <div class="view-header flex items-stretch border-b border-line bg-card">
                <SideStrip
                    :tabs="items"
                    :active="shownSideActive"
                    :peek="panel.peek.value"
                    :dom-id="domIdOf"
                    @select="activateTab"
                    @keep="keepTab"
                    @close="closeTab"
                    @contextmenu="onTabMenu"
                />
                <div class="flex shrink-0 items-center gap-0.5 px-1">
                    <button
                        v-if="activeTab !== undefined && activeTab.id === panel.peek.value"
                        type="button"
                        :class="ui.iconButton(`h-7 w-7 rounded`)"
                        :aria-label="t(`ui.action.keepOpen`)"
                        v-tooltip.bottom="{ title: t(`ui.action.keepOpen`), note: t(`shell.sidePanel.doubleClickToKeep`) }"
                        @click="keepTab(activeTab.id)"
                    >
                        <Icon name="pin" class="text-xs" />
                    </button>
                    <button
                        v-if="activeTab !== undefined && activeHome !== undefined"
                        type="button"
                        :class="ui.iconButton(`h-7 w-7 rounded`)"
                        :aria-label="t(`shell.sidePanel.openIn`, { section: activeHome.label })"
                        v-tooltip.bottom="t(`shell.sidePanel.openIn`, { section: activeHome.label })"
                        @click="openHome(activeTab)"
                    >
                        <Icon name="expand" class="text-xs" />
                    </button>
                    <button
                        v-if="stacked"
                        type="button"
                        :class="ui.iconButton(`h-7 w-7 rounded`)"
                        :aria-label="folded ? t(`shell.sidePanel.unfold`) : t(`shell.sidePanel.fold`)"
                        :aria-expanded="!folded"
                        v-tooltip.bottom="folded ? t(`shell.sidePanel.unfold`) : { title: t(`shell.sidePanel.fold`), note: t(`shell.sidePanel.foldNote`) }"
                        @click="toggleCollapsed()"
                    >
                        <Icon :name="folded ? `chevron-down` : `chevron-up`" class="text-xs" />
                    </button>
                </div>
            </div>
            <!-- Every body stays mounted and in place: a hidden preview is never detached (which would reload the app) and a
                 file keeps where it was scrolled to. Hidden ones are invisible and inert, so nothing in them takes focus.
                 `inert` is bound to undefined, not false, on the one shown: Vue writes a false one as `inert="false"`, and
                 the attribute's presence alone makes a subtree inert. -->
            <div v-show="!folded" class="relative min-h-0 flex-1 bg-canvas">
                <div
                    v-for="tab in panel.tabs.value"
                    :key="tab.id"
                    :id="`${domIdOf(tab.id)}-body`"
                    role="tabpanel"
                    :aria-labelledby="domIdOf(tab.id)"
                    class="absolute inset-0 flex min-h-0 flex-col"
                    :class="tab.id === shownSideActive ? `` : `invisible`"
                    :inert="tab.id === shownSideActive ? undefined : true"
                >
                    <component :is="bodyOf(tab)" :input="tab.input" :jump="panel.jumps.value[tab.id]" />
                </div>
            </div>
        </section>

        <!-- Between the tabs and the chat, dragging the share of the height the tabs take; double-click puts it back. -->
        <ResizeSeam
            v-if="stacked && !folded"
            v-model="splitSeam"
            axis="y"
            pane="before"
            :min="toScreenPx(MIN_PEEK_PX)"
            :max="Math.max(toScreenPx(MIN_PEEK_PX), height - toScreenPx(MIN_CHAT_PX))"
            :reset="Math.round(DEFAULT_SIDE_SPLIT * height)"
            :title="t(`ui.resizeSeam.doubleClickResets`)"
        />

        <!-- The chat's slot, the same element for as long as the chat lives here: tabs coming and going above it never move
             the chat, so its transcript keeps its place. -->
        <section v-if="chatInSidePanel" class="side-chat flex min-h-0 flex-1 flex-col" :class="tabsOnScreen ? `border-t border-line` : ``">
            <div ref="chatSlot" class="contents"></div>
        </section>

        <ContextMenu ref="tabMenu" :model="menuItems" :min-width="12" />
    </aside>
</template>
