<script setup lang="ts">
import { ContextMenu, isOverlayTarget, SearchBar, type Tip } from "@intentic/ui";
import { useVocabulary } from "../../../workbench/views/vocabulary";
import { useSettled } from "@intentic/ui/async";
import { createInlineRename } from "@intentic/ui/inline-rename";
import type { Disposable } from "@intentic/extension-api";
import type { MenuItem } from "primevue/menuitem";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { startAgent } from "../../../models/fleet/agentActions";
import { useDriveRefusal } from "../session/driveRefusal";
import { useAgents } from "../../../models/fleet/useAgents";
import { canArchive } from "../../../models/fleet/useAgents-fleet";
import RailLane from "../../../components/RailLane.vue";
import { toggleChatFloating, toggleChatTucked } from "../../../models/conversations/panel/chatPanelLayout";
import { allTabs, needsYouQueue, othersOf, tabLabel, tabsInLane, toRightOf } from "./tabs";
import { useChat } from "../../../models/conversations/run/useChat";
import { SEARCH_SETTLE_MS } from "../../../models/conversations/run/useChat-sessions";
import { useChatFloating } from "../../../models/conversations/panel/chatFloating";
import { registerBuiltin } from "../../../workbench/commands/builtinCommands";
import { commandShortcut, withShortcut } from "../../../workbench/commands/useCommands";
import { viewersOfSession } from "../../../workbench/presence/usePresence";
import PresenceAvatars from "../../../workbench/presence/PresenceAvatars.vue";
import ChatTabList from "./ChatTabList.vue";
import PastChatList from "../panel/PastChatList.vue";
import { useT } from "@intentic/ui/i18n";

// The chat panel's own bar: names the active conversation and drops the full list (ChatTabList) on click, a header over a
// sheet wherever the chat stands (the Agents board is the standing list of chats). Reads the conversation list from
// useChat and emits select/close/open rather than writing it.

const t = useT();
const vocabulary = useVocabulary();
// A reader who cannot drive a chat (a viewer, a writer with agents off) is offered no new one: it would only be refused.
const readOnly = useDriveRefusal();

const emit = defineEmits<{
    select: [id: string];
    // A SET, not an id: a card's × closes one, the menus close many.
    close: [ids: ReadonlySet<string>];
    open: [id: string];
}>();

const {
    conversations,
    active,
    activeId,
    panes,
    openBeside,
    closePane,
    sessions,
    sessionsFailure,
    loadSessions,
    reopenClosed,
    hasClosed,
} = useChat();
const { agentById, rename, archive, fleet, open: openAgent } = useAgents();
const { floats } = useChatFloating();
// The hover card and the accessible name, each with the shortcut. In its own window the same press brings it back.
const shortcutTip = (title: string, command: string): Tip => ({ title, keys: commandShortcut(command) });
const floatHint = computed(() => shortcutTip(floats.value ? t(`chat.words.dockChatBack`) : t(`chat.chatTabs.newWindow`), `chat.toggleFloating`));
const floatLabel = computed(() =>
    withShortcut(floats.value ? t(`chat.words.dockChatBack`) : t(`chat.words.moveChatIntoNewWindow`), `chat.toggleFloating`),
);
// Folds the chat into the strip at the window's edge (shell/side/ChatTucked.vue), as dragging its edge past half a pane does.
const tuckHint = computed((): Tip => ({ ...shortcutTip(t(`chat.chatTabs.tuckAway`), `chat.toggleTucked`), note: t(`chat.chatTabs.tuckAwayNote`) }));
const tuckLabel = computed(() => withShortcut(t(`chat.chatTabs.tuckAway`), `chat.toggleTucked`));

// The bar's corner, as wide as the presses it holds (`h-7 w-7`, `gap-1`): new chat unless the reader can't start one, fold
// unless the panel has its own window, and the window toggle always. The left side takes the same floor (template).
const cornerWidth = computed(() => {
    const presses = (readOnly.value ? 0 : 1) + (floats.value ? 0 : 1) + 1;
    return `calc(${presses} * 1.75rem + ${presses - 1} * 0.25rem)`;
});

