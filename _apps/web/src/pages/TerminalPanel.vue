<script setup lang="ts">
import { type IconName, useDevice } from "@intentic-app/ui";
import ContextMenu from "primevue/contextmenu";
import Dialog from "primevue/dialog";
import type { MenuItem } from "primevue/menuitem";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import BackgroundProcesses from "../components/BackgroundProcesses.vue";
import { setTerminalMeta, TERMINAL_COLORS, TERMINAL_ICONS, type TerminalColor, terminalMeta } from "../composables/terminal/terminalMeta";
import { createTerminalTabs, type TerminalTab, type TerminalTabsSource } from "../composables/terminal/useTerminal";
import { useTerminalPopout } from "../composables/terminal/useTerminalPopout";

/* THE terminal panel — mounted once in the shell, below every view. Each tab is a tmux-backed session in the
 * shared cache (composables/useTerminal): mounting re-appends the active tab's persistent host element,
 * unmounting only detaches it, so scrollback and running processes survive collapse, navigation, and reload.
 * Tabs arrange into split GROUPS (useTerminal.groups): one pill per group, one segment per session; the
 * active group's sessions render side by side in the pane. The strip is a VSCode-style list: Shift/Ctrl+click
 * multi-selects pills, right-click opens the action menu (split / join / unsplit / kill, and per-terminal
 * rename / color / icon overrides from terminalMeta). Right-click on the bar's empty space pops the whole
 * panel out into a floating window (Document PiP, like the chat strip); the shell owns the teleport.
 * Every tab gets the hover-×; restart is shell-only (a dev-server tab is re-run via Start, or ↑ at its
 * prompt). Managed background processes (extension gateways, dockerd) never tab by themselves — they live in
 * the toolbar's processes popover, and their × only hides the read-only log view. `initial` is an object so
 * re-requesting the same session still refocuses. Height and collapse persist per storageKey;
 * `resizable: false` pins the panel to its container (the mobile route, and the pop-out window). */

const {
    source,
    storageKey,
    initial,
    surfaced,
    resizable = true,
} = defineProps<{
    source: TerminalTabsSource;
    storageKey: string;
    initial?: { readonly name: string };
    // A session to relist as a tab without focusing it (the agent's live terminal — appears without hijacking
    // the active tab). Distinct from `initial`, which focuses.
    surfaced?: { readonly name: string };
    resizable?: boolean;
}>();
const emit = defineEmits<{ close: [] }>();

const tabs = createTerminalTabs(source, storageKey, () => emit(`close`));
const { order, groups, activeName, switchTab, joinTabs, unsplit, newTab, closeTab, splitTab, killTabs, restart } = tabs;
// Restart kills the active session and opens a fresh web-* shell in its slot — meaningless for a dev-server
// tab, which gets refresh instead.
const activeShell = computed(() => order.value.find((tab) => tab.name === activeName.value)?.kind === `shell`);
const popout = useTerminalPopout();
// Teleporting the panel to/from the pip window moves the container wholesale without any Vue re-mount —
// remount the active group after the flush so every cell refits (and the PTYs resync) at the new window's size.
watch(
    popout.poppedOut,
    () => {
        if (activeName.value !== undefined) {
            switchTab(activeName.value);
        }
    },
    { flush: `post` },
);

// --- Tab strip: segments, numbering, cosmetics ------------------------------------------------
const tabByName = computed(() => new Map(order.value.map((tab) => [tab.name, tab])));
// Unlabeled shells show their 1-based position in the strip's reading order (across groups).
const stripIndex = computed(() => {
    const index = new Map<string, number>();
    let position = 0;
    for (const group of groups.value) {
        for (const name of group) {
            position += 1;
            index.set(name, position);
        }
    }
    return index;
});
const KIND_ICONS: Record<TerminalTab[`kind`], IconName> = { agent: `sparkles`, job: `bolt`, process: `cog`, shell: `desktop`, panel: `desktop` };
const segmentIcon = (name: string): IconName => terminalMeta(name).icon ?? KIND_ICONS[tabByName.value.get(name)?.kind ?? `shell`];
const segmentColor = (name: string): string | undefined => {
    const color = terminalMeta(name).color;
    return color === undefined ? undefined : TERMINAL_COLORS[color];
};
const segmentLabel = (name: string): string =>
    terminalMeta(name).label ?? tabByName.value.get(name)?.label ?? String(stripIndex.value.get(name) ?? ``);
