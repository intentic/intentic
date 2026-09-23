import type { IconName } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import type { MenuItem } from "primevue/menuitem";
import { computed, ref, type Ref, type VNode } from "vue";
import { commandShortcut } from "../../../shell/commands/useCommands";
import { setTerminalMeta, TERMINAL_COLORS, type TerminalColor, terminalMeta } from "../terminalMeta";
import { inactiveTerminals } from "../terminalSweep";
import type { TerminalTabs } from "../useTerminal";
import { showWorkTerminals } from "../useWorkTerminals";
import { hasWork, killAsks, killQuestion } from "./killPlan";
import { clearedLabel, iconFor, labelFor, stripIndex, tooltipFor } from "./stripSegments";
import { NO_SELECTION, type SelectionEvent, selects, type StripSelection, stepSelection } from "./stripSelection";

// The terminal panel's tab strip: one pill per split group and one segment per session, the selection over them, and
// every gesture a pill takes (kill, rename, colour, icon, split, join), each reachable from its context menu. A kill goes
// through `requestKill` whatever pressed it, so every route to it asks the same question (killPlan.ts).

export interface TerminalStripHost {
    readonly tabs: Pick<TerminalTabs, `order` | `groups` | `activeName` | `switchTab` | `joinTabs` | `unsplit` | `splitTab` | `killTabs`>;
    // Whether the panel is in a window of its own, and the gesture that moves it there and back.
    readonly floating: { readonly floats: Readonly<Ref<boolean>>; readonly toggle: () => void };
}

