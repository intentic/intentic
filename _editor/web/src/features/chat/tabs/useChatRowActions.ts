import type { IconName } from "@intentic/ui";
import { createInlineRename } from "@intentic/ui/inline-rename";
import { useT } from "@intentic/ui/i18n";
import type { MenuItem } from "primevue/menuitem";
import { computed, inject, type InjectionKey, provide, ref, shallowReactive } from "vue";
import { canArchive } from "../../agents/fleet/useAgents-fleet";
import { useAgents } from "../../agents/fleet/useAgents";
import type HoverCard from "../../../components/HoverCard.vue";
import { clickIntent, rangeSelect } from "../../../lib/multiSelect";
import { commandShortcut } from "../../../shell/commands/useCommands";
import { useChatFloating } from "../panel/chatFloating";
import { chatWide, toggleChatFloating } from "../panel/chatPanelLayout";
import type { RevealVerb } from "../panel/useChat-reveal";
import { relaySummons } from "../run/summon";
import { useChat } from "../run/useChat";
import type { OpenChat } from "./cardView";
import { allTabs, othersOf, tabLabel, tabsInLane, toRightOf } from "./tabs";

// Every verb an open chat's row answers to, owned once per list host (ChatTabList) and shared by both cuts of it, so a
// row under a persona and the same row under a lane can never offer different things. The host draws the one menu,
// hover card, share dialog and rename error; the rows (ChatRowList) reach all of it through `injectChatRowActions`.

export interface ChatRowHost {
    readonly select: (id: string) => void;
    readonly close: (ids: ReadonlySet<string>) => void;
    // Rows in reading order across whatever the host draws, for Shift+click ranges.
    readonly rowOrder: () => readonly string[];
}

const KEY: InjectionKey<ChatRowActions> = Symbol(`chat-row-actions`);

