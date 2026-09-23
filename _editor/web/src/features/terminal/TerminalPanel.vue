<script setup lang="ts">
import { Button, ConfirmDialog, ContextMenu, Icon, Modal, ResizeSeam, ui, useDevice, vMiddleclick } from "@intentic/ui";
import type { Disposable } from "@intentic/extension-api";
import { useT } from "@intentic/ui/i18n";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { TERMINAL } from "../../shell/commands/categories";
import { registerCommand, withShortcut } from "../../shell/commands/useCommands";
import { postTurnControl } from "../chat/run/turnStream";
import { useSandbox } from "../sandbox/client/useSandbox";
import BackgroundProcesses from "./BackgroundProcesses.vue";
import WorkTerminals from "./WorkTerminals.vue";
import { TERMINAL_ICONS, terminalMeta } from "./terminalMeta";
import { useTerminalFloating } from "./terminalFloating";
import { fetchScrollback } from "./terminalScrollback";
import { useTerminalsQuery } from "./terminalsQuery";
import { createTerminalTabs, type TerminalTabsSource, terminalSessionOf } from "./useTerminal";
import { clearTerminalRequest, consumeSpawnRequest, registerTerminalSpawn, type TerminalRequest } from "./useTerminalPanel";
import { panelCommands } from "./panel/panelCommands";
import { segmentColor } from "./panel/stripSegments";
import { groupKey } from "./panel/stripSelection";
import { DEFAULT_HEIGHT, MIN_HEIGHT, usePanelHeight } from "./panel/usePanelHeight";
import { usePanelWait } from "./panel/usePanelWait";
import { useScrollbackView } from "./panel/useScrollbackView";
import { useTerminalFind } from "./panel/useTerminalFind";
import { useTerminalHelp } from "./panel/useTerminalHelp";
import { useTerminalStrip } from "./panel/useTerminalStrip";
import { useTouchKeys } from "./panel/useTouchKeys";

// Terminal panel, mounted once below every view: each tab is a tmux session in the shared cache, so scrollback survives
// unmount, navigation and reload. Template and wiring over ./panel: the strip and its selection, find, the scrollback
// view, the touch keys, the handover ask and the empty panel's wait; poppable into its own window, bar on the left edge.

const t = useT();

const {
    source,
    storageKey,
    initial,
    surfaced,
    resizable = true,
} = defineProps<{
    source: TerminalTabsSource;
    storageKey: string;
    initial?: TerminalRequest;
    // Session to relist as a tab without focusing it (the agent's live terminal); distinct from `initial`.
    surfaced?: { readonly name: string };
    resizable?: boolean;
}>();
const emit = defineEmits<{ close: [] }>();

const tabs = createTerminalTabs(source, storageKey, () => emit(`close`));
const { order, groups, answer, activeName, pending, unsplit, newTab, splitTab, killTabs, restart } = tabs;

// Skeleton of the strip's last-known shape while its list is in flight: unlabelled and inert, since which terminals
// return is the daemon's to say. Capped so a heavily split sandbox does not spend rows on decoration.
const PLACEHOLDER_LIMIT = 6;
const placeholders = computed(() => (answer.value === `waiting` && groups.value.length === 0 ? tabs.remembered.value.slice(0, PLACEHOLDER_LIMIT) : []));
// Whether Restart applies: a fresh shell replaces a killed one, which means nothing for a dev-server tab.
const activeShell = computed(() => order.value.find((tab) => tab.name === activeName.value)?.kind === `shell`);
const floating = useTerminalFloating();
// The bar becomes a left rail while the panel has a window of its own.
const vertical = computed(() => floating.here.value);
const floatHint = computed(() => withShortcut(floating.floats.value ? `Dock panel back` : `Move panel into new window`, `terminal.toggleFloating`));
// Dismissal, not a kill: sessions outlive every view; docked it hides the panel, floating it closes the window.
const closeHint = computed(() =>
    withShortcut(floating.here.value ? `Close the window, the terminals keep running` : `Hide the panel, the terminals keep running`, `terminal.toggle`),
);

