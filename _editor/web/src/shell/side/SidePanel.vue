<script setup lang="ts">
import type { Disposable } from "@intentic/extension-api";
import { ContextMenu, FreshnessFrame, ResizeSeam, ui } from "@intentic/ui";
import { loadChunk } from "@intentic/ui/chunk";
import { useT } from "@intentic/ui/i18n";
import type { MenuItem } from "primevue/menuitem";
import { type Component, computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from "vue";
import { useSandboxLiveness } from "../../client/sandbox/freshness/queryFreshness";
import { chatInSidePanel, chatTucked, setChatTucked, showChat } from "../../models/conversations/panel/chatPanelLayout";
import { composerFocus, focusComposer } from "../../models/conversations/tabs/useChat-tabs";
import { registerBuiltin } from "../../workbench/commands/builtinCommands";
import { fileTabMenu, type TabStripActions, tabStripMenu } from "../../workbench/commands/tabMenu";
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
import { besideChat, besideFills, sideTucked, TUCK_BELOW_PX, TUCKED_STRIP_PX } from "./sideLayout";
import { FILE_SIDE_VIEW, FileSideInputSchema } from "../../workbench/side/sideFileInput";
import {
    activateTab,
    closeAllTabs,
    closeOtherTabs,
    closeTab,
    closeTabs,
    closeTabsByReader,
    cycleTab,
    keepTab,
    reopenClosedTab,
    revealTab,
    setSplit,
    setTucked,
    type SideTab,
    useSidePanel,
} from "../../workbench/side/sideTabs";
import { describeTab, homeOf, shownSideActive, shownSideTabs, type SideViewEntry, type SideViewLabel, sideViewOf } from "../../workbench/side/sideViews";
import ChatTucked from "./ChatTucked.vue";
import SideStrip, { type SideStripItem } from "./SideStrip.vue";
import SideTucked from "./SideTucked.vue";
import SideUnavailable from "./SideUnavailable.vue";

// THE SHELL'S RIGHT-HAND COLUMN: what the reader opened beside the section the rail put in the main area, and the chat,
// unless it is in a window of its own. With both, they stand side by side, each the full height, the chat in the width it
// always had (`ui-chat-width`) and what was opened taking the whole middle over the section (sideLayout.ts), or, split,
// a column of its own (`ui-side-beside-width`) with the section beside it. Never stacked over the chat in its column: a
// preview became a phone-sized box there, code wrapped on every line, and the chat lost the room its transcript reads in.

// `floating`: drawn in a popped-out chat's window, beside the chat rather than over it, at that window's own width.
const { floating = false } = defineProps<{ floating?: boolean }>();

const t = useT();
const layout = useLayout();
const panel = useSidePanel();
// The side panel's views draw cached answers too; each tab's frame says when they may be out of date.
const { offline, lostAt } = useSandboxLiveness();
const uid = useId();

const tabsOnScreen = computed(() => shownSideTabs.value.length > 0);
// The chat beside the tabs: two columns, the tabs filling the middle or, split, their own width. Alone, either takes the
// whole panel.
const beside = computed(() => !floating && besideChat.value);
const fills = computed(() => !floating && besideFills.value);
// Folded into a strip of icons at the panel's edge (sideLayout.ts). Never in a popped-out chat's window, which sizes the
// panel beside its chat by itself.
const tucked = computed(() => !floating && tabsOnScreen.value && sideTucked.value);
// The tabs with the panel to themselves, the chat living elsewhere: the column's width is the chat's preference.
const tabsAlone = computed(() => !floating && !beside.value && tabsOnScreen.value && !chatInSidePanel.value);
// The chat folded into its strip (ChatTucked.vue), mounted behind the panel's edge at its own width, as tucked tabs are.
const chatFolded = computed(() => !floating && chatInSidePanel.value && chatTucked.value);
// The chat with the panel to itself: the panel's edge is the chat's, and folds it the way the tabs' edge folds them.
const chatAlone = computed(() => !floating && !beside.value && !tabsAlone.value && chatInSidePanel.value);
// Anything asking for the caret (New agent, a shortcut) wants the chat on screen.
watch(composerFocus, () => {
    if (chatInSidePanel.value) {
        showChat();
    }
});

// The seams speak pointer pixels; what is stored is app pixels. The panel's left edge sizes whatever stands there: the
// beside column when there is one, else the one column the panel is (the chat's, or a popped-out window's own). Beside the
// chat it runs from one section-pane's width to all of the middle: drawn into the section's floor, it snaps to filling;
// drawn past half its own floor, it tucks away into its strip, and drawn back out of the strip, it comes back. Both
// happen under the pointer, so a drag that went too far undoes itself on the way back.
const besideEdge = (px: number): void => {
    if (px < TUCK_BELOW_PX) {
        setTucked(true);
        return;
    }
    setTucked(false);
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
// The tabs alone tuck the same way; their width is stored only for a column that stays.
const aloneEdge = (px: number): void => {
    if (px < TUCK_BELOW_PX) {
        setTucked(true);
        return;
    }
    setTucked(false);
    layout.setChatWidth(px);
};
// So does the chat alone, into its own strip; drawn back out of it, it comes back at the width the pointer let go at.
const chatEdge = (px: number): void => {
    if (px < TUCK_BELOW_PX) {
        setChatTucked(true);
        return;
    }
    setChatTucked(false);
    layout.setChatWidth(px);
};
const edgeSeam = computed<number>({
    get: () =>
        toScreenPx(
            tucked.value
                ? TUCKED_STRIP_PX
                : beside.value
                  ? fills.value
                      ? roomBesideChat()
                      : layout.besideWidth.value
                  : floating
                    ? layout.floatingSideWidth.value
                    : chatFolded.value
                      ? TUCKED_STRIP_PX
                      : layout.chatWidth.value,
        ),
    set: (px) =>
        beside.value
            ? besideEdge(toAppPx(px))
            : floating
              ? layout.setFloatingSideWidth(toAppPx(px))
              : tabsAlone.value
                ? aloneEdge(toAppPx(px))
                : chatEdge(toAppPx(px)),
});
// Alone in the panel, the chat's edge is drawn live while dragged (useLayout's previewChatWidth, which only the shell's
// grid reads) and stored once on release, so the drag moves the column and redraws nothing. Beside what was opened it
// trades two widths and may snap that column to filling the middle, so there it moves the stored widths as it goes.
// The tabs alone, or the chat alone, tuck while dragged too, drawing no width of their own meanwhile.
const previewEdge = (px: number | undefined): void => {
    if (px !== undefined && (tabsAlone.value || chatAlone.value)) {
        const fold = tabsAlone.value ? setTucked : setChatTucked;
        if (toAppPx(px) < TUCK_BELOW_PX) {
            fold(true);
            layout.previewChatWidth(undefined);
            return;
        }
        fold(false);
    }
    layout.previewChatWidth(px === undefined ? undefined : toAppPx(px));
};
const edgePreview = computed(() => (beside.value || floating ? undefined : previewEdge));
// Down to the strip's own width wherever there are tabs to tuck: the seam reports how far past the floor it was drawn.
const edgeBounds = computed(() =>
    beside.value
        ? { min: TUCKED_STRIP_PX, max: roomBesideChat(), reset: roomBesideChat() }
        : floating
          ? { min: MIN_CHAT_WIDTH, max: maxFloatingSideWidth(), reset: defaultFloatingSideWidth() }
          : { min: TUCKED_STRIP_PX, max: maxChatWidth(), reset: defaultChatWidth() },
);
// Between the two columns. Filling, what was opened takes whatever the chat leaves; split, the seam trades width between
// the two, so the section in the main area never moves under it. Either way what was opened keeps one pane's width.
// Drawn past half its floor, the chat folds into its strip here too.
const chatSeam = computed<number>({
    get: () => toScreenPx(layout.chatWidth.value),
    set: (px) => {
        if (toAppPx(px) < TUCK_BELOW_PX) {
            setChatTucked(true);
            return;
        }
        const before = layout.chatWidth.value;
        layout.setChatWidth(toAppPx(px));
        // Tucked, the chat trades width with the section beyond the strip, not with the hidden column.
        if (!fills.value && !tucked.value) {
            layout.setBesideWidth(layout.besideWidth.value - (layout.chatWidth.value - before));
        }
    },
});
const chatSeamMax = computed(() =>
    Math.max(
        MIN_CHAT_WIDTH,
        layout.chatWidth.value +
            (tucked.value ? roomBesideChat() - TUCKED_STRIP_PX : fills.value ? roomBesideChat() : layout.besideWidth.value) -
            MIN_PANE_PX,
    ),
);
// Split, both shrink with a window too narrow for their sum, the chat in proportion to its width but never under its
// floor, so its composer keeps its controls; what was opened gives way first. Filling, the chat holds its width.
// Tucked, the column keeps the width it had, out of sight behind the panel's edge: what is framed in it is never resized,
// so it comes back exactly as it was.
const tuckedWidth = (): number => (beside.value ? (panel.split.value ? layout.besideWidth.value : roomBesideChat()) : layout.chatWidth.value);
const tabsStyle = computed(() =>
    tucked.value
        ? { width: uiLength(tuckedWidth()) }
        : beside.value && !fills.value
          ? { flex: `0 1 ${uiLength(layout.besideWidth.value)}` }
          : undefined,
);
const tabsClass = computed(() =>
    tucked.value ? `absolute inset-y-0 right-full invisible` : beside.value && !fills.value ? `relative` : `relative flex-1`,
);
const chatStyle = computed(() => {
    if (chatFolded.value) {
        return { width: uiLength(layout.chatWidth.value) };
    }
    if (!beside.value) {
        return undefined;
    }
    return fills.value
        ? { flex: `0 0 ${uiLength(layout.chatWidth.value)}` }
        : { flex: `1 1 ${uiLength(layout.chatWidth.value)}`, minWidth: uiLength(MIN_CHAT_WIDTH) };
});
// Folded, the chat keeps its width out of sight behind the panel's edge, invisible and inert: its transcript keeps its
// place and nothing in it takes focus.
const chatClass = computed(() => (chatFolded.value ? `absolute inset-y-0 left-full invisible` : beside.value ? `border-l border-line` : `flex-1`));
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

// One async component per side view, kept for the panel's life, so switching tabs never reloads a body. Loaded through
// `loadChunk` like every other lazy surface: a body whose chunk went stale under a long-lived window reloads the window
// once, rather than leaving its tab drawn over nothing. (A failed load is not kept: the async component retries it the
// next time the body mounts.)
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
    const body = defineAsyncComponent(() => loadChunk(entry.component));
    bodies.set(entry, body);
    return body;
};

// A tab whose side view is not registered still draws, under the only name it has left: the view's own id.
const labelOf = (tab: SideTab): SideViewLabel => describeTab(tab) ?? { title: tab.view.slice(tab.view.lastIndexOf(`/`) + 1), icon: `extensions` };
const items = computed<readonly SideStripItem[]>(() => shownSideTabs.value.map((tab) => ({ id: tab.id, label: labelOf(tab) })));

// The bodies, as the tabs they draw: one per tab, except a shared view's tabs, which have one between them (sideViews.ts),
// given the input of whichever of them is on screen, else its first. In a list of their own, after the others, so tabs
// coming and going never move a shared body in the document, which would reload what is framed in it.
interface SideBody {
    readonly key: string;
    readonly tab: SideTab;
}
const ownBodies = computed<readonly SideBody[]>(() =>
    panel.tabs.value.flatMap((tab) => (sideViewOf(tab.view)?.shared === true ? [] : [{ key: tab.id, tab }])),
);
const sharedBodies = computed<readonly SideBody[]>(() => {
    const views = [...new Set(panel.tabs.value.filter((tab) => sideViewOf(tab.view)?.shared === true).map((tab) => tab.view))];
    return views.flatMap((view) => {
        const ofView = panel.tabs.value.filter((tab) => tab.view === view);
        const tab = ofView.find((candidate) => candidate.id === shownSideActive.value) ?? ofView[0];
        return tab === undefined ? [] : [{ key: `shared:${view}`, tab }];
    });
});
const activeTab = computed(() => shownSideTabs.value.find((tab) => tab.id === shownSideActive.value));
const activeHome = computed(() => (activeTab.value === undefined ? undefined : homeOf(activeTab.value)));

// "Open in …" moves the thing into the main area, so its tab has nothing left to show beside it: a move, not a close, so
// Reopen Closed Tab does not bring it back here.
const openHome = (tab: SideTab): void => {
    const home = homeOf(tab);
    if (home !== undefined) {
        home.open();
        closeTabs(new Set([tab.id]));
    }
};

// The tabs right of one, among those on screen.
const toRightOf = (id: string): ReadonlySet<string> => {
    const at = shownSideTabs.value.findIndex((tab) => tab.id === id);
    return new Set(at === -1 ? [] : shownSideTabs.value.slice(at + 1).map((tab) => tab.id));
};

// The panel's root, so Copy Path writes to the clipboard of the window it is drawn in (a popped-out chat's, too).
const rootEl = ref<HTMLElement>();

// Tucking from a press inside the column hands the keyboard to the strip, and a press on the strip hands it to the tab
// it brought back, so the keyboard never lands on what just went out of sight.
const tuckedEl = ref<InstanceType<typeof SideTucked>>();
const tuckAway = (): void => {
    const hadFocus = rootEl.value?.querySelector(`.side-tabs`)?.contains(document.activeElement) === true;
    setTucked(true);
    if (hadFocus) {
        void nextTick(() => tuckedEl.value?.focusActive());
    }
};
const revealFromStrip = (id: string): void => {
    const hadFocus = rootEl.value?.querySelector(`.side-tucked`)?.contains(document.activeElement) === true;
    revealTab(id);
    if (hadFocus) {
        void nextTick(() => document.getElementById(domIdOf(id))?.focus());
    }
};
const toggleTucked = (): void => (tucked.value ? setTucked(false) : tuckAway());

// The chat's own fold hands the keyboard over the same way: to the strip when it goes from under the caret, and back to
// the composer when the strip brings it back.
const chatTuckedEl = ref<InstanceType<typeof ChatTucked>>();
watch(chatFolded, (folded) => {
    if (folded && rootEl.value?.querySelector(`.side-chat`)?.contains(document.activeElement) === true) {
        void nextTick(() => chatTuckedEl.value?.focus());
    }
});
const revealChat = (): void => {
    const hadFocus = rootEl.value?.querySelector(`.side-chat-tucked`)?.contains(document.activeElement) === true;
    setChatTucked(false);
    if (hadFocus) {
        focusComposer();
    }
};

// The file-tab menu every strip shares (tabMenu.ts), with the side panel's own way out: into the tab's section.
const tabMenuRef = ref<{ show: (event: Event) => void }>();
// The tab right-clicked; undefined for the strip's empty space, which shows the strip-wide rows alone.
const menuTab = ref<SideTab>();
const stripActions = computed<TabStripActions>(() => ({
    closeAll: shownSideTabs.value.length === 0 ? undefined : closeAllTabs,
    reopen: panel.canReopen.value ? reopenClosedTab : undefined,
}));
const menuItems = computed<MenuItem[]>(() => {
    const tab = menuTab.value;
    if (tab === undefined) {
        return tabStripMenu(`side`, stripActions.value);
    }
    const home = homeOf(tab);
    const path = tab.view === FILE_SIDE_VIEW ? FileSideInputSchema.safeParse(tab.input).data?.path : undefined;
    const toRight = toRightOf(tab.id);
    return fileTabMenu(`side`, {
        ...stripActions.value,
        keep: tab.id === panel.peek.value ? () => keepTab(tab.id) : undefined,
        place:
            home === undefined
                ? undefined
                : { label: t(`shell.sidePanel.openIn`, { section: home.label }), icon: `expand`, command: `side.openInSection`, run: () => openHome(tab) },
        close: () => closeTab(tab.id),
        closeOthers: shownSideTabs.value.length < 2 ? undefined : () => closeOtherTabs(tab.id),
        closeToRight: toRight.size === 0 ? undefined : () => closeTabsByReader(toRight),
        copyPath: path === undefined ? undefined : { path, root: () => rootEl.value },
    });
});
// `id` is undefined for the strip's empty space; with nothing to offer there the browser's own menu is left alone.
const onTabMenu = (id: string | undefined, event: MouseEvent): void => {
    menuTab.value = id === undefined ? undefined : shownSideTabs.value.find((tab) => tab.id === id);
    if (menuTab.value === undefined && tabStripMenu(`side`, stripActions.value).length === 0) {
        return;
    }
    event.preventDefault();
    tabMenuRef.value?.show(event);
};

let commandDisposables: readonly Disposable[] = [];
onMounted(() => {
    const acting = (act: (tab: SideTab) => void) => (): void => {
        if (activeTab.value !== undefined) {
            act(activeTab.value);
        }
    };
    commandDisposables = [
        registerBuiltin(`side.nextTab`, () => cycleTab(1, shownSideTabs.value)),
        registerBuiltin(`side.previousTab`, () => cycleTab(-1, shownSideTabs.value)),
        registerBuiltin(`side.closeTab`, acting((tab) => closeTab(tab.id))),
        registerBuiltin(`side.closeOtherTabs`, acting((tab) => closeOtherTabs(tab.id))),
        registerBuiltin(`side.closeTabsToRight`, acting((tab) => closeTabsByReader(toRightOf(tab.id)))),
        registerBuiltin(`side.closeAllTabs`, closeAllTabs),
        registerBuiltin(`side.reopenClosedTab`, reopenClosedTab),
        registerBuiltin(`side.keepTab`, acting((tab) => keepTab(tab.id))),
        registerBuiltin(`side.openInSection`, acting(openHome)),
        registerBuiltin(`side.toggleSplit`, () => setSplit(fills.value)),
        registerBuiltin(`side.toggleTucked`, toggleTucked),
    ];
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
    <div
        ref="rootEl"
        :id="fills ? `main-content` : undefined"
        :role="fills ? `main` : `complementary`"
        :tabindex="fills ? -1 : undefined"
        class="side-panel relative flex min-h-0 min-w-0 border-l border-line bg-card"
        :class="{ 'side-fills': fills }"
        :style="panelStyle"
    >
        <!-- What was opened beside: the strip, then every tab's body stacked in one box, the one on screen visible. -->
        <!-- Tucked, it stays mounted at its own width, invisible and inert behind the panel's edge: nothing framed in it
             reloads or resizes, and the strip below stands in its place. -->
        <section
            v-if="tabsOnScreen"
            class="side-tabs flex min-h-0 min-w-0 flex-col"
            :class="tabsClass"
            :style="tabsStyle"
            :inert="tucked ? true : undefined"
            :aria-label="t(`shell.sidePanel.tabs`)"
        >
            <!-- `.view-header`, so the desktop app's window buttons take their corner from this bar when it reaches it. -->
            <div class="view-header flex items-stretch bg-card">
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
                        :class="ui.iconButton({ size: `md` })"
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
                        :class="ui.iconButton({ size: `md` })"
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
                        :class="ui.iconButton({ size: `md` })"
                        :aria-label="t(`shell.sidePanel.openIn`, { section: activeHome.label })"
                        v-tooltip.bottom="{ title: t(`shell.sidePanel.openIn`, { section: activeHome.label }) }"
                        @click="openHome(activeTab)"
                    >
                        <Icon name="expand" class="text-xs" />
                    </button>
                    <!-- Last, nearest the edge it folds into: the gesture the drag past the floor also makes. -->
                    <button
                        v-if="!floating"
                        type="button"
                        :class="ui.iconButton({ size: `md` })"
                        :aria-label="t(`shell.sidePanel.tuckAway`)"
                        v-tooltip.bottom="{ title: t(`shell.sidePanel.tuckAway`), note: t(`shell.sidePanel.tuckAwayNote`) }"
                        @click="tuckAway"
                    >
                        <Icon name="chevrons-right" class="text-xs" />
                    </button>
                </div>
            </div>
            <!-- Every body stays mounted and in place: a hidden preview is never detached (which would reload the app) and a
                 file keeps where it was scrolled to. Hidden ones are invisible and inert, so nothing in them takes focus.
                 `inert` is bound to undefined, not false, on the one shown: Vue writes a false one as `inert="false"`, and
                 the attribute's presence alone makes a subtree inert. -->
            <div class="relative min-h-0 flex-1 bg-canvas">
                <div
                    v-for="{ key, tab } in ownBodies"
                    :key="key"
                    :id="`${domIdOf(tab.id)}-body`"
                    role="tabpanel"
                    :aria-labelledby="domIdOf(tab.id)"
                    class="absolute inset-0 flex min-h-0 flex-col"
                    :class="tab.id === shownSideActive ? `` : `invisible`"
                    :inert="tab.id === shownSideActive ? undefined : true"
                >
                    <!-- Per tab, so a slow read in a hidden tab never speaks for the one shown. -->
                    <FreshnessFrame :offline="offline" :lost-at="lostAt">
                        <component :is="bodyOf(tab)" :input="tab.input" :jump="panel.jumps.value[tab.id]" />
                    </FreshnessFrame>
                </div>
                <div
                    v-for="{ key, tab } in sharedBodies"
                    :key="key"
                    :id="`${domIdOf(tab.id)}-body`"
                    role="tabpanel"
                    :aria-labelledby="domIdOf(tab.id)"
                    class="absolute inset-0 flex min-h-0 flex-col"
                    :class="tab.id === shownSideActive ? `` : `invisible`"
                    :inert="tab.id === shownSideActive ? undefined : true"
                >
                    <!-- Per tab, so a slow read in a hidden tab never speaks for the one shown. -->
                    <FreshnessFrame :offline="offline" :lost-at="lostAt">
                        <component :is="bodyOf(tab)" :input="tab.input" :jump="panel.jumps.value[tab.id]" />
                    </FreshnessFrame>
                </div>
            </div>
        </section>

        <!-- What was opened, tucked away: its tabs as icons where the column stood, beside the chat or at the window's edge. -->
        <SideTucked
            v-if="tucked"
            ref="tuckedEl"
            :tabs="items"
            :active="shownSideActive"
            @reveal="revealFromStrip"
            @close="closeTab"
            @contextmenu="onTabMenu"
        />

        <!-- The chat, tucked away: its strip where the column stood, beside what was opened or at the window's edge. -->
        <ChatTucked v-if="chatFolded" ref="chatTuckedEl" :class="{ 'border-l border-line': beside }" @reveal="revealChat" />

        <!-- The chat's slot, the same element for as long as the chat lives here: tabs coming and going beside it never
             move the chat, so its transcript keeps its place. -->
        <section
            v-if="chatInSidePanel"
            class="side-chat relative flex min-h-0 min-w-0 flex-col"
            :class="chatClass"
            :style="chatStyle"
            :inert="chatFolded ? true : undefined"
        >
            <div ref="chatSlot" class="contents"></div>
            <!-- Between the two columns: the chat's width, traded with the column beside it; tucked, between the strip and
                 the chat, sizing the chat alone. -->
            <ResizeSeam
                v-if="beside"
                v-model="chatSeam"
                place="edge"
                pane="after"
                :min="toScreenPx(TUCKED_STRIP_PX)"
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
            :preview="edgePreview"
            :min="toScreenPx(edgeBounds.min)"
            :max="toScreenPx(edgeBounds.max)"
            :reset="toScreenPx(edgeBounds.reset)"
            :title="t(`ui.resizeSeam.doubleClickResets`)"
        />

        <ContextMenu ref="tabMenuRef" :model="menuItems" :min-width="12" />
    </div>
</template>