export const createChatRowActions = (host: ChatRowHost) => {
    const t = useT();
    const { conversations, activeId, panes, openBeside, closePane, collapsePanes, setPanes, keepChat, setPinned } = useChat();
    const { agentById, rename, archive } = useAgents();
    const { floats } = useChatFloating();

    // Broadcasts the same reveal to other windows (relaySummons) so their fleet boards ring the conversation this rail
    // is showing. Conversations fold to their wire form, so a window that never opened one can rebuild the tab.
    const relayRows = (verb: RevealVerb, ids: readonly string[], focus: string): void => {
        const entries = ids.flatMap((id) => conversations.value.filter((conversation) => conversation.conversationId === id));
        relaySummons({ kind: `reveal`, verb, entries, focus, caret: false });
    };

    // Rows on screen mirror the pane set at one ring weight (RailCard.selected); the focused chat is always included.
    const showing = (id: string): boolean => panes.value.includes(id);
    // Whether a pane can be given back: the last one is the panel itself, so Close Pane needs at least two.
    const split = computed(() => panes.value.length > 1);
    // Panes exist only on wide surfaces; the docked column is too narrow for a second chat (see ChatPanel).
    const paneable = computed(() => chatWide.value);
    const isSelected = (id: string): boolean => activeId.value === id || showing(id);

    // Plain click switches to just that row; Ctrl/Cmd+click toggles a column beside it; Shift+click ranges from the
    // anchor — the same gestures and verbs as the terminal strip's onSegmentClick.
    const anchor = ref<string>();
    const click = (event: MouseEvent, id: string): void => {
        if (!paneable.value) {
            anchor.value = id;
            host.select(id);
            // `focus`, not `show`: this surface has no panes, so no split of its own to collapse.
            relayRows(`focus`, [id], id);
            return;
        }
        const intent = clickIntent(event);
        if (intent === `range`) {
            const run = rangeSelect(host.rowOrder(), anchor.value ?? activeId.value, id);
            if (run !== undefined) {
                setPanes(run);
                relayRows(`panes`, run, id);
            }
            return;
        }
        anchor.value = id;
        if (intent === `toggle`) {
            // A chat with a column gives it back; one without takes a new column beside the focus.
            if (showing(id) && split.value) {
                closePane(id);
                relayRows(`unpane`, [id], id);
                return;
            }
            openBeside(id);
            relayRows(`beside`, [id], id);
            return;
        }
        host.select(id);
        // Resets any split to just this row; matters only where panes are drawn (docked keeps but hides the split).
        collapsePanes();
        // `show` bundles select + collapse into the one verb other windows apply.
        relayRows(`show`, [id], id);
    };
    // A select raised from outside the row gesture (a persona tile starting a chat) tells the other windows the same way.
    const focus = (id: string): void => {
        host.select(id);
        relayRows(`focus`, [id], id);
    };

    // Which rows are drawn right now, registered by every list that draws some: a rename cannot outlive the row it sits
    // on, and only the lists know which of theirs made it past a fold, a filter or a collapsed group.
    const drawn = shallowReactive(new Set<() => ReadonlySet<string>>());
    const registerDrawn = (ids: () => ReadonlySet<string>): (() => void) => {
        drawn.add(ids);
        return () => drawn.delete(ids);
    };

    // Single rename state for the list, via the same createInlineRename the fleet cards use (renames the registry entry).
    const renamingId = ref<string | undefined>(undefined);
    const renaming = computed(() => conversations.value.find((conversation) => conversation.conversationId === renamingId.value));
    const edit = createInlineRename(
        () => renaming.value?.title.value ?? undefined,
        (name) => rename(renaming.value?.conversationId ?? ``, name),
        `Couldn't rename the agent.`,
    );
    const beginRename = (id: string): void => {
        renamingId.value = id;
        edit.begin();
    };
    const renamingDrawn = computed(() => renamingId.value !== undefined && [...drawn].some((ids) => ids().has(renamingId.value!)));

    // Hover shows the full title plus the first prompt (what the chat was for) and the last one if different (what it's
    // about now); images ride along since a prompt is often a screenshot.
    const hoverCard = ref<InstanceType<typeof HoverCard> | null>(null);
    const showPreview = (event: MouseEvent, entry: OpenChat): void => {
        const prompts = entry.conversation.transcript.messages.value.filter((message) => message.role === `user`);
        const first = prompts[0];
        const last = prompts.at(-1);
        hoverCard.value?.show(event, {
            title: entry.conversation.title.value ?? undefined,
            // Labelled "Latest" only when two prompts differ; a fresh draft with neither shows no preview.
            messages: [
                ...(first === undefined ? [] : [{ text: first.text, attachments: first.attachments }]),
                ...(last === undefined || last === first ? [] : [{ label: t(`shared.latest`), text: last.text, attachments: last.attachments }]),
            ],
        });
    };
    const hidePreview = (): void => {
        hoverCard.value?.hide();
    };

    // Target for the share dialog: the right-clicked chat may no longer be on screen by the time it's answered.
    const shareTarget = ref<{ id: string; title: string }>();
    const openShare = (id: string): void => {
        const conversation = conversations.value.find((entry) => entry.conversationId === id);
        if (conversation !== undefined) {
            shareTarget.value = { id, title: tabLabel(conversation) };
        }
    };

    // Archivable from a row exactly when its board card is: this sandbox's, filed, and not mid-turn or asking.
    const archivableRow = (id: string): boolean => {
        const conversation = conversations.value.find((entry) => entry.conversationId === id);
        const agent = agentById(id);
        return conversation?.box.value === undefined && agent !== undefined && canArchive(agent);
    };

    // Acts on the right-clicked card (menuId), never the active one — its keyboard commands live with the panel header.
    const menu = ref<{ show: (event: Event) => void } | undefined>();
    const menuId = ref<string>();
    // One array for every closed menu: a fresh one each pass is a changed prop, and the menu redraws for it.
    const NO_ITEMS: MenuItem[] = [];
    const menuItems = computed<MenuItem[]>(() => {
        const id = menuId.value;
        const conversation = conversations.value.find((entry) => entry.conversationId === id);
        if (id === undefined || conversation === undefined) {
            return NO_ITEMS; // no card named, or the right-clicked one closed under the open menu
        }
        const others = othersOf(id);
        const toRight = toRightOf(id);
        const finished = tabsInLane(`finished`);
        const pinned = conversation.pinned.value;
        return [
            // Keep Open leads the menu on a preview tab: same convention and wording as WorkspaceDesktop.
            ...(conversation.peek.value ? [{ label: t(`shared.keepOpen`), command: () => keepChat(id) }] : []),
            {
                label: pinned ? t(`chat.chatTabList.unpin`) : t(`chat.chatTabList.pin`),
                icon: `pin` as IconName,
                shortcut: commandShortcut(`chat.togglePin`),
                command: () => setPinned(id, !pinned),
            },
            { label: t(`ui.action.rename`), icon: `pencil`, shortcut: commandShortcut(`chat.rename`), command: () => beginRename(id) },
            // Share opens a dialog rather than acting directly; it renders a frozen snapshot, the conversation is unchanged.
            { label: t(`chat.chatTabList.share`), icon: `globe`, command: () => openShare(id) },
            { separator: true },
            // Open Beside/Close Pane mirror Ctrl+click; unlike Close, they give back the column without ending the chat.
            ...(paneable.value
                ? [
                      showing(id) && split.value
                          ? { label: t(`shared.closePane`), shortcut: commandShortcut(`chat.closePane`), command: () => closePane(id) }
                          : { label: t(`chat.chatTabList.openBeside`), shortcut: commandShortcut(`chat.splitView`), command: () => openBeside(id) },
                      { separator: true },
                  ]
                : []),
            { label: t(`ui.action.close`), icon: `times`, shortcut: commandShortcut(`chat.closeTab`), command: () => host.close(new Set([id])) },
            // Done with it everywhere, not just here: the board's own Archive, offered where the board would offer it.
            ...(archivableRow(id)
                ? [{ label: t(`chat.chatTabList.archive`), icon: `box` as IconName, shortcut: commandShortcut(`chat.archive`), command: () => void archive([id]) }]
                : []),
            { separator: true },
            { label: t(`shared.closeOthers`), disabled: others.size === 0, shortcut: commandShortcut(`chat.closeOtherTabs`), command: () => host.close(others) },
            { label: t(`shared.closeToRight`), disabled: toRight.size === 0, shortcut: commandShortcut(`chat.closeTabsToRight`), command: () => host.close(toRight) },
            {
                label: t(`shared.closeFinished`),
                disabled: finished.size === 0,
                shortcut: commandShortcut(`chat.closeFinishedTabs`),
                command: () => host.close(finished),
            },
            { label: t(`shared.closeAll2`), shortcut: commandShortcut(`chat.closeAllTabs`), command: () => host.close(allTabs()) },
            { separator: true },
            {
                label: floats.value ? t(`shared.dockChatBack`) : t(`shared.moveChatIntoNewWindow`),
                shortcut: commandShortcut(`chat.toggleFloating`),
                command: (): void => toggleChatFloating(),
            },
        ];
    });
    const openMenu = (id: string, event: Event): void => {
        // Pointer stays on the card, so the hover preview would otherwise never leave on its own.
        hidePreview();
        menuId.value = id;
        menu.value?.show(event);
    };

    // Middle-click closes the card under the pointer, the tab gesture these cards stand in for. Held to the same rule as
    // the ×: the last open chat keeps no close affordance, so the press has nothing to act on either.
    const middleClose = (id: string): void => {
        if (conversations.value.length > 1) {
            host.close(new Set([id]));
        }
    };
    const closable = computed(() => conversations.value.length > 1);

    return {
        isSelected,
        click,
        focus,
        registerDrawn,
        renamingId,
        renamingDrawn,
        edit,
        beginRename,
        hoverCard,
        showPreview,
        hidePreview,
        shareTarget,
        menu,
        menuId,
        menuItems,
        openMenu,
        middleClose,
        closable,
        close: (id: string): void => host.close(new Set([id])),
        closeSet: (ids: ReadonlySet<string>): void => host.close(ids),
        keep: (id: string): void => keepChat(id),
    };
};

export type ChatRowActions = ReturnType<typeof createChatRowActions>;

/** Hands the host's row verbs to every list it draws. */
export const provideChatRowActions = (actions: ChatRowActions): void => {
    provide(KEY, actions);
};

/** The row verbs of the list host this component sits in. */
export const injectChatRowActions = (): ChatRowActions => {
    const actions = inject(KEY);
    if (actions === undefined) {
        throw new Error(`A chat row list must sit inside ChatTabList.`);
    }
    return actions;
};