// Not an AnchoredOverlay: that dismisses on any outside pointerdown, including the row menu's teleported
// target, before Rename shows its input. Closed by Escape, a second header press, a pick, or an outside click
// (context menus and the list's own popovers excepted: the main-line strip's teleports out of the sheet, and closing the
// sheet under a press on it would unmount the popover before the press landed).
const listOpen = ref(false);
// One ref answers both "is this click ours" and "which document".
const bar = ref<HTMLElement | null>(null);
const onDocumentPointerDown = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Node)) {
        return;
    }
    if (bar.value?.contains(target) === true || isOverlayTarget(target)) {
        return;
    }
    listOpen.value = false;
};
const onDocumentKeydown = (event: KeyboardEvent): void => {
    if (event.key === `Escape`) {
        listOpen.value = false;
    }
};
// Armed on the bar's own document, so a docked and a floating panel never listen in the wrong window.
let armedDocument: Document | undefined;
const disarmSheet = (): void => {
    armedDocument?.removeEventListener(`pointerdown`, onDocumentPointerDown, true);
    armedDocument?.removeEventListener(`keydown`, onDocumentKeydown);
    armedDocument = undefined;
};
watch(listOpen, (open) => {
    disarmSheet();
    if (!open) {
        return;
    }
    armedDocument = bar.value?.ownerDocument;
    // Capture, so a panel that stops its own bubbling can't also stop this from closing.
    armedDocument?.addEventListener(`pointerdown`, onDocumentPointerDown, true);
    armedDocument?.addEventListener(`keydown`, onDocumentKeydown);
});
onBeforeUnmount(disarmSheet);

// Picking from the sheet ends the errand: switch, then hand the column back to the transcript.
const pick = (id: string): void => {
    listOpen.value = false;
    emit(`select`, id);
};
const pickNotOpen = (id: string): void => {
    listOpen.value = false;
    emit(`open`, id);
};

// The header title renames the chat you're in (F2, double-click); a list card renames itself in place. Both
// use createInlineRename, so either renames the agent registry entry too.
const renaming = ref(false);
const edit = createInlineRename(
    () => active.value.title.value ?? undefined,
    (name) => rename(active.value.conversationId, name),
    () => t(`chat.chatTabs.couldntRenameAgent`),
);
const beginRename = (): void => {
    renaming.value = true;
    edit.begin();
};
// The input is torn down by the edit's own end (commit/cancel/blur), not a second flag kept in sync.
watch(
    () => edit.editing,
    (editing) => {
        if (!editing) {
            renaming.value = false;
        }
    },
);
// The field names the chat it opened on: another window's summons switches chats without blurring it, and the
// commit would then land on whichever chat is active by then.
watch(activeId, () => {
    if (edit.editing) {
        edit.cancel();
    }
});

// PAST CHATS RIDE UNDER THE OPEN ONES in the switcher's sheet, as the phone's sheet has them (ChatSwitcherSheet.vue), rather
// than behind a header button of their own: both answer "take me to another chat". Re-read each time the sheet opens, so
// the list is current as of the press; the search filters by title or content (server-side), settled so a keystroke burst
// becomes one request.
const query = ref(``);
watch(useSettled(query, SEARCH_SETTLE_MS, { trim: true }), (settled) => void loadSessions(settled || undefined));
watch(listOpen, (open) => {
    if (open) {
        query.value = ``;
        void loadSessions();
    }
});
// Past is what the sheet doesn't already list above it: a session open in this window is its card there, not a second row.
const pastSessions = computed(() => {
    const open = new Set(conversations.value.flatMap((conversation) => conversation.session.value?.id ?? []));
    return sessions.value.filter((session) => !open.has(session.id));
});

