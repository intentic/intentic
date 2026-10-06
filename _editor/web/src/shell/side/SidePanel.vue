<script setup lang="ts">
import type { Disposable } from "@intentic/extension-api";
import { ContextMenu, ResizeSeam, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import type { MenuItem } from "primevue/menuitem";
import { type Component, computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, useId } from "vue";
import { chatInSidePanel } from "../../features/chat/panel/chatPanelLayout";
import { SIDE_PANEL } from "../../workbench/commands/categories";
import { type CommandRegistration, registerCommand } from "../../workbench/commands/useCommands";
import { chatSlot } from "../../workbench/window/panelSlots";
import { toAppPx, toScreenPx, uiLength } from "../../workbench/window/uiScale";
import {
    defaultBesideWidth,
    defaultChatWidth,
    defaultFloatingSideWidth,
    maxChatWidth,
    maxFloatingSideWidth,
    MIN_CHAT_WIDTH,
    MIN_PANE_PX,
    roomBesideChat,
    useLayout,
} from "../../workbench/window/useLayout";
import { besideChat, besideFills } from "./sideLayout";
import { closeAllTabs, closeOtherTabs, closeTab, cycleTab, keepTab, activateTab, setSplit, type SideTab, useSidePanel } from "../../workbench/side/sideTabs";
import { describeTab, homeOf, shownSideActive, shownSideTabs, type SideViewEntry, type SideViewLabel, sideViewOf } from "../../workbench/side/sideViews";
import SideStrip, { type SideStripItem } from "./SideStrip.vue";
import SideUnavailable from "./SideUnavailable.vue";

// THE SHELL'S RIGHT-HAND COLUMN: what the reader opened beside the section the rail put in the main area, and the chat
// when the chat's home is the side. With both, they stand side by side, each the full height, the chat in the width it
// always had (`ui-chat-width`) and what was opened taking the whole middle over the section (sideLayout.ts), or, split,
// a column of its own (`ui-side-beside-width`) with the section beside it. Never stacked over the chat in its column: a
// preview became a phone-sized box there, code wrapped on every line, and the chat lost the room its transcript reads in.

// `floating`: drawn in a popped-out chat's window, beside the chat rather than over it, at that window's own width.
const { floating = false } = defineProps<{ floating?: boolean }>();

const t = useT();
const layout = useLayout();
const panel = useSidePanel();
const uid = useId();

const tabsOnScreen = computed(() => shownSideTabs.value.length > 0);
// The chat beside the tabs: two columns, the tabs filling the middle or, split, their own width. Alone, either takes the
// whole panel.
const beside = computed(() => !floating && besideChat.value);
const fills = computed(() => !floating && besideFills.value);

// The seams speak pointer pixels; what is stored is app pixels. The panel's left edge sizes whatever stands there: the
// beside column when there is one, else the one column the panel is (the chat's, or a popped-out window's own). Beside the
// chat it runs from one section-pane's width to all of the middle: drawn into the section's floor, it snaps to filling.
const besideEdge = (px: number): void => {
    const room = roomBesideChat();
    if (px > room - MIN_PANE_PX / 2) {
        // The drag here passed through the widest split, which would leave the section at its floor next time.
        layout.setBesideWidth(defaultBesideWidth());
        setSplit(false);
        return;
    }
    layout.setBesideWidth(px);
    setSplit(true);
};
const edgeSeam = computed<number>({
    get: () =>
        toScreenPx(
            beside.value
                ? fills.value
                    ? roomBesideChat()
                    : layout.besideWidth.value
                : floating
                  ? layout.floatingSideWidth.value
                  : layout.chatWidth.value,
        ),
    set: (px) =>
        beside.value
            ? besideEdge(toAppPx(px))
            : floating
              ? layout.setFloatingSideWidth(toAppPx(px))
              : layout.setChatWidth(toAppPx(px)),
});
const edgeBounds = computed(() =>
    beside.value
        ? { min: MIN_PANE_PX, max: roomBesideChat(), reset: roomBesideChat() }
        : floating
          ? { min: MIN_CHAT_WIDTH, max: maxFloatingSideWidth(), reset: defaultFloatingSideWidth() }
          : { min: MIN_CHAT_WIDTH, max: maxChatWidth(), reset: defaultChatWidth() },
);
// Between the two columns. Filling, what was opened takes whatever the chat leaves; split, the seam trades width between
// the two, so the section in the main area never moves under it. Either way what was opened keeps one pane's width.
const chatSeam = computed<number>({
    get: () => toScreenPx(layout.chatWidth.value),
    set: (px) => {
        const before = layout.chatWidth.value;
        layout.setChatWidth(toAppPx(px));
        if (!fills.value) {
            layout.setBesideWidth(layout.besideWidth.value - (layout.chatWidth.value - before));
        }
    },
});
const chatSeamMax = computed(() =>
    Math.max(MIN_CHAT_WIDTH, layout.chatWidth.value + (fills.value ? roomBesideChat() : layout.besideWidth.value) - MIN_PANE_PX),
);
// Split, both shrink with a window too narrow for their sum, the chat in proportion to its width but never under its
// floor, so its composer keeps its controls; what was opened gives way first. Filling, the chat holds its width.
const tabsStyle = computed(() => (beside.value && !fills.value ? { flex: `0 1 ${uiLength(layout.besideWidth.value)}` } : undefined));
const chatStyle = computed(() =>
    beside.value
        ? fills.value
            ? { flex: `0 0 ${uiLength(layout.chatWidth.value)}` }
            : { flex: `1 1 ${uiLength(layout.chatWidth.value)}`, minWidth: uiLength(MIN_CHAT_WIDTH) }
        : undefined,
);
// Filling, the panel spans the main area's cell as well as its own; the section stays mounted under it (ShellDesktop).
const panelStyle = computed(() => (fills.value ? { gridRow: `1`, gridColumn: `workspace-start / side-end` } : { gridArea: `side` }));

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
        {
            command: `side.toggleSplit`,
            title: t(`shell.sidePanel.toggleSplit`),
            icon: `split-columns`,
            when: `tabSurface == 'side'`,
            handler: () => setSplit(fills.value),
        },
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
    <!-- `flex-row`: with the chat here too, the two stand side by side rather than one over the other. -->
    <aside class="side-panel relative flex min-h-0 min-w-0 border-l border-line bg-card" :class="{ 'side-fills': fills }" :style="panelStyle">
        <!-- What was opened beside: the strip, then every tab's body stacked in one box, the one on screen visible. -->
        <section
            v-if="tabsOnScreen"
            class="side-tabs relative flex min-h-0 min-w-0 flex-col"
            :class="beside && !fills ? `` : `flex-1`"
            :style="tabsStyle"
            :aria-label="t(`shell.sidePanel.tabs`)"
        >
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
                    <!-- The section the rail picked, back beside what was opened, or what was opened over all of the middle. -->
                    <button
                        v-if="beside"
                        type="button"
                        :class="ui.iconButton(`h-7 w-7 rounded`)"
                        :aria-label="t(`shell.sidePanel.showSection`)"
                        :aria-pressed="!fills"
                        v-tooltip.bottom="fills ? t(`shell.sidePanel.showSection`) : t(`shell.sidePanel.fillMiddle`)"
                        @click="setSplit(fills)"
                    >
                        <Icon name="split-columns" class="text-xs" />
                    </button>
                    <button
                        v-if="activeTab !== undefined && activeHome !== undefined"
                        type="button"
                        :class="ui.iconButton(`h-7 w-7 rounded`)"
                        :aria-label="t(`shell.sidePanel.openIn`, { section: activeHome.label })"
                        v-tooltip.bottom="{ title: t(`shell.sidePanel.openIn`, { section: activeHome.label }) }"
                        @click="openHome(activeTab)"
                    >
                        <Icon name="expand" class="text-xs" />
                    </button>
                </div>
            </div>
            <!-- Every body stays mounted and in place: a hidden preview is never detached (which would reload the app) and a
                 file keeps where it was scrolled to. Hidden ones are invisible and inert, so nothing in them takes focus.
                 `inert` is bound to undefined, not false, on the one shown: Vue writes a false one as `inert="false"`, and
                 the attribute's presence alone makes a subtree inert. -->
            <div class="relative min-h-0 flex-1 bg-canvas">
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

        <!-- The chat's slot, the same element for as long as the chat lives here: tabs coming and going beside it never
             move the chat, so its transcript keeps its place. -->
        <section
            v-if="chatInSidePanel"
            class="side-chat relative flex min-h-0 min-w-0 flex-col"
            :class="beside ? `border-l border-line` : `flex-1`"
            :style="chatStyle"
        >
            <div ref="chatSlot" class="contents"></div>
            <!-- Between the two columns: the chat's width, traded with the column beside it. -->
            <ResizeSeam
                v-if="beside"
                v-model="chatSeam"
                place="edge"
                pane="after"
                :min="toScreenPx(MIN_CHAT_WIDTH)"
                :max="toScreenPx(chatSeamMax)"
                :reset="toScreenPx(defaultChatWidth())"
                :title="t(`ui.resizeSeam.doubleClickResets`)"
            />
        </section>

        <!-- The panel's left edge, sizing the column that stands there. Last, so it draws over either column's bar. -->
        <ResizeSeam
            v-model="edgeSeam"
            place="edge"
            pane="after"
            :min="toScreenPx(edgeBounds.min)"
            :max="toScreenPx(edgeBounds.max)"
            :reset="toScreenPx(edgeBounds.reset)"
            :title="t(`ui.resizeSeam.doubleClickResets`)"
        />

        <ContextMenu ref="tabMenu" :model="menuItems" :min-width="12" />
    </aside>
</template>
