<script setup lang="ts">
import { useDevice } from "@intentic-app/ui";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { createTerminalTabs, type TerminalTabsSource } from "../composables/terminal/useTerminal";

/* THE terminal panel — mounted once in the shell, below every view. Each tab is a tmux-backed session in the
 * shared cache (composables/useTerminal): mounting re-appends the active tab's persistent host element,
 * unmounting only detaches it, so scrollback and running processes survive collapse, navigation, and reload.
 * Every tab gets the hover-×; restart is shell-only (a dev-server tab is re-run via Start, or ↑ at its
 * prompt). `initial` is an object so re-requesting the same session still refocuses. Height and collapse
 * persist per storageKey; `resizable: false` pins the panel to its container. */

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
const { order, activeName, switchTab, newTab, closeTab, restart } = tabs;
// Restart kills the active session and opens a fresh web-* shell — meaningless for a dev-server tab, which
// gets refresh instead.
const activeShell = computed(() => order.value.find((tab) => tab.name === activeName.value)?.kind === `shell`);

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
        <div class="flex shrink-0 items-center gap-1 border-b border-line bg-card px-2 py-0.5">
            <!-- One tab per tmux session, styled like the editor's FileTabs: dim glyph, label (or index), and —
                 when the source manages sessions — a small × that appears on hover. Click switches; × kills
                 that session; + opens a new one. A dimmed pill is an untracked session (a finished one-shot
                 job's lingering shell, output in scrollback). Hidden while collapsed so the collapsed bar stays
                 a single clean line (the chevron expands). -->
            <div v-if="!collapsed" class="scrollbar-thin flex min-w-0 items-center gap-0.5 overflow-x-auto">
                <div
                    v-for="(tab, i) in order"
                    :key="tab.name"
                    class="tterm group flex h-6 shrink-0 cursor-pointer items-center gap-1.5 rounded-md pl-2 pr-1.5 text-2xs"
                    :class="{ 'tterm-on': tab.name === activeName, 'opacity-60': tab.running === false }"
                    v-tooltip.top="tab.kind === 'agent' ? 'AI terminal' : tab.kind === 'job' ? 'Job terminal' : tab.running === false ? 'finished' : undefined"
                    @click="switchTab(tab.name)"
                >
                    <Icon
                        :name="tab.kind === 'agent' ? 'sparkles' : tab.kind === 'job' ? 'bolt' : 'desktop'"
                        class="text-2xs"
                        :class="tab.kind === 'agent' ? 'text-link' : 'text-muted'"
                    />
                    <span>{{ tab.label ?? i + 1 }}</span>
                    <span
                        v-if="closeTab !== undefined"
                        class="relative flex h-3 w-3 shrink-0 items-center justify-center"
                        @click.stop="closeTab(tab.name)"
                        aria-label="Close tab"
                    >
                        <Icon
                            name="times"
                            class="absolute rounded text-[0.6rem] opacity-0 transition-opacity hover:text-content group-hover:opacity-60"
                        />
                    </span>
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
                v-tooltip.top="'Close terminal'"
                aria-label="Close terminal"
            >
                <Icon name="times" class="text-xs" />
            </button>
        </div>
        <!-- xterm sizes to this container; FitAddon + a ResizeObserver keep it filling the pane. v-show (not v-if)
             keeps xterm open()'d and the shell alive while collapsed — it refits when shown again. -->
        <div v-show="!collapsed" ref="container" class="min-h-0 flex-1 bg-terminal p-2"></div>
        <!-- Touch extra-keys row (coarse pointers only). pointerdown.prevent keeps the terminal focused so the
             soft keyboard stays up while the key is injected. -->
        <div v-if="coarse && !collapsed" class="scrollbar-thin flex shrink-0 items-center gap-1 overflow-x-auto border-t border-line bg-card px-1.5 py-1.5">
            <button type="button" class="termkey" :class="{ 'termkey-on': ctrlArmed }" @pointerdown.prevent="ctrlArmed = !ctrlArmed">Ctrl</button>
            <button v-for="key in EXTRA_KEYS" :key="key.label" type="button" class="termkey" @pointerdown.prevent="pressKey(key.data)">
                {{ key.label }}
            </button>
        </div>
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
   toolbar's other rounded-md buttons. */
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