// Right-click on the bar's chrome opens window-wide sweeps (Close Finished/All, pop-out), not a pop-out on the
// spot. A card's own menu acts on that card; this one and the keyboard commands act on the active chat.
const barMenu = ref<{ show: (event: Event) => void } | undefined>();
const barVerbs = (): MenuItem[] => [
    {
        label: t(`chat.words.closeFinished`),
        disabled: tabsInLane(`finished`).size === 0,
        shortcut: commandShortcut(`chat.closeFinishedTabs`),
        command: () => emit(`close`, tabsInLane(`finished`)),
    },
    { label: t(`chat.words.closeAll`), shortcut: commandShortcut(`chat.closeAllTabs`), command: () => emit(`close`, allTabs()) },
    {
        label: t(`chat.words.reopenClosedChat`),
        disabled: !hasClosed.value,
        shortcut: commandShortcut(`chat.reopenClosed`),
        command: () => reopenClosed(),
    },
    { separator: true },
    // The two ways out of the way, in the header buttons' own order: fold it within this window, then leave it.
    ...(floats.value ? [] : [{ label: t(`chat.words.tuckChatAway`), shortcut: commandShortcut(`chat.toggleTucked`), command: toggleChatTucked }]),
    {
        label: floats.value ? t(`chat.words.dockChatBack`) : t(`chat.words.moveChatIntoNewWindow`),
        shortcut: commandShortcut(`chat.toggleFloating`),
        command: (): void => toggleChatFloating(),
    },
];

// The next chat waiting on the reader after the focused one, open or not (needsYouQueue): opening one reads it, so it
// drops out and the next press goes on from the head of what is left.
const nextNeedsYou = (): void => {
    const queue = needsYouQueue(fleet.value);
    const at = queue.findIndex((agent) => agent.id === activeId.value);
    const next = queue[(at + 1) % Math.max(queue.length, 1)];
    if (next !== undefined && next.id !== activeId.value) {
        openAgent(next);
    }
};
// One array for every closed menu, and the verbs above are read only while it is up: built unconditionally they
// rebuild on every conversation change — a keystroke's worth — and a rebuilt model redraws the menu and its portal.
const NO_ITEMS: MenuItem[] = [];
const barMenuUp = ref(false);
const barMenuItems = computed<MenuItem[]>(() => (barMenuUp.value ? barVerbs() : NO_ITEMS));
const onBarContextMenu = (event: MouseEvent): void => {
    if (event.target instanceof Element && event.target.closest(`input, textarea`) !== null) {
        return; // A text field keeps the browser's own editing menu (the rename box, the list's filter).
    }
    event.preventDefault();
    barMenuUp.value = true;
    barMenu.value?.show(event);
};

