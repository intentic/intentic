<script setup lang="ts">
import { ConfirmDialog, ContextMenu, Icon, type IconName, Modal, ui, vMiddleclick } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import type { MenuItem } from "primevue/menuitem";
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { focusInput } from "@intentic/ui/inline-rename";
import { clickIntent } from "../../../lib/multiSelect";
import { TERMINAL } from "../../../shell/commands/categories";
import { commandShortcut, registerCommand, withShortcut } from "../../../shell/commands/useCommands";
import { KINDS, setTerminalMeta, TERMINAL_COLORS, TERMINAL_ICONS, type TerminalColor, terminalMeta } from "../terminalMeta";
import type { useTerminalFloating } from "../terminalFloating";
import { inactiveTerminals } from "../terminalSweep";
import type { TerminalTabs } from "../useTerminal";
import { showWorkTerminals } from "../useWorkTerminals";
import { hasWork, killAsks, killQuestion } from "./killPlan";
import { panelCommands } from "./panelCommands";
import { clearedLabel, cycled, iconFor, labelFor, segmentColor, stripIndex, tooltipFor } from "./stripSegments";
import { groupKey, NO_SELECTION, type SelectionEvent, selects, type StripSelection, stepSelection } from "./stripSelection";

// Every kill goes through `requestKill`, so each route to it (×, middle-click, menu, chord) asks the same question.

const { tabs, floating, vertical } = defineProps<{
    tabs: Pick<
        TerminalTabs,
        `order` | `groups` | `answer` | `remembered` | `activeName` | `switchTab` | `joinTabs` | `unsplit` | `newTab` | `splitTab` | `killTabs`
    >;
    floating: Pick<ReturnType<typeof useTerminalFloating>, `floats` | `toggle`>;
    vertical: boolean;
}>();

const { order, groups, activeName, switchTab, joinTabs, unsplit, newTab, splitTab, killTabs } = tabs;
const tabByName = computed(() => new Map(order.value.map((tab) => [tab.name, tab])));
const positions = computed(() => stripIndex(groups.value));
const segmentLabel = (name: string): string => labelFor(name, tabByName.value.get(name), positions.value.get(name));

// Skeleton of the strip's last-known shape while its list is in flight: unlabelled and inert, capped at six groups.
const placeholders = computed(() => (tabs.answer.value === `waiting` && groups.value.length === 0 ? tabs.remembered.value.slice(0, 6) : []));

const selection = ref<StripSelection>(NO_SELECTION);
const select = (event: SelectionEvent): void => {
    selection.value = stepSelection(selection.value, event);
};
const selectedGroups = computed(() => groups.value.filter((group) => selects(selection.value, group)));
// Flattened in strip order, so a joined pane reads left to right as the strip did.
const selectedNames = computed(() => selectedGroups.value.flat());
const activeGroupIndex = computed(() => groups.value.findIndex((group) => activeName.value !== undefined && group.includes(activeName.value)));

const onSegmentClick = (event: MouseEvent, groupIndex: number, name: string): void => {
    const kind = clickIntent(event);
    select({ kind, groups: groups.value, at: groupIndex, active: activeGroupIndex.value });
    if (kind === `single`) {
        switchTab(name);
    }
};

const killable = computed(() => order.value.filter((tab) => !KINDS[tab.kind].logs).map((tab) => tab.name));
// The sweep's clock, stamped when a menu opens or a sweep fires, so the row's count and the kill agree without a ticker.
const sweepNow = ref(Date.now());
const inactive = computed(() => inactiveTerminals(order.value, { now: sweepNow.value, focused: activeName.value }));
// The names a confirm dialog stands over: a busy session, or a bulk kill the gesture never named.
const pendingKill = ref<string[]>();
const killPrompt = computed(() => killQuestion(order.value, pendingKill.value ?? []));

const kill = (names: string[]): void => {
    killTabs?.(names);
    select({ kind: `clear` });
};
const requestKill = (names: string[]): void => {
    if (killTabs === undefined || names.length === 0) {
        return;
    }
    if (killAsks(order.value, names)) {
        pendingKill.value = names;
        return;
    }
    kill(names);
};
const confirmKill = (): void => {
    if (pendingKill.value !== undefined) {
        kill(pendingKill.value);
    }
    pendingKill.value = undefined;
};
const sweepInactive = (): void => {
    if (killTabs === undefined) {
        return;
    }
    sweepNow.value = Date.now();
    const names = inactive.value.map((tab) => tab.name);
    if (names.length > 0) {
        kill(names);
    }
};

