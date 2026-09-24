<script setup lang="ts">
import { Button, ContextMenu, Icon, Modal, ResizeSeam, ui, useDevice } from "@intentic/ui";
import type { Disposable } from "@intentic/extension-api";
import { useT } from "@intentic/ui/i18n";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { TERMINAL } from "../../shell/commands/categories";
import { registerCommand, withShortcut } from "../../shell/commands/useCommands";
import { postTurnControl } from "../chat/run/turnStream";
import { useSandbox } from "../sandbox/client/useSandbox";
import BackgroundProcesses from "./BackgroundProcesses.vue";
import TerminalStrip from "./panel/TerminalStrip.vue";
import WorkTerminals from "./WorkTerminals.vue";
import { useTerminalFloating } from "./terminalFloating";
import { fetchScrollback } from "./terminalScrollback";
import { useTerminalsQuery } from "./terminalsQuery";
import { createTerminalTabs, type TerminalTabsSource, terminalSessionOf } from "./useTerminal";
import { clearTerminalRequest, consumeSpawnRequest, registerTerminalSpawn, type TerminalRequest } from "./useTerminalPanel";
import { labelFor, stripIndex } from "./panel/stripSegments";
import { DEFAULT_HEIGHT, MIN_HEIGHT, usePanelHeight } from "./panel/usePanelHeight";
import { usePanelWait } from "./panel/usePanelWait";
import { useScrollbackView } from "./panel/useScrollbackView";
import { useTerminalFind } from "./panel/useTerminalFind";
import { useTerminalHelp } from "./panel/useTerminalHelp";
import { useTouchKeys } from "./panel/useTouchKeys";

// Terminal panel, mounted once below every view: each tab is a tmux session in the shared cache, so scrollback survives
// unmount, navigation and reload. The bar is TerminalStrip; find, the scrollback view, the touch keys, the handover ask
// and the empty panel's wait are wired here over ./panel; poppable into its own window, bar on the left edge.

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
const { order, groups, answer, activeName, pending, newTab, splitTab, restart } = tabs;
// Whether Restart applies: a fresh shell replaces a killed one, which means nothing for a dev-server tab.
const activeShell = computed(() => order.value.find((tab) => tab.name === activeName.value)?.kind === `shell`);
const floating = useTerminalFloating();
// The bar becomes a left rail while the panel has a window of its own.
const vertical = computed(() => floating.here.value);
const floatHint = computed(() => withShortcut(floating.floats.value ? `Dock panel back` : `Move panel into new window`, `terminal.toggleFloating`));
// Dismissal, not a kill: sessions outlive every view; docked it hides the panel, floating it closes the window.
const closeHint = computed(() =>
    withShortcut(
        floating.here.value ? `Close the window, the terminals keep running` : `Hide the panel, the terminals keep running`,
        `terminal.toggle`,
    ),
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
const {
    scrollbackName,
    scrollback,
    scrollbackFailed,
    scrollbackPending,
    scrollbackText,
    closeScrollback,
    copyScrollback,
    gridMenu,
    gridItems,
    onGridContextMenu,
} = useScrollbackView({ sessionOf: terminalSessionOf, read: fetchScrollback, splitTab });
const scrollbackLabel = computed(() =>
    scrollbackName.value === undefined
        ? ``
        : labelFor(
              scrollbackName.value,
              order.value.find((tab) => tab.name === scrollbackName.value),
              stripIndex(groups.value).get(scrollbackName.value),
          ),
);
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
    // Cmd+F on a Mac, Ctrl+F elsewhere, gated to this panel so the page's own find keeps the chord everywhere else.
    commandDisposables = [
        registerCommand({
            owner: `builtin`,
            category: TERMINAL,
            command: `terminal.find`,
            title: t(`terminal.terminalPanel.find`),
            icon: `search`,
            keybinding: `Mod+F`,
            when: `tabSurface == 'terminal'`,
            handler: openFind,
        }),
    ];
    const pane = container.value;
    if (pane === undefined) {
        // Nothing to attach to: both requests are module state, spent here rather than handed to the next mount.
        consumeSpawnRequest();
        clearTerminalRequest();
        return;
    }
    // `initial` at mount means the panel opened FOR that session: the attach skips the empty panel's shell for it.
    // Spent before the attach, whose empty-panel shell then IS that terminal; a later press reaches the hook below.
    const spawnAsked = consumeSpawnRequest();
    const attaching = tabs.attach(pane, initial?.name, spawnAsked?.cwd);
    if (newTab !== undefined) {
        disposeSpawn = registerTerminalSpawn(newTab);
    }
    const autoCreated = await attaching;
    if (live && newTab !== undefined && spawnAsked !== undefined && !autoCreated) {
        newTab(spawnAsked.cwd);
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
            :title="t(`shared.dragToResizeDouble`)"
        />
        <TerminalStrip :tabs="tabs" :floating="floating" :vertical="vertical">
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
        </TerminalStrip>
        <!-- Panes and the touch keys under them: always a column, whichever side the bar is on. -->
        <div class="relative flex min-h-0 min-w-0 flex-1 flex-col">
            <!-- Agent requests appear above the prompt they concern. -->
            <div v-if="help" class="flex shrink-0 flex-col gap-2 border-b border-line bg-warning/10 px-3 py-2">
                <div class="flex items-start gap-2">
                    <Icon name="exclamation-triangle" class="mt-0.5 shrink-0 text-sm text-warning" />
                    <div class="min-w-0 flex-1 text-xs text-content">
                        <span class="font-medium">{{ t(`shared.agentNeedsHelp`) }}</span>
                        {{ help.message }}
                        <span class="text-muted">{{ t(`terminal.terminalPanel.typeBelowHandBack`) }}</span>
                    </div>
                </div>
                <div class="flex flex-wrap items-center gap-2">
                    <input
                        v-model="helpNote"
                        type="text"
                        :placeholder="t(`shared.optionalNoteBackTo`)"
                        class="ui-field-box ui-field-sm min-w-40 flex-1"
                        @keydown.enter="resolveHelp(true)"
                    />
                    <Button size="small" class="shrink-0" @click="() => resolveHelp(true)"> {{ t(`shared.doneHandBack`) }} </Button>
                    <Button size="small" severity="secondary" class="shrink-0" @click="() => resolveHelp(false)">
                        {{ t(`shared.cantHelpNow`) }}
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

        <!-- Right-click inside a terminal: clipboard verbs and the deeper scrollback. -->
        <ContextMenu ref="gridMenu" :model="gridItems" :min-width="12" />

        <!-- Scrollback replays a bounded history beyond the live grid. -->
        <Modal
            :open="scrollbackName !== undefined"
            size="xl"
            :scroll="false"
            :header="scrollbackName === undefined ? '' : t(`terminal.terminalPanel.scrollback`, { scrollbackName: scrollbackLabel })"
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
                    <span v-else-if="scrollbackPending">{{ t(`shared.reading`) }}</span>
                </div>
                <pre
                    v-if="scrollback"
                    ref="scrollbackText"
                    class="min-h-0 flex-1 overflow-auto rounded-md bg-terminal p-3 font-mono text-xs whitespace-pre text-content select-text"
                    >{{ scrollback.text }}</pre>
            </div>
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
