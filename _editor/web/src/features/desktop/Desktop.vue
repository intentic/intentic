<script setup lang="ts">
import { CopyButton, Icon } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, nextTick, ref, watch } from "vue";
import { type DesktopStatus, useDesktopView } from "./useDesktopView";
import type { DesktopPointerAction } from "./desktopInput";
import { useDesktopQuery } from "./desktopQuery";
import { useSandbox } from "../../client/sandbox/useSandbox";
import { useRole } from "../../client/sandbox/useRole";
import { useAudience } from "../../app/useAudience";
import { useTerminalPanel } from "../terminal/useTerminalPanel";

// The sandbox's own desktop (the one the agent's `desktop` tools drive), live, with a way to take it over. A plain
// desktop: no tabs or address bar of ours, so every key and click the owner makes while driving is the desktop's.

const t = useT();
const { activeSandboxId } = useSandbox();
const view = useDesktopView(activeSandboxId);

const stageEl = ref<HTMLElement | null>(null);
const canvasEl = ref<HTMLCanvasElement | null>(null);
watch(canvasEl, (canvas) => view.attachCanvas(canvas));

// The sentence over the picture while there is none; undefined once frames flow.
const message = computed<string | undefined>(() => {
    const status: DesktopStatus | undefined = view.status.value;
    if (status === undefined) {
        return undefined;
    }
    switch (status.kind) {
        case `connecting`:
            return t(`desktop.desktop.connecting`);
        case `reconnecting`:
            return t(`desktop.desktop.reconnecting`);
        case `waiting`:
            return t(`desktop.desktop.waiting`);
        case `unreachable`:
            return t(`desktop.desktop.unreachable`);
        case `unsupported`:
            return t(`desktop.desktop.unsupported`);
        case `refused`:
            return t(`desktop.desktop.refused`);
        case `authFailed`:
            return t(`desktop.desktop.authFailed`, { reason: status.detail });
        default:
            // `failed`, in the daemon's own sentence ("The desktop could not start: …").
            return status.detail === `` ? t(`desktop.desktop.unavailable`) : status.detail;
    }
});

// The status line's word for the same state: live, on its way, or not coming.
const state = computed<{ readonly label: string; readonly dot: string }>(() => {
    const kind = view.status.value?.kind;
    if (kind === undefined) {
        return { label: t(`desktop.desktop.live`), dot: `bg-success` };
    }
    if (kind === `connecting` || kind === `reconnecting` || kind === `waiting`) {
        return { label: t(`desktop.desktop.connectingShort`), dot: `bg-warning` };
    }
    return { label: t(`desktop.desktop.unavailable`), dot: `bg-line-strong` };
});

// An empty desktop is one black screen, the same picture as a stream that never came: once frames flow and the daemon
// counts no window on it, the view says so, and says how a window gets there. Never on an unknown count (a daemon too
// old to say, or a desktop with no window manager), since "nothing is open" would then be a guess.
const desk = useDesktopQuery();
const empty = computed(() => view.status.value === undefined && desk.windows.value === 0);
// The do-it-yourself half is a shell's, so it goes to whoever has the rail's terminal (ShellDesktop.vue).
const { canShip } = useRole();
const { maker } = useAudience();
const terminal = useTerminalPanel();
const exportLine = computed(() => (desk.state.value?.display === undefined ? undefined : `export DISPLAY=${desk.state.value.display}`));

const toggle = async (): Promise<void> => {
    if (view.driving.value) {
        view.handBack();
        return;
    }
    view.takeOver();
    // The keyboard follows the hands: keys reach the desktop only while the picture has focus.
    await nextTick();
    stageEl.value?.focus({ preventScroll: true });
};

// Pointer events rather than mouse events, for the capture: a drag released outside the picture still lets go of the
// button on the desktop instead of leaving it held there.
const pointer = (action: DesktopPointerAction, event: PointerEvent): void => {
    if (!view.driving.value || canvasEl.value === null) {
        return;
    }
    if (action === `down`) {
        // No text selection, middle-click autoscroll or drag image of ours; the focus they would have moved is moved here.
        event.preventDefault();
        stageEl.value?.focus({ preventScroll: true });
        stageEl.value?.setPointerCapture(event.pointerId);
    }
    view.onPointer(action, event, canvasEl.value);
};
const wheel = (event: WheelEvent): void => {
    if (canvasEl.value !== null) {
        view.onWheel(event, canvasEl.value);
    }
};
</script>