// A pill's label edits in place: Enter commits, Esc cancels, blur commits, and an empty name resets to the default.
const renamingName = ref<string | undefined>(undefined);
const renameDraft = ref(``);
const beginRename = (name: string): void => {
    renameDraft.value = terminalMeta(name).label ?? ``;
    renamingName.value = name;
};
const commitRename = (): void => {
    const name = renamingName.value;
    renamingName.value = undefined;
    // Enter already committed it: the blur of the field unmounting must not commit again.
    if (name !== undefined) {
        setTerminalMeta(name, { label: renameDraft.value.trim() === `` ? undefined : renameDraft.value.trim() });
    }
};
// A middle-click is the pill's × pressed, and does nothing where the strip offers no kill or the pill is being renamed.
const middleKill = (name: string): void => {
    if (renamingName.value !== name) {
        requestKill([name]);
    }
};

// Colour and icon overrides live in a dialog: a swatch grid is a picker, with nowhere to sit in a pill.
const customize = ref<{ name: string; mode: `color` | `icon` } | undefined>(undefined);
const openCustomize = (name: string, mode: `color` | `icon`): void => {
    customize.value = { name, mode };
};
const applyCustomize = (meta: { color?: TerminalColor; icon?: IconName }): void => {
    if (customize.value !== undefined) {
        setTerminalMeta(customize.value.name, meta);
    }
    customize.value = undefined;
};
const colorOptions = Object.entries(TERMINAL_COLORS) as [TerminalColor, string][];

const menu = ref<{ show: (event: Event) => void } | undefined>();
// The pill a right-click landed on; undefined for empty bar space, whose menu is the strip-wide rows alone.
const menuTarget = ref<{ groupIndex: number; name: string } | undefined>(undefined);
const openMenu = (event: MouseEvent, target: { groupIndex: number; name: string } | undefined): void => {
    sweepNow.value = Date.now();
    menuTarget.value = target;
    menu.value?.show(event);
};
const openTabMenu = (event: MouseEvent, groupIndex: number, name: string): void => {
    select({ kind: `retarget`, groups: groups.value, at: groupIndex });
    openMenu(event, { groupIndex, name });
};
const onBarContextMenu = (event: MouseEvent): void => {
    if (event.target instanceof Element && event.target.closest(`button, [data-term-tab]`) !== null) {
        return;
    }
    event.preventDefault();
    openMenu(event, undefined);
};

// Rows naming no particular pill: the sweep, kill-all, work terminals and pop-out; each absent where it would do nothing.
const stripItems = computed<MenuItem[]>(() => {
    const items: MenuItem[] = [];
    // Above kill-all, as the narrower option.
    if (killTabs !== undefined && inactive.value.length > 0) {
        items.push({
            label: `Kill ${inactive.value.length} inactive ${inactive.value.length === 1 ? `terminal` : `terminals`}`,
            shortcut: commandShortcut(`terminal.killInactive`),
            command: sweepInactive,
        });
    }
    if (killTabs !== undefined && killable.value.length > 0) {
        items.push({
            label: t(`terminal.terminalPanel.killAllTerminals`),
            shortcut: commandShortcut(`terminal.killAll`),
            command: () => requestKill(killable.value),
        });
    }
    items.push(
        ...(items.length > 0 ? [{ separator: true }] : []),
        // The one checked row: whether work terminals tab at all, the same preference as the popover and Settings.
        {
            label: t(`terminal.terminalPanel.showWorkTerminals`),
            checked: showWorkTerminals.value,
            shortcut: commandShortcut(`terminal.toggleWorkTerminals`),
            command: () => (showWorkTerminals.value = !showWorkTerminals.value),
        },
        {
            label: floating.floats.value ? `Dock panel back` : `Move panel into new window`,
            shortcut: commandShortcut(`terminal.toggleFloating`),
            command: floating.toggle,
        },
    );
    return items;
});

// Joins the selection when it spans more than one group; a mass action leaves nothing selected.
const joinSelected = (): void => {
    if (selectedGroups.value.length > 1) {
        joinTabs(selectedNames.value);
        select({ kind: `clear` });
    }
};