// Sessions can finish with no client action; watching the shared list catches what imperative relists miss. A dropped
// refresh is the strip's own to retry, and nothing here awaits it.
const listed = useTerminalsQuery();
watch(
    () => listed.sessions.value.map((session) => `${session.name}:${session.running}`).join(`\n`),
    () => void tabs.refresh().catch(() => undefined),
);
// Reachability regained catches an outage longer than the refused-list retries cover: an unreachable daemon reports no
// session change at all.
watch(useSandbox().reachable, (isReachable) => {
    if (isReachable) {
        void tabs.refresh().catch(() => undefined);
    }
});

const { help, helpNote, resolveHelp } = useTerminalHelp({
    sessions: listed.sessions,
    activeName,
    reply: (body) => postTurnControl(undefined, `reply`, body),
});
const strip = useTerminalStrip({ tabs, floating });
const {
    tabByName,
    segmentIcon,
    segmentLabel,
    segmentTooltip,
    defaultLabel,
    isBusy,
    isSelected,
    activeGroupIndex,
    onSegmentClick,
    pendingKill,
    killPrompt,
    requestKill,
    confirmKill,
    renamingName,
    renameDraft,
    beginRename,
    commitRename,
    cancelRename,
    focusRename,
    middleKill,
    customize,
    applyColor,
    applyIcon,
    colorOptions,
    customizeHeader,
    menu,
    menuItems,
    openTabMenu,
    onBarContextMenu,
} = strip;
const { scrollbackName, scrollback, scrollbackFailed, scrollbackPending, scrollbackText, closeScrollback, copyScrollback, gridMenu, gridItems, onGridContextMenu } =
    useScrollbackView({ sessionOf: terminalSessionOf, read: fetchScrollback, splitTab });
const { finding, findQuery, findInput, findLabel, runFind, findNext, findPrevious, openFind, closeFind, unbindFind } = useTerminalFind({
    activeName,
    sessionOf: terminalSessionOf,
});
onBeforeUnmount(unbindFind);
const { height, seamHeight, maxHeight } = usePanelHeight(storageKey);
const { coarse } = useDevice();
const { ctrlArmed, EXTRA_KEYS } = useTouchKeys(tabs.sendInput);
// One class for the Ctrl toggle and the keys beside it, in the kit's own style (lib/ui.ts). 44px: they exist only on a
// coarse pointer, the most repeatedly pressed controls on a phone, at the screen's bottom edge where aim is worst.
const KEY_CLASS = `inline-flex h-11 min-w-11 shrink-0 items-center justify-center rounded-md border border-line bg-canvas px-[0.6rem] font-mono text-[0.8125rem] text-content active:bg-overlay`;
const { about, waited, named, emptyHint, openRequested } = usePanelWait({ tabs, initial });

const container = ref<HTMLElement>();
let commandDisposables: readonly Disposable[] = [];
// The spawn hook's disposer, registered before the relist awaits, so a rejected list cannot break New Terminal.
let disposeSpawn: (() => void) | undefined;
// A v-if can tear the panel down and reopen it, so async work checks it is still live before acting.
let live = true;

onMounted(async () => {
    commandDisposables = panelCommands({ activeName, strip, unsplit, splitTab, canKill: killTabs !== undefined, openFind }).map((entry) =>
        registerCommand({ owner: `builtin`, category: TERMINAL, ...entry }),
    );
    const pane = container.value;
    if (pane === undefined) {
        // Nothing to attach to: both requests are module state, spent here rather than handed to the next mount.
        consumeSpawnRequest();
        clearTerminalRequest();
        return;
    }
    // `initial` at mount means the panel opened FOR that session: the attach skips the empty panel's shell for it.
    const attaching = tabs.attach(pane, initial?.name);
    if (newTab !== undefined) {
        disposeSpawn = registerTerminalSpawn(newTab);
    }
    const autoCreated = await attaching;
    // Spent whatever the outcome, and read before any skippable branch: a raced press opens into whatever panel comes
    // up next, and the empty panel's auto-created shell already IS that terminal.
    const spawnAsked = consumeSpawnRequest();
    if (live && newTab !== undefined && spawnAsked && !autoCreated) {
        newTab();
    }
    if (live && initial !== undefined) {
        await openRequested(initial);
    }
});
onBeforeUnmount(() => {
    live = false;
    tabs.detach();
    for (const disposable of commandDisposables) {
        disposable.dispose();
    }
    commandDisposables = [];
    disposeSpawn?.();
    disposeSpawn = undefined;
});
// Parent-driven focus (a row's button while already open): a fresh object re-focuses even the same session.
watch(
    () => initial,
    (request) => {
        if (request !== undefined) {
            void openRequested(request);
        }
    },
);
// Parent-driven surfacing (the agent started Bash): relists without focusing; meaningless once closed.
watch(
    () => surfaced,
    (request) => {
        if (request !== undefined) {
            void tabs.surface();
        }
    },
);
</script>