<template>
    <div class="flex h-full min-h-0 flex-col">
        <div class="flex min-h-0 flex-1 overflow-hidden p-3">
            <!-- Rings while driving: a stray keystroke is the one real mistake here. -->
            <div
                class="flex min-h-0 w-full flex-col overflow-hidden rounded-lg border bg-card shadow-lg transition-colors"
                :class="view.driving.value ? 'border-primary-600 ring-1 ring-primary-600' : 'border-line'"
            >
                <div class="flex shrink-0 items-center gap-2 border-b border-line px-2 py-1">
                    <Icon name="screen" class="shrink-0 text-muted" />
                    <span class="shrink-0 text-sm font-medium text-content">{{ t(`shared.desktop`) }}</span>
                    <span class="flex min-w-0 flex-1 items-center gap-1.5 text-2xs text-muted" role="status">
                        <span class="size-1.5 shrink-0 rounded-full" :class="state.dot"></span>
                        <span class="truncate">{{ state.label }}</span>
                    </span>
                    <!-- The daemon refuses the agent's desktop tools while the owner holds it; this says so, and lapses when the hold does. -->
                    <span
                        v-if="view.held.value"
                        class="shrink-0 whitespace-nowrap rounded-md bg-warning/15 px-1.5 py-0.5 text-2xs font-medium text-warning"
                        v-tooltip.bottom="{ title: t(`desktop.desktop.heldTitle`), note: t(`desktop.desktop.heldNote`) }"
                        >{{ view.driving.value ? t(`desktop.desktop.agentWaits`) : t(`desktop.desktop.heldElsewhere`) }}</span
                    >
                    <button
                        type="button"
                        class="ui-chip shrink-0 px-2 py-1 font-medium"
                        :class="view.driving.value ? `ui-chip-on` : ``"
                        :aria-pressed="view.driving.value"
                        v-tooltip.bottom="
                            view.driving.value
                                ? { title: t(`desktop.desktop.handBack`), note: t(`desktop.desktop.handBackNote`) }
                                : { title: t(`desktop.desktop.takeOver`), note: t(`desktop.desktop.takeOverNote`) }
                        "
                        @click="toggle"
                    >
                        <span v-if="view.driving.value" class="size-1.5 rounded-full bg-current"></span>
                        {{ view.driving.value ? t(`desktop.desktop.handBack`) : t(`desktop.desktop.takeOver`) }}
                    </button>
                </div>

                <!-- The whole display, letterboxed into whatever box this is; clicks are aimed at the picture, not the box. -->
                <div class="relative min-h-0 flex-1 bg-terminal">
                    <div
                        ref="stageEl"
                        tabindex="0"
                        :aria-label="t(`desktop.desktop.stageLabel`)"
                        class="absolute inset-0 select-none outline-none"
                        :class="view.driving.value ? 'touch-none' : ''"
                        @pointerdown="pointer(`down`, $event)"
                        @pointermove="pointer(`move`, $event)"
                        @pointerup="pointer(`up`, $event)"
                        @pointercancel="pointer(`up`, $event)"
                        @wheel="wheel"
                        @keydown="view.onKeyDown"
                        @paste="view.onPaste"
                        @contextmenu.prevent
                    >
                        <canvas ref="canvasEl" class="absolute inset-0 h-full w-full object-contain" />
                        <div v-if="message" class="pointer-events-none absolute inset-0 flex items-center justify-center px-4">
                            <span class="max-w-md rounded-md bg-card px-2 py-1 text-center text-xs text-muted">{{ message }}</span>
                        </div>
                    </div>
                    <!-- Beside the stage, not in it: a press on this card is the page's, never a click sent to the desktop. -->
                    <div v-if="empty" class="pointer-events-none absolute inset-0 flex items-center justify-center p-4">
                        <div class="pointer-events-auto flex max-w-sm flex-col items-center gap-2 rounded-lg border border-line bg-card px-5 py-4 text-center shadow-lg">
                            <Icon name="screen" class="text-2xl text-subtle" />
                            <p class="text-sm font-medium text-content">{{ t(`desktop.desktop.emptyTitle`) }}</p>
                            <p class="text-xs text-muted">{{ t(`desktop.desktop.emptyNote`) }}</p>
                            <template v-if="canShip && !maker && exportLine !== undefined">
                                <p class="mt-1 text-xs text-muted">{{ t(`desktop.desktop.emptyYourself`) }}</p>
                                <div class="flex max-w-full items-center gap-1 rounded-md bg-overlay py-0.5 pl-2 pr-0.5">
                                    <code class="truncate font-mono text-xs text-content">{{ exportLine }}</code>
                                    <CopyButton :text="exportLine" />
                                </div>
                                <button type="button" class="ui-chip mt-1 px-2 py-1 font-medium" @click="terminal.setOpen(true)">
                                    <Icon name="terminal" />
                                    {{ t(`desktop.desktop.openTerminal`) }}
                                </button>
                            </template>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>