// Mass actions for a selection of several groups.
const selectionItems = (): MenuItem[] => {
    const names = selectedNames.value;
    const join: MenuItem = {
        label: t(`terminal.terminalPanel.joinTabs`, { count: selectedGroups.value.length }),
        shortcut: commandShortcut(`terminal.join`),
        command: joinSelected,
    };
    if (killTabs === undefined) {
        return [join];
    }
    return [
        join,
        { separator: true },
        {
            label: t(`terminal.terminalPanel.killTerminals`, { count: names.length }),
            shortcut: commandShortcut(`terminal.kill`),
            command: () => requestKill(names),
        },
    ];
};

// A single pill's own rows, each with its shortcut.
const pillItems = (name: string, group: readonly string[]): MenuItem[] => {
    const layout: MenuItem[] = [
        ...(splitTab === undefined
            ? []
            : [{ label: t(`terminal.terminalPanel.splitTerminal`), shortcut: commandShortcut(`terminal.split`), command: () => splitTab(name) }]),
        ...(group.length > 1
            ? [{ label: t(`terminal.terminalPanel.unsplitTerminal`), shortcut: commandShortcut(`terminal.unsplit`), command: () => unsplit(name) }]
            : []),
    ];
    const items: MenuItem[] = [
        ...layout,
        ...(layout.length > 0 ? [{ separator: true }] : []),
        { label: t(`ui.action.rename`), shortcut: commandShortcut(`terminal.rename`), command: () => beginRename(name) },
        {
            label: t(`terminal.terminalPanel.changeColor`),
            shortcut: commandShortcut(`terminal.changeColor`),
            command: () => openCustomize(name, `color`),
        },
        {
            label: t(`terminal.terminalPanel.changeIcon`),
            shortcut: commandShortcut(`terminal.changeIcon`),
            command: () => openCustomize(name, `icon`),
        },
    ];
    if (killTabs === undefined) {
        return items;
    }
    return [
        ...items,
        { separator: true },
        {
            label: KINDS[tabByName.value.get(name)?.kind ?? `shell`].logs ? `Close log view` : `Kill terminal`,
            shortcut: commandShortcut(`terminal.kill`),
            // Through requestKill like any kill: a menu row knows no more about a busy session than the ×.
            command: () => requestKill([name]),
        },
    ];
};

const menuItems = computed<MenuItem[]>(() => {
    const target = menuTarget.value;
    if (target === undefined) {
        return stripItems.value;
    }
    const own = selectedGroups.value.length > 1 ? selectionItems() : pillItems(target.name, groups.value[target.groupIndex] ?? [target.name]);
    return [...own, ...stripItems.value];
});

const cycleTab = (delta: number): void => {
    const next = cycled(groups.value, activeName.value, delta);
    if (next !== undefined) {
        switchTab(next);
    }
};

let commandDisposables: readonly { dispose: () => void }[] = [];
onMounted(() => {
    commandDisposables = panelCommands({
        activeName,
        renamingName,
        selectedNames,
        killable,
        beginRename,
        openCustomize,
        joinSelected,
        requestKill,
        sweepInactive,
        cycleTab,
        unsplit,
        splitTab,
        canKill: killTabs !== undefined,
    }).map((entry) => registerCommand({ owner: `builtin`, category: TERMINAL, ...entry }));
});
onBeforeUnmount(() => {
    for (const disposable of commandDisposables) {
        disposable.dispose();
    }
});
</script>