const segmentTooltip = (name: string): string | undefined => {
    const tab = tabByName.value.get(name);
    if (tab === undefined) {
        return undefined;
    }
    if (tab.kind === `agent`) {
        return `AI terminal`;
    }
    if (tab.kind === `job`) {
        return `Job terminal`;
    }
    if (tab.kind === `process`) {
        return `Background process — read-only logs`;
    }
    return tab.running === false ? `finished` : undefined;
};

// --- Multi-selection (VSCode's terminal list): Shift extends, Ctrl toggles, plain click activates ----------
// Selection is per-GROUP (pills), keyed by each group's first session name; it only feeds the context menu's
// mass actions (join / kill), so any structural change just clears it.
const selectedKeys = ref<string[]>([]);
const anchor = ref<number | undefined>(undefined);
const groupKey = (group: string[]): string => group[0] ?? ``;
const isSelected = (group: string[]): boolean => selectedKeys.value.includes(groupKey(group));
const selectedGroups = computed(() => groups.value.filter((group) => isSelected(group)));
// Flattened in strip order, so joined panes read the same left-to-right as the strip did.
const selectedNames = computed(() => selectedGroups.value.flat());
const activeGroupIndex = computed(() => groups.value.findIndex((group) => activeName.value !== undefined && group.includes(activeName.value)));

const onSegmentClick = (event: MouseEvent, groupIndex: number, name: string): void => {
    if (event.shiftKey) {
        const from = anchor.value ?? (activeGroupIndex.value === -1 ? groupIndex : activeGroupIndex.value);
        const [lo, hi] = from < groupIndex ? [from, groupIndex] : [groupIndex, from];
        selectedKeys.value = groups.value.slice(lo, hi + 1).map(groupKey);
        return;
    }
    if (event.ctrlKey || event.metaKey) {
        const key = groupKey(groups.value[groupIndex] ?? []);
        selectedKeys.value = isSelected(groups.value[groupIndex] ?? []) ? selectedKeys.value.filter((k) => k !== key) : [...selectedKeys.value, key];
        anchor.value = groupIndex;
        return;
    }
    selectedKeys.value = [];
    anchor.value = groupIndex;
    switchTab(name);
};