export const useTerminalStrip = ({ tabs, floating }: TerminalStripHost) => {
    const { order, groups, activeName, switchTab, joinTabs, unsplit, splitTab, killTabs } = tabs;
    const tabByName = computed(() => new Map(order.value.map((tab) => [tab.name, tab])));
    const positions = computed(() => stripIndex(groups.value));
    const segmentIcon = (name: string): IconName => iconFor(name, tabByName.value.get(name));
    const segmentLabel = (name: string): string => labelFor(name, tabByName.value.get(name), positions.value.get(name));
    const segmentTooltip = (name: string): string | undefined => tooltipFor(tabByName.value.get(name));
    const defaultLabel = (name: string): string => clearedLabel(tabByName.value.get(name), positions.value.get(name));
    const isBusy = (name: string): boolean => hasWork(tabByName.value.get(name));

    const selection = ref<StripSelection>(NO_SELECTION);
    const select = (event: SelectionEvent): void => {
        selection.value = stepSelection(selection.value, event);
    };
    const isSelected = (group: string[]): boolean => selects(selection.value, group);
    const selectedGroups = computed(() => groups.value.filter((group) => isSelected(group)));
    // Flattened in strip order, so a joined pane reads left to right as the strip did.
    const selectedNames = computed(() => selectedGroups.value.flat());
    const activeGroupIndex = computed(() => groups.value.findIndex((group) => activeName.value !== undefined && group.includes(activeName.value)));

    const onSegmentClick = (event: MouseEvent, groupIndex: number, name: string): void => {
        if (event.shiftKey) {
            select({ kind: `extend`, groups: groups.value, at: groupIndex, active: activeGroupIndex.value });
            return;
        }
        if (event.ctrlKey || event.metaKey) {
            select({ kind: `toggle`, groups: groups.value, at: groupIndex });
            return;
        }
        select({ kind: `activate`, at: groupIndex });
        switchTab(name);
    };

    const killable = computed(() => order.value.filter((tab) => tab.kind !== `process`).map((tab) => tab.name));
    // The sweep's clock, stamped when a menu opens or a sweep fires rather than ticked, so the count on the row and the
    // kill agree without a per-second redraw.
    const sweepNow = ref(Date.now());
    const inactive = computed(() => inactiveTerminals(order.value, { now: sweepNow.value, focused: activeName.value }));
    // The names a confirm dialog stands over: a busy session, or a bulk kill the gesture never named.
    const pendingKill = ref<string[]>();
    const killPrompt = computed(() => killQuestion(order.value, pendingKill.value ?? []));

    const requestKill = (names: string[]): void => {
        if (killTabs === undefined || names.length === 0) {
            return;
        }
        if (killAsks(order.value, names)) {
            pendingKill.value = names;
            return;
        }
        killTabs(names);
        select({ kind: `clear` });
    };
    const confirmKill = (): void => {
        const names = pendingKill.value;
        if (names !== undefined) {
            killTabs?.(names);
            select({ kind: `clear` });
        }
        pendingKill.value = undefined;
    };
    const sweepInactive = (): void => {
        if (killTabs === undefined) {
            return;
        }
        sweepNow.value = Date.now();
        const names = inactive.value.map((tab) => tab.name);
        if (names.length === 0) {
            return;
        }
        killTabs(names);
        select({ kind: `clear` });
    };

    // A pill's label edits in place, like a chat tab: Enter commits, Esc cancels, blur commits, and an empty name
    // resets to the default.
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
        if (name === undefined) {
            return;
        }
        const trimmed = renameDraft.value.trim();
        setTerminalMeta(name, { label: trimmed === `` ? undefined : trimmed });
    };
    const cancelRename = (): void => {
        renamingName.value = undefined;
    };
    // Focuses and selects the field the moment it mounts (`@vue:mounted`).
    const focusRename = (vnode: VNode): void => {
        const el = vnode.el as HTMLInputElement;
        el.focus();
        el.select();
    };
    // A middle-click is the pill's × pressed, and does nothing where the strip offers no kill or the pill is being renamed.
    const middleKill = (name: string): void => {
        if (killTabs !== undefined && renamingName.value !== name) {
            requestKill([name]);
        }
    };

    // Colour and icon overrides live in a dialog: a swatch grid is a picker, with nowhere to sit in a pill.
    const customize = ref<{ name: string; mode: `color` | `icon` } | undefined>(undefined);
    const openCustomize = (name: string, mode: `color` | `icon`): void => {
        customize.value = { name, mode };
    };
    const applyColor = (color: TerminalColor | undefined): void => {
        if (customize.value === undefined) {
            return;
        }
        setTerminalMeta(customize.value.name, { color });
        customize.value = undefined;
    };
    const applyIcon = (icon: IconName | undefined): void => {
        if (customize.value === undefined) {
            return;
        }
        setTerminalMeta(customize.value.name, { icon });
        customize.value = undefined;
    };
    const colorOptions = Object.entries(TERMINAL_COLORS) as [TerminalColor, string][];
    const customizeHeader = computed(() =>
        customize.value === undefined ? `` : { color: `Terminal color`, icon: `Terminal icon` }[customize.value.mode],
    );

    const menu = ref<{ show: (event: Event) => void } | undefined>();
    // The pill a right-click landed on; undefined for empty bar space, whose menu is the strip-wide rows alone.
    const menuTarget = ref<{ groupIndex: number; name: string } | undefined>(undefined);
    const openTabMenu = (event: MouseEvent, groupIndex: number, name: string): void => {
        sweepNow.value = Date.now();
        select({ kind: `retarget`, groups: groups.value, at: groupIndex });
        menuTarget.value = { groupIndex, name };
        menu.value?.show(event);
    };
    const onBarContextMenu = (event: MouseEvent): void => {
        if (event.target instanceof Element && event.target.closest(`button, [data-term-tab]`) !== null) {
            return;
        }
        event.preventDefault();
        sweepNow.value = Date.now();
        menuTarget.value = undefined;
        menu.value?.show(event);
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

    // Mass actions for a selection of several groups.
    const selectionItems = (): MenuItem[] => {
        const names = selectedNames.value;
        const join: MenuItem = {
            label: t(`terminal.terminalPanel.joinTabs`, { count: selectedGroups.value.length }),
            shortcut: commandShortcut(`terminal.join`),
            command: () => {
                joinTabs(names);
                select({ kind: `clear` });
            },
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
                ? [
                      {
                          label: t(`terminal.terminalPanel.unsplitTerminal`),
                          shortcut: commandShortcut(`terminal.unsplit`),
                          command: () => unsplit(name),
                      },
                  ]
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
                label: tabByName.value.get(name)?.kind === `process` ? `Close log view` : `Kill terminal`,
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

    // Walks every session in reading order, splits included, wrapping at the ends.
    const cycleTab = (delta: number): void => {
        const names = groups.value.flat();
        if (names.length < 2) {
            return;
        }
        const next = names[(names.indexOf(activeName.value ?? ``) + delta + names.length) % names.length];
        if (next !== undefined) {
            switchTab(next);
        }
    };

    // Joins the selection when it spans more than one group; a mass action leaves nothing selected.
    const joinSelected = (): void => {
        if (selectedGroups.value.length > 1) {
            joinTabs(selectedNames.value);
            select({ kind: `clear` });
        }
    };

    return {
        tabByName,
        segmentIcon,
        segmentLabel,
        segmentTooltip,
        defaultLabel,
        isBusy,
        isSelected,
        selectedNames,
        activeGroupIndex,
        onSegmentClick,
        killable,
        pendingKill,
        killPrompt,
        requestKill,
        confirmKill,
        sweepInactive,
        renamingName,
        renameDraft,
        beginRename,
        commitRename,
        cancelRename,
        focusRename,
        middleKill,
        customize,
        openCustomize,
        applyColor,
        applyIcon,
        colorOptions,
        customizeHeader,
        menu,
        menuItems,
        openTabMenu,
        onBarContextMenu,
        cycleTab,
        joinSelected,
    };
};

export type TerminalStrip = ReturnType<typeof useTerminalStrip>;