<template>
    <!-- Across the top when docked, down the left edge floating (`vertical`); same pills, toolbar, and menu either way. -->
    <div
        class="flex shrink-0 gap-1 border-line bg-card"
        :class="vertical ? 'w-40 flex-col items-stretch border-r px-1 py-1.5' : 'items-center border-b px-2 py-0.5'"
        @contextmenu="onBarContextMenu"
    >
        <!-- One pill per split group, one segment per session, styled like FileTabs: glyph, label, and a hover ×. -->
        <div
            class="flex min-w-0 flex-1 gap-x-0.5 gap-y-1 overflow-x-hidden overflow-y-auto"
            :class="vertical ? 'min-h-0 flex-col items-stretch' : 'max-h-13 flex-wrap items-center'"
        >
            <div
                v-for="(group, gi) in groups"
                :key="groupKey(group)"
                data-term-tab
                class="group flex h-6 shrink-0 cursor-pointer select-none items-center rounded-md transition-colors"
                :class="[
                    vertical ? 'w-full min-w-0' : '',
                    selects(selection, group)
                        ? 'bg-primary-500/14 text-content'
                        : gi === activeGroupIndex
                          ? 'bg-overlay text-content'
                          : 'text-muted hover:bg-content/6 hover:text-content',
                ]"
            >
                <template v-for="(name, si) in group" :key="name">
                    <span v-if="si > 0" class="h-3.5 w-px shrink-0 bg-line"></span>
                    <div
                        class="flex h-full items-center gap-1.5 pl-2 pr-1.5 text-2xs"
                        :class="[vertical ? 'min-w-0 flex-1' : '', { 'opacity-60': tabByName.get(name)?.running === false }]"
                        v-tooltip.top="renamingName === name ? undefined : tooltipFor(tabByName.get(name))"
                        v-middleclick="() => middleKill(name)"
                        @click="onSegmentClick($event, gi, name)"
                        @dblclick.prevent.stop="beginRename(name)"
                        @contextmenu.prevent.stop="openTabMenu($event, gi, name)"
                    >
                        <Icon
                            :name="iconFor(name, tabByName.get(name))"
                            class="text-2xs"
                            :class="
                                segmentColor(name) === undefined ? (tabByName.get(name)?.kind === 'agent' ? 'text-link' : 'text-muted') : undefined
                            "
                            :style="segmentColor(name) === undefined ? undefined : { color: segmentColor(name) }"
                        />
                        <!-- The strip keeps a fixed pill width and owns its clicks. -->
                        <input
                            v-if="renamingName === name"
                            v-model="renameDraft"
                            type="text"
                            maxlength="40"
                            :aria-label="t(`terminal.terminalPanel.terminalName`)"
                            :placeholder="clearedLabel(tabByName.get(name), positions.get(name))"
                            class="ui-field-box ui-field-inline w-24 min-w-0 select-text px-1 text-2xs"
                            @click.stop
                            @dblclick.stop
                            @keydown.enter.stop.prevent="commitRename"
                            @keydown.esc.stop.prevent="renamingName = undefined"
                            @blur="commitRename"
                            @vue:mounted="focusInput"
                        />
                        <span v-else :class="vertical ? 'min-w-0 flex-1 truncate text-left' : undefined">{{ segmentLabel(name) }}</span>
                        <!-- The pill identifies the live terminal target. -->
                        <span
                            v-if="hasWork(tabByName.get(name)) && (vertical || group.length === 1)"
                            class="min-w-0 max-w-24 shrink truncate font-mono text-[0.6rem] text-muted"
                            >{{ tabByName.get(name)?.command }}</span
                        >
                        <span v-if="hasWork(tabByName.get(name))" class="size-1.5 shrink-0 rounded-full bg-link" aria-hidden="true"></span>
                        <span
                            v-if="killTabs !== undefined && renamingName !== name"
                            class="relative flex h-3 w-3 shrink-0 items-center justify-center"
                            @click.stop="requestKill([name])"
                            :aria-label="
                                hasWork(tabByName.get(name))
                                    ? t(`terminal.terminalPanel.killTerminalRunning`, { command: tabByName.get(name)?.command })
                                    : t(`terminal.terminalPanel.killTerminal`)
                            "
                        >
                            <Icon
                                name="times"
                                class="absolute rounded text-[0.6rem] opacity-0 transition-opacity hover:text-content group-hover:opacity-60"
                            />
                        </span>
                    </div>
                </template>
            </div>
            <!-- Remembered terminals keep their own placeholder blocks until sessions load. -->
            <div
                v-for="(group, gi) in placeholders"
                :key="`held-${gi}`"
                class="flex h-6 shrink-0 items-center rounded-md bg-overlay/50 opacity-40"
                :class="vertical ? 'w-full min-w-0' : ''"
                aria-hidden="true"
            >
                <template v-for="(name, si) in group" :key="name">
                    <span v-if="si > 0" class="h-3.5 w-px shrink-0 bg-line"></span>
                    <div class="flex h-full items-center px-2" :class="vertical ? 'min-w-0 flex-1' : ''">
                        <span class="h-2 w-8 rounded-full bg-line"></span>
                    </div>
                </template>
            </div>
            <button
                v-if="newTab !== undefined"
                type="button"
                class="flex h-6 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-overlay hover:text-content"
                :class="vertical ? 'w-full' : 'w-6'"
                @click="newTab()"
                v-tooltip.top="withShortcut(t(`terminal.terminalPanel.newTerminal`), 'terminal.new')"
                :aria-label="t(`terminal.terminalPanel.newTerminal`)"
            >
                <Icon name="plus" class="text-2xs" />
            </button>
        </div>
        <!-- Toolbar: trailing the pills across the top, wrapped under them in the rail. -->
        <div class="flex shrink-0 items-center gap-1" :class="vertical ? 'flex-wrap justify-center border-t border-line pt-1.5' : undefined">
            <slot />
        </div>

        <ContextMenu ref="menu" :model="menuItems" :min-width="14" />

        <!-- Confirm shown only when there's something to lose: a busy session, or a bulk kill the gesture never named. -->
        <ConfirmDialog
            :open="pendingKill !== undefined"
            :header="killPrompt.header"
            :confirm-label="t(`terminal.terminalPanel.killAnyway`)"
            confirm-icon="trash"
            :items="killPrompt.items"
            @cancel="pendingKill = undefined"
            @confirm="confirmKill"
        >
            <template #item="{ item }">
                <Icon :name="iconFor(item.name, item)" class="shrink-0 text-2xs text-muted" />
                <span class="shrink-0 text-content">{{ segmentLabel(item.name) }}</span>
                <span v-if="item.command" class="truncate font-mono text-xs text-muted">{{ item.command }}</span>
            </template>
            <p class="mt-3 text-xs text-muted">{{ killPrompt.body }}</p>
        </ConfirmDialog>

        <!-- One dialog for both pickers; a leading default swatch clears the override. Rename stays inline in the strip. -->
        <Modal
            :open="customize !== undefined"
            size="sm"
            :header="
                customize === undefined
                    ? ''
                    : customize.mode === 'color'
                      ? t(`terminal.terminalStrip.terminalColor`)
                      : t(`terminal.terminalStrip.terminalIcon`)
            "
            @update:open="customize = undefined"
        >
            <template v-if="customize">
                <div v-if="customize.mode === 'color'" class="flex flex-wrap items-center gap-2">
                    <button
                        type="button"
                        :class="ui.addTile(`h-7 w-7 rounded-full text-subtle`)"
                        v-tooltip.top="t(`terminal.terminalPanel.default`)"
                        :aria-label="t(`terminal.terminalPanel.defaultColor`)"
                        @click="applyCustomize({ color: undefined })"
                    >
                        <Icon name="times" class="text-2xs" />
                    </button>
                    <button
                        v-for="[key, hex] in colorOptions"
                        :key="key"
                        type="button"
                        class="h-7 w-7 rounded-full transition-transform hover:scale-110"
                        :class="{ 'ring-2 ring-line-strong ring-offset-2 ring-offset-card': terminalMeta(customize.name).color === key }"
                        :style="{ background: hex }"
                        v-tooltip.top="key"
                        :aria-label="key"
                        @click="applyCustomize({ color: key })"
                    ></button>
                </div>
                <div v-else class="grid grid-cols-8 gap-1.5">
                    <button
                        type="button"
                        :class="ui.addTile(`h-8 w-8 text-subtle`)"
                        v-tooltip.top="t(`terminal.terminalPanel.default`)"
                        :aria-label="t(`terminal.terminalPanel.defaultIcon`)"
                        @click="applyCustomize({ icon: undefined })"
                    >
                        <Icon name="times" class="text-2xs" />
                    </button>
                    <button
                        v-for="icon in TERMINAL_ICONS"
                        :key="icon"
                        type="button"
                        :class="ui.iconButton(`h-8 w-8`, terminalMeta(customize.name).icon === icon ? `bg-overlay text-content` : ``)"
                        :aria-label="icon"
                        @click="applyCustomize({ icon })"
                    >
                        <Icon :name="icon" class="text-sm" />
                    </button>
                </div>
            </template>
        </Modal>
    </div>
</template>