// --- Rename / color / icon (per-terminal overrides, terminalMeta) ------------------------------
const customize = ref<{ name: string; mode: `rename` | `color` | `icon` } | undefined>(undefined);
const renameInput = ref(``);
const openCustomize = (name: string, mode: `rename` | `color` | `icon`): void => {
    renameInput.value = terminalMeta(name).label ?? ``;
    customize.value = { name, mode };
};
const applyRename = (): void => {
    if (customize.value === undefined) {
        return;
    }
    const trimmed = renameInput.value.trim();
    setTerminalMeta(customize.value.name, { label: trimmed === `` ? undefined : trimmed });
    customize.value = undefined;
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
const customizeHeader = computed(() => {
    if (customize.value === undefined) {
        return ``;
    }
    return { rename: `Rename terminal`, color: `Terminal color`, icon: `Terminal icon` }[customize.value.mode];
});
// The default label shown as the rename placeholder — clearing the input returns to it.
const customizeFallback = computed(() => {
    const name = customize.value?.name;
    if (name === undefined) {
        return ``;
    }
    return tabByName.value.get(name)?.label ?? `Terminal ${stripIndex.value.get(name) ?? ``}`;
});

// --- Context menu (right-click a pill) ---------------------------------------------------------
const menu = ref<{ show: (event: Event) => void } | undefined>();
const menuTarget = ref<{ groupIndex: number; name: string } | undefined>(undefined);
const openTabMenu = (event: MouseEvent, groupIndex: number, name: string): void => {
    const group = groups.value[groupIndex] ?? [];
    // Right-click outside the current selection retargets it (VSCode's list behavior).
    if (!isSelected(group)) {
        selectedKeys.value = [groupKey(group)];
        anchor.value = groupIndex;
    }
    menuTarget.value = { groupIndex, name };
    menu.value?.show(event);
};

const menuItems = computed<MenuItem[]>(() => {
    const target = menuTarget.value;
    if (target === undefined) {
        return [];
    }
    const { name } = target;
    const group = groups.value[target.groupIndex] ?? [name];
    // A multi-selection gets the mass actions; a single pill gets the per-terminal ones.
    if (selectedGroups.value.length > 1) {
        const names = selectedNames.value;
        const items: MenuItem[] = [
            {
                label: `Join ${selectedGroups.value.length} tabs`,
                command: () => {
                    joinTabs(names);
                    selectedKeys.value = [];
                },
            },
        ];
        if (killTabs !== undefined) {
            items.push(
                { separator: true },
                {
                    label: `Kill ${names.length} terminals`,
                    command: () => {
                        killTabs(names);
                        selectedKeys.value = [];
                    },
                },
            );
        }
        return items;
    }
    const items: MenuItem[] = [];
    if (splitTab !== undefined) {
        items.push({ label: `Split terminal`, command: () => splitTab(name) });
    }
    if (group.length > 1) {
        items.push({ label: `Unsplit terminal`, command: () => unsplit(name) });
    }
    if (items.length > 0) {
        items.push({ separator: true });
    }
    items.push(
        { label: `Rename…`, command: () => openCustomize(name, `rename`) },
        { label: `Change color…`, command: () => openCustomize(name, `color`) },
        { label: `Change icon…`, command: () => openCustomize(name, `icon`) },
    );
    if (closeTab !== undefined) {
        items.push(
            { separator: true },
            { label: tabByName.value.get(name)?.kind === `process` ? `Close log view` : `Kill terminal`, command: () => closeTab(name) },
        );
    }
    if (popout.supported) {
        items.push({ separator: true }, { label: popout.poppedOut.value ? `Dock panel back` : `Move panel into new window`, command: popout.toggle });
    }
    return items;
});

// Right-click on the bar's EMPTY space (not a pill, not a button) pops the panel out / docks it — the same
// gesture the chat strip uses.
const onBarContextMenu = (event: MouseEvent): void => {
    if (!popout.supported || (event.target instanceof Element && event.target.closest(`button, .tterm`) !== null)) {
        return;
    }
    event.preventDefault();
    popout.toggle();
};

// --- Touch extra-keys row --------------------------------------------------------------------
// A soft keyboard has no Esc/Tab/Ctrl/arrows; on coarse pointers a scrollable row supplies them, injecting
// escape sequences straight into the active session. Desktop never renders it.
const { coarse } = useDevice();

// The control code for a printable char (c → \x03, d → \x04, …); non-letters pass through.
const controlCode = (ch: string): string => {
    const code = ch.toUpperCase().charCodeAt(0);
    return code >= 64 && code <= 95 ? String.fromCharCode(code - 64) : ch;
};

// Ctrl is sticky: arm it, then the next printable keydown (from the soft keyboard) is sent as its control code
// — the only reliable way to reach Ctrl+C/D/Z without a physical modifier. Best-effort: some Android keyboards
// emit no usable keydown, in which case Ctrl just disarms on the next tap. ponytail: no visual affordance for
// which key it will modify beyond the armed tint.
const ctrlArmed = ref(false);
const onArmedKeydown = (event: KeyboardEvent): void => {
    if (event.key.length !== 1) {
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    tabs.sendInput(controlCode(event.key));
    ctrlArmed.value = false;
};
watch(ctrlArmed, (armed) => {
    if (armed) {
        window.addEventListener(`keydown`, onArmedKeydown, true);
    } else {
        window.removeEventListener(`keydown`, onArmedKeydown, true);
    }
});

const EXTRA_KEYS: readonly { label: string; data: string }[] = [
    { label: `Esc`, data: `\x1b` },
    { label: `Tab`, data: `\t` },
    { label: `/`, data: `/` },
    { label: `-`, data: `-` },
    { label: `|`, data: `|` },
    { label: `~`, data: `~` },
    { label: `↑`, data: `\x1b[A` },
    { label: `↓`, data: `\x1b[B` },
    { label: `←`, data: `\x1b[D` },
    { label: `→`, data: `\x1b[C` },
];
// pointerdown (not click) with preventDefault: keep the xterm textarea focused so the soft keyboard stays up.
const pressKey = (data: string): void => tabs.sendInput(data);

// Panel geometry, persisted per surface (maximized deliberately isn't — restoring a full-screen terminal
// across reloads would be hostile). Height is clamped to a floor and ~80% of the viewport.
const HEIGHT_KEY = `ui-${storageKey}-terminal-height`;
const COLLAPSED_KEY = `ui-${storageKey}-terminal-collapsed`;
const DEFAULT_HEIGHT = 240;
const MIN_HEIGHT = 96;
const clampHeight = (px: number): number => Math.round(Math.max(MIN_HEIGHT, Math.min(px, window.innerHeight * 0.8)));
const readHeight = (): number => {
    try {
        const parsed = Number.parseInt(localStorage.getItem(HEIGHT_KEY) ?? ``, 10);
        return Number.isFinite(parsed) ? clampHeight(parsed) : DEFAULT_HEIGHT;
    } catch {
        return DEFAULT_HEIGHT;
    }
};
const readCollapsed = (): boolean => {
    try {
        return localStorage.getItem(COLLAPSED_KEY) === `1`;
    } catch {
        return false;
    }
};
const write = (key: string, value: string): void => {
    try {
        localStorage.setItem(key, value);
    } catch {
        // Storage may be unavailable (private mode); the in-memory ref still holds.
    }
};

const height = ref(readHeight());
const collapsed = ref(readCollapsed());
// A fixed surface (the mobile route, the pop-out window) has no collapse chevron, so honoring a collapsed
// flag persisted from the docked panel would strand an empty pane there — ignore it while !resizable.
const effectiveCollapsed = computed(() => collapsed.value && resizable);
// Modeled so a parent can react (the workspace hides its file viewer while the panel is maximized).
const maximized = defineModel<boolean>(`maximized`, { default: false });
const setHeight = (px: number): void => {
    height.value = clampHeight(px);
    write(HEIGHT_KEY, String(height.value));
};
const setCollapsed = (value: boolean): void => {
    collapsed.value = value;
    write(COLLAPSED_KEY, value ? `1` : `0`);
};

const root = ref<HTMLElement>();
const container = ref<HTMLElement>();

onMounted(async () => {
    if (container.value !== undefined) {
        await tabs.attach(container.value);
    }
    if (initial !== undefined) {
        await tabs.focus(initial.name);
    }
});
onBeforeUnmount(() => {
    tabs.detach();
    window.removeEventListener(`keydown`, onArmedKeydown, true);
});
// A parent-driven focus request (a row's terminal button while the panel is already open) — a fresh object per
// request, so the same session refocuses too.
watch(
    () => initial,
    (request) => {
        if (request !== undefined) {
            void tabs.focus(request.name);
        }
    },
);
// A parent-driven surface request (the agent started running Bash) — relist so the tab appears, without
// focusing it. Only meaningful while the panel is mounted; a closed panel lists the session on its next open.
watch(
    () => surfaced,
    (request) => {
        if (request !== undefined) {
            void tabs.surface(request.name);
        }
    },
);

const resizing = ref(false);
// The panel's bottom viewport offset, captured at drag start — its height is the pointer's distance above it.
let panelBottom = 0;

const startResize = (event: PointerEvent): void => {
    event.preventDefault();
    panelBottom = root.value?.getBoundingClientRect().bottom ?? 0;
    resizing.value = true;
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
};

const onResize = (event: PointerEvent): void => {
    if (!resizing.value) {
        return;
    }
    setHeight(panelBottom - event.clientY);
};

const endResize = (event: PointerEvent): void => {
    if (!resizing.value) {
        return;
    }
    resizing.value = false;
    const target = event.target as HTMLElement;
    if (target.hasPointerCapture(event.pointerId)) {
        target.releasePointerCapture(event.pointerId);
    }
};
</script>

<template>
    <div
        ref="root"
        class="term relative flex min-h-0 shrink-0 flex-col border-t border-line"
        :class="{ 'is-resizing': resizing, 'flex-1': resizable && maximized && !collapsed, 'h-full': !resizable }"
        :style="!resizable || maximized || collapsed ? undefined : { height: `${height}px` }"
    >
        <div
            v-if="resizable && !maximized && !collapsed"
            class="term-resize"
            @pointerdown="startResize"
            @pointermove="onResize"
            @pointerup="endResize"
            @dblclick="setHeight(DEFAULT_HEIGHT)"
            title="Drag to resize · double-click to reset"
        ></div>
        <div class="flex shrink-0 items-center gap-1 border-b border-line bg-card px-2 py-0.5" @contextmenu="onBarContextMenu">
            <!-- One pill per split GROUP, one segment per tmux session, styled like the editor's FileTabs: glyph
                 (kind icon or the user's override, tinted by their color), label (or index), and — when the
                 source manages sessions — a small × that appears on hover. Click switches (and focuses the
                 clicked split); Shift/Ctrl+click multi-selects pills for the right-click mass actions; × kills
                 that session; + opens a new one. A dimmed segment is an untracked session (a finished one-shot
                 job's lingering shell, output in scrollback). Hidden while collapsed so the collapsed bar stays
                 a single clean line (the chevron expands). -->
            <div v-if="!effectiveCollapsed" class="scrollbar-thin flex min-w-0 items-center gap-0.5 overflow-x-auto">
                <div
                    v-for="(group, gi) in groups"
                    :key="groupKey(group)"
                    class="tterm group flex h-6 shrink-0 cursor-pointer select-none items-center rounded-md"
                    :class="{ 'tterm-on': gi === activeGroupIndex, 'tterm-selected': isSelected(group) }"
                >
                    <template v-for="(name, si) in group" :key="name">
                        <span v-if="si > 0" class="h-3.5 w-px shrink-0 bg-line"></span>
                        <div
                            class="flex h-full items-center gap-1.5 pl-2 pr-1.5 text-2xs"
                            :class="{ 'opacity-60': tabByName.get(name)?.running === false }"
                            v-tooltip.top="segmentTooltip(name)"
                            @click="onSegmentClick($event, gi, name)"
                            @contextmenu.prevent.stop="openTabMenu($event, gi, name)"
                        >
                            <Icon
                                :name="segmentIcon(name)"
                                class="text-2xs"
                                :class="
                                    segmentColor(name) === undefined
                                        ? tabByName.get(name)?.kind === 'agent'
                                            ? 'text-link'
                                            : 'text-muted'
                                        : undefined
                                "
                                :style="segmentColor(name) === undefined ? undefined : { color: segmentColor(name) }"
                            />
                            <span>{{ segmentLabel(name) }}</span>
                            <span
                                v-if="closeTab !== undefined"
                                class="relative flex h-3 w-3 shrink-0 items-center justify-center"
                                @click.stop="closeTab(name)"
                                aria-label="Close tab"
                            >
                                <Icon
                                    name="times"
                                    class="absolute rounded text-[0.6rem] opacity-0 transition-opacity hover:text-content group-hover:opacity-60"
                                />
                            </span>
                        </div>
                    </template>
                </div>
                <button
                    v-if="newTab !== undefined"
                    type="button"
                    class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-overlay hover:text-content"
                    @click="newTab()"
                    v-tooltip.top="'New terminal'"
                    aria-label="New terminal"
                >
                    <Icon name="plus" class="text-2xs" />
                </button>
            </div>
            <span class="flex-1"></span>
            <BackgroundProcesses :tabs="tabs" />
            <button
                v-if="restart !== undefined && activeShell"
                type="button"
                class="flex h-6 w-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-overlay hover:text-content"
                @click="restart()"
                v-tooltip.top="'Restart shell'"
                aria-label="Restart shell"
            >
                <Icon name="refresh" class="text-xs" />
            </button>
            <button
                v-else
                type="button"
                class="flex h-6 w-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-overlay hover:text-content"
                @click="void tabs.refresh()"
                v-tooltip.top="'Refresh sessions'"
                aria-label="Refresh sessions"
            >
                <Icon name="refresh" class="text-xs" />
            </button>
            <button
                v-if="resizable"
                type="button"
                class="flex h-6 w-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-overlay hover:text-content"
                @click="maximized = !maximized"
                v-tooltip.top="maximized ? 'Restore panel size' : 'Maximize panel'"
                aria-label="Toggle maximize"
            >
                <Icon class="text-xs" :name="maximized ? 'window-minimize' : 'window-maximize'" />
            </button>
            <button
                v-if="resizable"
                type="button"
                class="flex h-6 w-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-overlay hover:text-content"
                @click="setCollapsed(!collapsed)"
                v-tooltip.top="collapsed ? 'Expand terminal' : 'Collapse terminal'"
                :aria-label="collapsed ? 'Expand terminal' : 'Collapse terminal'"
            >
                <Icon class="text-xs" :name="collapsed ? 'chevron-up' : 'chevron-down'" />
            </button>
            <button
                type="button"
                class="flex h-6 w-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-overlay hover:text-content"
                @click="emit(`close`)"
                aria-label="Close terminal"
            >
                <Icon name="times" class="text-xs" />
            </button>
        </div>
        <!-- xterm sizes to this container; FitAddon + a ResizeObserver keep each cell filling its share of the
             pane (useTerminal's mount builds one .term-cell per split). v-show (not v-if) keeps xterm open()'d
             and the shell alive while collapsed — it refits when shown again. -->
        <div v-show="!effectiveCollapsed" ref="container" class="term-body flex min-h-0 flex-1 bg-terminal p-2"></div>
        <!-- Touch extra-keys row (coarse pointers only). pointerdown.prevent keeps the terminal focused so the
             soft keyboard stays up while the key is injected. -->
        <div
            v-if="coarse && !effectiveCollapsed"
            class="scrollbar-thin flex shrink-0 items-center gap-1 overflow-x-auto border-t border-line bg-card px-1.5 py-1.5"
        >
            <button type="button" class="termkey" :class="{ 'termkey-on': ctrlArmed }" @pointerdown.prevent="ctrlArmed = !ctrlArmed">Ctrl</button>
            <button v-for="key in EXTRA_KEYS" :key="key.label" type="button" class="termkey" @pointerdown.prevent="pressKey(key.data)">
                {{ key.label }}
            </button>
        </div>

        <!-- Right-click pill menu: split/join/unsplit/kill + the per-terminal cosmetic overrides. Rendered into
             the pop-out window while the panel floats there. -->
        <ContextMenu
            ref="menu"
            :model="menuItems"
            :append-to="popout.overlayTarget.value"
            :pt="{ root: '!min-w-52 !text-xs', rootList: '!p-1', itemLink: '!rounded !px-2 !py-1 !text-xs', separator: '!my-1' }"
        />

        <!-- One dialog for rename / color / icon. Rename applies on Enter (empty resets to the default label);
             color and icon apply on click, with a leading "default" swatch that clears the override. -->
        <Dialog
            :visible="customize !== undefined"
            :modal="true"
            :draggable="false"
            :dismissable-mask="true"
            :append-to="popout.overlayTarget.value"
            :style="{ width: '22rem' }"
            :header="customizeHeader"
            @update:visible="customize = undefined"
        >
            <template v-if="customize">
                <input
                    v-if="customize.mode === 'rename'"
                    v-model="renameInput"
                    type="text"
                    :placeholder="customizeFallback"
                    class="w-full rounded-md border border-line bg-canvas px-2 py-1 text-xs text-content placeholder:text-subtle focus:border-line-strong focus:outline-none"
                    @keydown.enter="applyRename"
                    autofocus
                />
                <div v-else-if="customize.mode === 'color'" class="flex flex-wrap items-center gap-2">
                    <button
                        type="button"
                        class="flex h-7 w-7 items-center justify-center rounded-full border border-dashed border-line text-subtle transition-colors hover:border-line-strong hover:text-content"
                        v-tooltip.top="'Default'"
                        aria-label="Default color"
                        @click="applyColor(undefined)"
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
                        @click="applyColor(key)"
                    ></button>
                </div>
                <div v-else class="grid grid-cols-8 gap-1.5">
                    <button
                        type="button"
                        class="flex h-8 w-8 items-center justify-center rounded-md border border-dashed border-line text-subtle transition-colors hover:border-line-strong hover:text-content"
                        v-tooltip.top="'Default'"
                        aria-label="Default icon"
                        @click="applyIcon(undefined)"
                    >
                        <Icon name="times" class="text-2xs" />
                    </button>
                    <button
                        v-for="icon in TERMINAL_ICONS"
                        :key="icon"
                        type="button"
                        class="flex h-8 w-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-overlay hover:text-content"
                        :class="{ 'bg-overlay text-content': terminalMeta(customize.name).icon === icon }"
                        :aria-label="icon"
                        @click="applyIcon(icon)"
                    >
                        <Icon :name="icon" class="text-sm" />
                    </button>
                </div>
                <div v-if="customize.mode === 'rename'" class="mt-3 flex justify-end gap-2">
                    <button
                        type="button"
                        class="rounded-md px-2.5 py-1 text-xs text-muted transition-colors hover:bg-overlay hover:text-content"
                        @click="customize = undefined"
                    >
                        Cancel
                    </button>
                    <button
                        type="button"
                        class="rounded-md bg-primary-600/15 px-2.5 py-1 text-xs font-medium text-link transition-colors hover:bg-primary-600/25"
                        @click="applyRename"
                    >
                        Rename
                    </button>
                </div>
            </template>
        </Dialog>
    </div>
</template>

<style scoped>
/* Drag-to-resize handle on the panel's top edge (pointer-capture, mirrors Workspace's .ws-resize). */
.term-resize {
    position: absolute;
    inset: -3px 0 auto 0;
    height: 6px;
    cursor: row-resize;
    z-index: 20;
    touch-action: none;
    transition: background-color 0.15s;
}
.term-resize:hover,
.term.is-resizing .term-resize {
    background: color-mix(in srgb, var(--color-primary-500) 35%, transparent);
}
.term.is-resizing {
    user-select: none;
}

/* Terminal tab pill — mirrors FileTabs' .ftab muted→hover→active progression, kept rounded to sit among the
   toolbar's other rounded-md buttons. Selected (Shift/Ctrl+click) tints toward primary so a multi-selection
   reads at a glance without fighting the active pill's overlay. */
.tterm {
    color: var(--color-muted);
    transition:
        background-color 0.15s,
        color 0.15s;
}
.tterm:hover {
    background: color-mix(in srgb, var(--color-content) 6%, transparent);
    color: var(--color-content);
}
.tterm-on {
    background: var(--color-overlay);
    color: var(--color-content);
}
.tterm-selected {
    background: color-mix(in srgb, var(--color-primary-500) 14%, transparent);
    color: var(--color-content);
}

/* Split cells (built by useTerminal's mount — plain elements, hence :deep): equal flex columns with a hairline
   between, and a top accent on the focused pane so keystroke routing is visible in a split. */
.term-body :deep(.term-cell) {
    display: flex;
    flex: 1 1 0;
    min-width: 0;
    min-height: 0;
}
.term-body :deep(.term-cell + .term-cell) {
    border-left: 1px solid var(--color-line);
    margin-left: 0.5rem;
    padding-left: 0.5rem;
}
.term-body.term-split :deep(.term-cell:focus-within) {
    box-shadow: inset 0 2px 0 0 color-mix(in srgb, var(--color-primary-500) 55%, transparent);
}

/* Touch extra-keys: 40px min targets, monospace glyphs, armed-Ctrl tint. */
.termkey {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 2.5rem;
    height: 2.25rem;
    padding: 0 0.6rem;
    flex-shrink: 0;
    border-radius: var(--radius-md);
    border: 1px solid var(--color-line);
    background: var(--color-canvas);
    color: var(--color-content);
    font-family: var(--font-mono, ui-monospace, monospace);
    font-size: 0.8125rem;
}
.termkey:active {
    background: var(--color-overlay);
}
.termkey-on {
    border-color: color-mix(in srgb, var(--color-primary-500) 60%, transparent);
    background: color-mix(in srgb, var(--color-primary-500) 16%, transparent);
    color: var(--color-primary-500);
}
</style>