<template>
    <div
        class="term relative flex min-h-0 shrink-0 border-t border-line"
        :class="[vertical ? 'flex-row' : 'flex-col', { 'h-full': !resizable }]"
        :style="resizable ? { height: `${height}px` } : undefined"
    >
        <!-- Seam rides the panel's top edge in flow; its negative margin gives back the height it takes. -->
        <ResizeSeam
            v-if="resizable"
            v-model="seamHeight"
            axis="y"
            pane="after"
            :min="MIN_HEIGHT"
            :max="maxHeight"
            :reset="DEFAULT_HEIGHT"
            :title="t(`terminal.terminalPanel.dragToResizeDouble`)"
        />
        <!-- Bar: across the top when docked, down the left edge floating (`vertical`); same pills, toolbar, and menu either way. -->
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
                        isSelected(group)
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
                            v-tooltip.top="renamingName === name ? undefined : segmentTooltip(name)"
                            v-middleclick="() => middleKill(name)"
                            @click="onSegmentClick($event, gi, name)"
                            @dblclick.prevent.stop="beginRename(name)"
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
                            <!-- The strip keeps a fixed pill width and owns its clicks. -->
                            <input
                                v-if="renamingName === name"
                                v-model="renameDraft"
                                type="text"
                                maxlength="40"
                                :aria-label="t(`terminal.terminalPanel.terminalName`)"
                                :placeholder="defaultLabel(name)"
                                class="ui-field-box ui-field-inline w-24 min-w-0 select-text px-1 text-2xs"
                                @click.stop
                                @dblclick.stop
                                @keydown.enter.stop.prevent="commitRename"
                                @keydown.esc.stop.prevent="cancelRename"
                                @blur="commitRename"
                                @vue:mounted="focusRename"
                            />
                            <span v-else :class="vertical ? 'min-w-0 flex-1 truncate text-left' : undefined">{{ segmentLabel(name) }}</span>
                            <!-- The pill identifies the live terminal target. -->
                            <span
                                v-if="isBusy(name) && (vertical || group.length === 1)"
                                class="min-w-0 max-w-24 shrink truncate font-mono text-[0.6rem] text-muted"
                                >{{ tabByName.get(name)?.command }}</span
                            >
                            <span v-if="isBusy(name)" class="size-1.5 shrink-0 rounded-full bg-link" aria-hidden="true"></span>
                            <span
                                v-if="killTabs !== undefined && renamingName !== name"
                                class="relative flex h-3 w-3 shrink-0 items-center justify-center"
                                @click.stop="requestKill([name])"
                                :aria-label="
                                    isBusy(name)
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
                <WorkTerminals />
                <BackgroundProcesses />
                <button
                    v-if="restart !== undefined && activeShell"
                    type="button"
                    :class="ui.iconButton()"
                    @click="restart()"
                    v-tooltip.top="t(`terminal.terminalPanel.restartShell`)"
                    :aria-label="t(`terminal.terminalPanel.restartShell`)"
                >
                    <Icon name="refresh" class="text-xs" />
                </button>
                <button
                    v-else
                    type="button"
                    :class="ui.iconButton()"
                    @click="tabs.refresh().catch(() => undefined)"
                    v-tooltip.top="t(`terminal.terminalPanel.refreshSessions`)"
                    :aria-label="t(`terminal.terminalPanel.refreshSessions`)"
                >
                    <Icon name="refresh" class="text-xs" />
                </button>
                <!-- Keep the pop-out action beside close because both change the window. -->
                <button type="button" :class="ui.iconButton()" @click="floating.toggle()" v-tooltip.top="floatHint" :aria-label="floatHint">
                    <Icon :name="floating.floats.value ? 'arrow-down-left' : 'external-link'" class="text-xs" />
                </button>
                <button type="button" :class="ui.iconButton()" @click="emit(`close`)" v-tooltip.top="closeHint" :aria-label="closeHint">
                    <Icon :name="floating.here.value ? 'times' : 'chevron-down'" class="text-xs" />
                </button>
            </div>
        </div>
        <!-- Panes and the touch keys under them: always a column, whichever side the bar is on. -->
        <div class="relative flex min-h-0 min-w-0 flex-1 flex-col">
            <!-- Agent requests appear above the prompt they concern. -->
            <div v-if="help" class="flex shrink-0 flex-col gap-2 border-b border-line bg-warning/10 px-3 py-2">
                <div class="flex items-start gap-2">
                    <Icon name="exclamation-triangle" class="mt-0.5 shrink-0 text-sm text-warning" />
                    <div class="min-w-0 flex-1 text-xs text-content">
                        <span class="font-medium">{{ t(`terminal.terminalPanel.agentNeedsHelp`) }}</span>
                        {{ help.message }}
                        <span class="text-muted">{{ t(`terminal.terminalPanel.typeBelowHandBack`) }}</span>
                    </div>
                </div>
                <div class="flex flex-wrap items-center gap-2">
                    <input
                        v-model="helpNote"
                        type="text"
                        :placeholder="t(`terminal.terminalPanel.optionalNoteBackTo`)"
                        class="ui-field-box ui-field-sm min-w-40 flex-1"
                        @keydown.enter="resolveHelp(true)"
                    />
                    <Button size="small" class="shrink-0" @click="() => resolveHelp(true)"> {{ t(`terminal.terminalPanel.doneHandBack`) }} </Button>
                    <Button size="small" severity="secondary" class="shrink-0" @click="() => resolveHelp(false)">
                        {{ t(`terminal.terminalPanel.cantHelpNow`) }}
                    </Button>
                </div>
            </div>
            <!-- xterm sizes to this container; each split's fit observer fills its own cell. -->
            <!-- Every press here is the terminal's: xterm selects under its own cursor rules (shell/window/windowGesture.ts). -->
            <div
                ref="container"
                class="term-body flex min-h-0 min-w-0 flex-1 bg-terminal p-2"
                data-window-no-drag
                @contextmenu="onGridContextMenu"
            ></div>
            <!-- Find sits over the pane's top-right corner (VSCode's placement) so highlighted rows stay visible under it. -->
            <div
                v-if="finding"
                class="absolute top-1 right-4 z-10 flex items-center gap-1 rounded-md border border-line bg-card px-1.5 py-1 shadow-md"
                @keydown.esc.prevent="closeFind"
            >
                <Icon name="search" class="text-2xs text-muted" />
                <input
                    ref="findInput"
                    v-model="findQuery"
                    type="text"
                    :placeholder="t(`terminal.terminalPanel.find`)"
                    :aria-label="t(`terminal.terminalPanel.findInTerminal`)"
                    class="ui-field-box ui-field-sm w-44"
                    @input="runFind(true)"
                    @keydown.enter.exact.prevent="findNext"
                    @keydown.shift.enter.prevent="findPrevious"
                />
                <span class="min-w-14 text-center font-mono text-2xs text-muted" aria-live="polite">{{ findLabel }}</span>
                <button
                    type="button"
                    :class="ui.iconButton()"
                    :aria-label="t(`terminal.terminalPanel.previousMatch`)"
                    v-tooltip.top="t(`terminal.terminalPanel.previousMatchShiftEnter`)"
                    @click="findPrevious"
                >
                    <Icon name="chevron-up" />
                </button>
                <button
                    type="button"
                    :class="ui.iconButton()"
                    :aria-label="t(`terminal.terminalPanel.nextMatch`)"
                    v-tooltip.top="t(`terminal.terminalPanel.nextMatchEnter`)"
                    @click="findNext"
                >
                    <Icon name="chevron-down" />
                </button>
                <button
                    type="button"
                    :class="ui.iconButton()"
                    :aria-label="t(`terminal.terminalPanel.closeFind`)"
                    v-tooltip.top="t(`terminal.terminalPanel.closeEsc`)"
                    @click="closeFind"
                >
                    <Icon name="times" />
                </button>
            </div>
            <!-- State explicitly when the selected session has no terminals. -->
            <div
                v-if="order.length === 0 && pending !== undefined && !waited"
                class="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center"
            >
                <Icon name="spinner" spin class="text-lg text-subtle" />
                <p class="text-sm text-muted">
                    <template v-if="about?.title">{{ about.title }}…</template>
                    <template v-else
                        >{{ t(`terminal.terminalPanel.opening`) }} <span class="font-mono text-content">{{ named }}</span
                        >…</template
                    >
                </p>
                <!-- Command behind it, so a check that opened this terminal can say what it's running, not just its name. -->
                <p v-if="about?.detail" class="max-w-md truncate font-mono text-2xs text-subtle">{{ about.detail }}</p>
            </div>
            <!-- Show a distinct state while the daemon identifies the terminals. -->
            <div
                v-else-if="order.length === 0 && answer === 'waiting'"
                class="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center"
            >
                <Icon name="spinner" spin class="text-lg text-subtle" />
                <p class="text-sm text-muted">{{ t(`terminal.terminalPanel.lookingSandboxsTerminals`) }}</p>
            </div>
            <div
                v-else-if="order.length === 0"
                class="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 p-6 text-center"
            >
                <Icon :name="answer === 'refused' ? 'exclamation-triangle' : 'desktop'" class="text-2xl text-subtle" />
                <p v-if="about?.title" class="text-sm text-muted">{{ about.title }}</p>
                <p v-else-if="about" class="text-sm text-muted">
                    <span class="font-mono text-content">{{ named }}</span>
                    {{ pending === undefined ? t(`terminal.terminalPanel.isntRunning`) : `` }}
                </p>
                <!-- 'Nothing runs here' and 'this sandbox never answered' are different sentences; only one is about the terminals. -->
                <p v-else class="text-sm text-muted">
                    {{ answer === "refused" ? t(`terminal.terminalPanel.couldntReachSandbox`) : t(`terminal.terminalPanel.noTerminalsOpen`) }}
                </p>
                <p class="max-w-md text-2xs text-subtle">{{ emptyHint }}</p>
                <Button
                    v-if="newTab !== undefined"
                    class="pointer-events-auto mt-1"
                    :label="t(`terminal.terminalPanel.newTerminal`)"
                    size="small"
                    severity="secondary"
                    @click="newTab()"
                >
                    <template #icon><Icon name="plus" class="text-2xs" /></template>
                </Button>
            </div>
            <!-- Touch extra keys preserve terminal focus while the keyboard is open. -->
            <div v-if="coarse" class="flex shrink-0 items-center gap-1 overflow-x-auto border-t border-line bg-card px-1.5 py-1.5">
                <button
                    type="button"
                    :class="[KEY_CLASS, ctrlArmed ? 'border-primary-500/60 bg-primary-500/16 text-primary-500' : '']"
                    @pointerdown.prevent="ctrlArmed = !ctrlArmed"
                >
                    {{ t(`terminal.terminalPanel.ctrl`) }}
                </button>
                <button v-for="key in EXTRA_KEYS" :key="key.label" type="button" :class="KEY_CLASS" @pointerdown.prevent="tabs.sendInput(key.data)">
                    {{ key.label }}
                </button>
            </div>
        </div>

        <!-- The pill menu owns terminal split, join, kill, color, and icon actions. -->
        <ContextMenu ref="menu" :model="menuItems" :min-width="14" />

        <!-- Right-click inside a terminal: clipboard verbs and the deeper scrollback. -->
        <ContextMenu ref="gridMenu" :model="gridItems" :min-width="12" />

        <!-- Scrollback replays a bounded history beyond the live grid. -->
        <Modal
            :open="scrollbackName !== undefined"
            size="xl"
            :scroll="false"
            :header="scrollbackName === undefined ? '' : t(`terminal.terminalPanel.scrollback`, { scrollbackName: segmentLabel(scrollbackName) })"
            @update:open="closeScrollback"
        >
            <!-- The pre element scrolls; its parent only provides the layout height. -->
            <div class="flex h-panel-lg min-h-0 flex-col gap-2">
                <div class="flex shrink-0 items-center gap-2 text-xs text-muted">
                    <template v-if="scrollback">
                        <span>{{ t(`terminal.terminalPanel.lines`, { toLocaleString: scrollback.lines.toLocaleString() }) }}</span>
                        <span v-if="scrollback.truncated">{{ t(`terminal.terminalPanel.olderLinesBeyondStill`) }}</span>
                        <Button
                            class="ml-auto"
                            size="small"
                            severity="secondary"
                            :label="t(`terminal.terminalPanel.copyAll`)"
                            @click="copyScrollback"
                        />
                    </template>
                    <span v-else-if="scrollbackFailed">{{ t(`terminal.terminalPanel.couldntReadTerminalsScrollback`) }}</span>
                    <span v-else-if="scrollbackPending">{{ t(`terminal.terminalPanel.reading`) }}</span>
                </div>
                <pre
                    v-if="scrollback"
                    ref="scrollbackText"
                    class="min-h-0 flex-1 overflow-auto rounded-md bg-terminal p-3 font-mono text-xs whitespace-pre text-content select-text"
                    >{{ scrollback.text }}</pre>
            </div>
        </Modal>

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
                <Icon :name="segmentIcon(item.name)" class="shrink-0 text-2xs text-muted" />
                <span class="shrink-0 text-content">{{ segmentLabel(item.name) }}</span>
                <span v-if="item.command" class="truncate font-mono text-xs text-muted">{{ item.command }}</span>
            </template>
            <p class="mt-3 text-xs text-muted">{{ killPrompt.body }}</p>
        </ConfirmDialog>

        <!-- One dialog for both pickers (color, icon); a leading default swatch clears the override. Rename stays inline in the strip. -->
        <Modal :open="customize !== undefined" size="sm" :header="customizeHeader" @update:open="customize = undefined">
            <template v-if="customize">
                <div v-if="customize.mode === 'color'" class="flex flex-wrap items-center gap-2">
                    <button
                        type="button"
                        :class="ui.addTile(`h-7 w-7 rounded-full text-subtle`)"
                        v-tooltip.top="t(`terminal.terminalPanel.default`)"
                        :aria-label="t(`terminal.terminalPanel.defaultColor`)"
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
                        :class="ui.addTile(`h-8 w-8 text-subtle`)"
                        v-tooltip.top="t(`terminal.terminalPanel.default`)"
                        :aria-label="t(`terminal.terminalPanel.defaultIcon`)"
                        @click="applyIcon(undefined)"
                    >
                        <Icon name="times" class="text-2xs" />
                    </button>
                    <button
                        v-for="icon in TERMINAL_ICONS"
                        :key="icon"
                        type="button"
                        :class="ui.iconButton(`h-8 w-8`, terminalMeta(customize.name).icon === icon ? `bg-overlay text-content` : ``)"
                        :aria-label="icon"
                        @click="applyIcon(icon)"
                    >
                        <Icon :name="icon" class="text-sm" />
                    </button>
                </div>
            </template>
        </Modal>
    </div>
</template>

<style scoped>
/* Split cells (plain elements from useTerminal's mount, hence :deep): equal flex columns with a hairline between. */
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
</style>