// Registered while this bar is mounted (desktop/mobile are exclusive). Uses the shell-wide tab chords, all
// acting on the active chat; cycling emits `select`, the same path a card click takes.
let commandDisposables: readonly Disposable[] = [];
const cycleTab = (delta: number): void => {
    const list = conversations.value;
    if (list.length < 2) {
        return;
    }
    const index = list.findIndex((conversation) => conversation.conversationId === activeId.value);
    const next = list[(index + delta + list.length) % list.length];
    if (next !== undefined) {
        emit(`select`, next.conversationId);
    }
};
// Chord half of Open Beside: the next chat after the focused one not already in a column, else the first free
// one, so repeats fill the window instead of reopening one chat.
const splitBeside = (): void => {
    const list = conversations.value;
    const index = list.findIndex((conversation) => conversation.conversationId === activeId.value);
    const free = (conversation: (typeof list)[number]): boolean => !panes.value.includes(conversation.conversationId);
    const next = list.slice(index + 1).find(free) ?? list.find(free);
    if (next !== undefined) {
        openBeside(next.conversationId);
    }
};
onMounted(() => {
    commandDisposables = [
        registerBuiltin(`chat.rename`, (): void => {
            if (edit.editing) {
                return; // Already renaming; a second F2 would wipe the draft.
            }
            beginRename();
        }),
        registerBuiltin(`chat.closeTab`, () => emit(`close`, new Set([activeId.value]))),
        registerBuiltin(`chat.closeOtherTabs`, (): void => {
            const others = othersOf(activeId.value);
            if (others.size > 0) {
                emit(`close`, others);
            }
        }),
        registerBuiltin(`chat.closeTabsToRight`, (): void => {
            const toRight = toRightOf(activeId.value);
            if (toRight.size > 0) {
                emit(`close`, toRight);
            }
        }),
        registerBuiltin(`chat.closeFinishedTabs`, (): void => {
            const finished = tabsInLane(`finished`);
            if (finished.size > 0) {
                emit(`close`, finished);
            }
        }),
        registerBuiltin(`chat.closeAllTabs`, () => emit(`close`, allTabs())),
        registerBuiltin(`chat.archive`, (): void => {
            const agent = agentById(activeId.value);
            if (active.value.box.value === undefined && agent !== undefined && canArchive(agent)) {
                void archive([agent.id]);
            }
        }),
        registerBuiltin(`chat.reopenClosed`, () => void reopenClosed()),
        registerBuiltin(`chat.nextNeedsYou`, () => nextNeedsYou()),
        registerBuiltin(`chat.nextTab`, () => cycleTab(1)),
        registerBuiltin(`chat.previousTab`, () => cycleTab(-1)),
        registerBuiltin(`chat.splitView`, () => splitBeside()),
        // Takes back the column; the chat stays open.
        registerBuiltin(`chat.closePane`, () => closePane(activeId.value)),
        registerBuiltin(`chat.switchTab`, (): void => {
            listOpen.value = !listOpen.value;
        }),
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
    <!-- One line across the column top, with the list on a sheet below it: the chat's segment of the window's top bar
         (`.view-header`), blended, so the title sits on the chat's own surface with no line under it, tied to the board's
         segment beside it by the height alone. What scrolls up still softens just under it (`.chat-pane::before`). -->
    <!-- THE TITLE AND NOTHING ELSE, CENTRED, with the presses in the corner. Three columns: two equal sides keep the title on
         the bar's middle (a long one takes what the sides leave, and truncates), the left one bare background that drags
         the window on desktop (windowGesture.ts) and opens the bar's own menu on right-click. What other chats are doing
         is the board's to say and the tucked strip's (ChatTucked.vue), not a count beside this one's name. -->
    <!-- `--chat-bar-side` is the corner's width, held by BOTH sides as their floor: a title too long for the middle then
         truncates between two equal sides instead of the empty one giving way and pushing it off centre. -->
    <header
        ref="bar"
        class="chat-bar view-header view-header-blend relative grid grid-cols-[minmax(var(--chat-bar-side),1fr)_minmax(0,auto)_minmax(var(--chat-bar-side),1fr)] items-center gap-2 px-1.5"
        :style="{ '--chat-bar-side': cornerWidth }"
        @contextmenu="onBarContextMenu"
    >
        <span aria-hidden="true"></span>
        <input
            v-if="edit.editing && renaming"
            v-model="edit.draft"
            type="text"
            maxlength="80"
            :aria-label="t(`chat.words.chatTitle`)"
            :placeholder="active.isolated.value ? vocabulary.newAgent : t(`chat.words.newChat`)"
            class="ui-field-box ui-field-inline h-7 w-[min(24rem,100%)] min-w-0 select-text px-2 text-center text-[0.8125rem]"
            @keydown.enter.stop.prevent="edit.commit()"
            @keydown.esc.stop.prevent="edit.cancel()"
            @blur="edit.blurCommit()"
            @vue:mounted="edit.focusInput"
        />
        <!-- Soft at rest (the bar's quiet ink, regular weight), full ink under the pointer or open: the transcript is what
             the column is for, and its name only has to be findable. The chevron, shown on hover, says it opens a list;
             `pl-5` matches it and the right padding, so the words, not the button, sit on the bar's middle. -->
        <button
            v-else
            type="button"
            data-chat-switcher
            class="chat-tab group flex h-7 min-w-0 items-center gap-1 rounded-md pr-1.5 pl-5"
            :class="{ 'chat-tab-on': listOpen }"
            :aria-expanded="listOpen"
            aria-haspopup="dialog"
            :aria-label="t(`chat.chatTabs.switchChatOpen`, { count: conversations.length })"
            @click="listOpen = !listOpen"
            @dblclick.prevent.stop="beginRename()"
        >
            <span class="min-w-0 truncate text-[0.8125rem]" v-tooltip.bottom.overflow="tabLabel(active)">{{ tabLabel(active) }}</span>
            <Icon name="chevron-down" class="chat-tab-chevron shrink-0 text-2xs text-subtle" :class="{ 'rotate-180': listOpen }" />
        </button>
        <!-- The corner: who else is in this chat (only when someone is), a new chat, then the two ways out of the way
             (folded into the strip, its own window). Past chats live in the switcher's sheet, not here. -->
        <div class="flex items-center justify-end gap-1">
            <PresenceAvatars
                v-if="active.session.value !== undefined"
                :members="viewersOfSession(active.session.value.id)"
                :label="t(`chat.words.inChat`)"
            />
            <button
                v-if="!readOnly"
                type="button"
                class="composer-ghost chat-new h-7 w-7 shrink-0"
                @click="startAgent()"
                v-tooltip.bottom="vocabulary.newAgent"
                :aria-label="vocabulary.newAgent"
            >
                <Icon name="plus" class="text-sm" />
            </button>
            <!-- Not in a window of its own, which has no edge to fold into. -->
            <button
                v-if="!floats"
                type="button"
                class="composer-ghost h-7 w-7 shrink-0"
                @click="toggleChatTucked()"
                v-tooltip.bottom="tuckHint"
                :aria-label="tuckLabel"
            >
                <Icon name="chevrons-right" class="text-sm" />
            </button>
            <button
                type="button"
                class="composer-ghost h-7 w-7 shrink-0"
                @click="toggleChatFloating()"
                v-tooltip.bottom="floatHint"
                :aria-label="floatLabel"
            >
                <Icon :name="floats ? `sign-in` : `external-link`" class="text-sm" />
            </button>
        </div>

        <!-- A MENU, AND IT LOOKS LIKE ONE: the skin's own overlay surface (opaque, with the drop every menu wears), so it stands
             above the transcript instead of reading as a darker hole cut into it, and its open chats are rows on it
             (`ground-menu`, styles.css), not cards boxed inside a box. Hung centred under the title at a menu's width
             rather than stretched across a wide column, where a title and its status ended up a screen apart; capped in
             height so the transcript is never fully covered. -->
        <div
            v-if="listOpen"
            class="ui-anchored-surface ground-menu absolute left-1/2 top-full z-30 mt-1 max-h-[60vh] w-[min(40rem,calc(100%-0.75rem))] -translate-x-1/2 rounded-xl p-1.5"
        >
            <ChatTabList class="min-h-0 flex-1" @select="pick" @close="emit('close', $event)" @open="pickNotOpen">
                <template #after>
                    <RailLane :label="t(`chat.chatTabs.pastChats`)" data-fold-unit>
                        <SearchBar
                            v-model="query"
                            variant="field"
                            clearable
                            :aria-label="t(`chat.words.searchChats`)"
                            :placeholder="t(`chat.words.searchChatsEllipsis`)"
                        />
                        <div class="flex min-w-0 flex-col gap-0.5">
                            <PastChatList :sessions="pastSessions" :query="query" :failure="sessionsFailure" @open="pickNotOpen" />
                        </div>
                    </RailLane>
                </template>
            </ChatTabList>
        </div>

        <!-- Right-click menu for the bar's own chrome; cards have their own, inside the list. -->
        <ContextMenu ref="barMenu" :model="barMenuItems" :min-width="13" @hide="barMenuUp = false" />
    </header>
</template>
