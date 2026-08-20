<script setup lang="ts">
import { CopyButton, Notice, noticeOf, Picker, type PickerGroup, SegmentedControl, StatusBadge, type StatusVariant } from "@intentic/ui";
import Button from "primevue/button";
import { computed, onUnmounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { pickTarget, type PreviewTarget } from "../composables/preview/previewModel";
import { usePreviewTargets } from "../composables/preview/usePreviewTargets";
import { previewOpened, previewSelectedId, selectPreviewTarget } from "../composables/preview/previewSurface";
import { togglePreviewPopout, usePreviewPopout } from "../composables/preview/usePreviewPopout";
import { useTerminalPanel } from "../composables/terminal/useTerminalPanel";

/* THE ONE PREVIEW PANEL — the live, clickable app, full-bleed under one slim strip of chrome. Mounted once per
 * page (shell/PoppablePanels) and teleported between the /preview area, its own pop-out window and the parking
 * stage, so the iframe — and the previewed app's own state inside it — survives every move.
 *
 * DESIGNED FOR ONE SCREEN WITH NO ROOM TO SPARE. The app under preview gets everything below a single h-10
 * bar; nothing floats over it (hover-revealed chrome steals the exact pixels the previewed app's own header
 * sits under, and an overlay that appears on the way to a button in the app is chrome fighting content). The
 * bar holds the whole vocabulary: WHICH app (the switcher), whether it is UP (the badge), and the verbs —
 * start/stop, reload, phone width, its terminal, its public link, a window of its own.
 *
 * A REAL IFRAME, NOT A STREAMED BROWSER. The dev server already answers at a public preview hostname, so the
 * page here is the app itself — clickable at native latency, hot-reloading as the agent edits — where
 * /browsers shows screenshots of a browser the AGENT is driving. The two surfaces answer different questions
 * ("what is my app like" vs "what is the agent doing"), which is why this is not that view. */

const router = useRouter();
// Mounted ⇔ opened (PoppablePanels), so the panel's own lifetime gates the per-monorepo apps fan-out.
const { targets, settled, start, stop } = usePreviewTargets(previewOpened);
const target = computed(() => pickTarget(targets.value, previewSelectedId.value));

const { poppedOut } = usePreviewPopout();
const terminal = useTerminalPanel();

// --- The switcher -------------------------------------------------------------------------------
// Grouped by repo — an app row wears its own name under its repo's heading — with the public page last under
// its own heading. The row's annotation is its live state, so the list answers "what is up?" before a click.
const stateOf = (entry: PreviewTarget): string =>
    entry.kind === `public` ? `live` : entry.healthy ? `running` : entry.running ? `starting` : `stopped`;
const pickerGroups = computed<readonly PickerGroup[]>(() => {
    const repos = [...new Set(targets.value.flatMap((entry) => (entry.repo === undefined ? [] : [entry.repo])))];
    const groups: PickerGroup[] = repos.map((repo) => ({
        label: repo,
        options: targets.value
            .filter((entry) => entry.repo === repo)
            .map((entry) => ({ value: entry.id, label: entry.label, description: stateOf(entry) })),
    }));
    const outbox = targets.value.find((entry) => entry.kind === `public`);
    if (outbox !== undefined) {
        groups.push({ label: `Workspace`, options: [{ value: outbox.id, label: outbox.label, icon: `globe`, description: stateOf(outbox) }] });
    }
    return groups;
});
const selected = computed<string | undefined>({
    get: () => target.value?.id,
    set: (id) => {
        if (id !== undefined) {
            selectPreviewTarget(id);
        }
    },
});

const statusVariant = computed<StatusVariant>(() => (target.value?.healthy ? `success` : target.value?.running ? `info` : `neutral`));

// --- Start / stop -------------------------------------------------------------------------------
const busy = ref(false);
const actionError = ref<string | undefined>(undefined);
const act = async (action: (entry: PreviewTarget) => Promise<void>): Promise<void> => {
    const entry = target.value;
    if (entry === undefined) {
        return;
    }
    actionError.value = undefined;
    busy.value = true;
    try {
        await action(entry);
    } catch (error) {
        actionError.value = error instanceof Error ? error.message : `The action failed.`;
    } finally {
        busy.value = false;
    }
};

// --- The iframe, probe-gated --------------------------------------------------------------------
/* Hand the browser the hostname only once a fetch proves it resolves: `no-cors` resolves on ANY HTTP response
 * and rejects only on DNS/socket failure — exactly the needed signal, since a freshly-minted DNS record can
 * lag at the user's resolver and an iframe that error-pages never retries. The public page skips the probe:
 * its address is the sandbox's own, which everything on screen already resolved to load. */
const previewSrc = ref<string | undefined>(undefined);
const probeSlow = ref(false);
const probeFailed = ref(false);
let probeGeneration = 0;

const PROBE_INTERVAL_MS = 3000;
const PROBE_SLOW_AFTER_MS = 30_000;
// Absolute cap so a never-resolving preview host isn't polled forever — generous, since a first start can
// legitimately take a minute for the address to propagate.
const PROBE_GIVE_UP_MS = 180_000;

const probeUntilReachable = async (url: string): Promise<void> => {
    const generation = ++probeGeneration;
    probeSlow.value = false;
    probeFailed.value = false;
    const startedAt = Date.now();
    for (;;) {
        try {
            await fetch(url, { mode: `no-cors`, cache: `no-store` });
            break;
        } catch {
            const elapsed = Date.now() - startedAt;
            probeSlow.value = elapsed > PROBE_SLOW_AFTER_MS;
            if (elapsed > PROBE_GIVE_UP_MS) {
                if (generation === probeGeneration) {
                    probeFailed.value = true;
                }
                return;
            }
            await new Promise((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS));
        }
        if (generation !== probeGeneration) {
            return;
        }
    }
    if (generation === probeGeneration) {
        previewSrc.value = url;
    }
};

// Resolved when the target is HEALTHY — on `running` the dev server may still be installing/booting.
const resolvePreview = (): void => {
    const entry = target.value;
    if (entry === undefined || !entry.healthy || entry.url === undefined) {
        probeGeneration += 1;
        previewSrc.value = undefined;
        probeSlow.value = false;
        probeFailed.value = false;
        return;
    }
    if (entry.kind === `public`) {
        probeGeneration += 1;
        previewSrc.value = entry.url;
        return;
    }
    void probeUntilReachable(entry.url);
};

// (Re)resolve on the facts that matter — primitive deps, so the poll's object churn doesn't re-fire it — and
// re-key the iframe when the target changes or turns healthy again (a restarted server keeps its src, and Vue
// would otherwise leave the stale error frame in place instead of re-navigating).
const previewEpoch = ref(0);
watch(
    () => [target.value?.id, target.value?.healthy, target.value?.url] as const,
    (now, was) => {
        actionError.value = undefined;
        // `was` is absent on the immediate first run, which is also a fresh mount — a fresh key either way.
        if (was === undefined || now[0] !== was[0] || (now[1] === true && was[1] !== true)) {
            previewEpoch.value += 1;
        }
        resolvePreview();
    },
    { immediate: true },
);
onUnmounted(() => {
    probeGeneration += 1;
});

// The bar's own reload — the previewed app navigated somewhere, or the user wants a clean load after an edit
// hot reload went wrong. Re-keying is the only reliable cross-origin reload.
const reload = (): void => {
    previewEpoch.value += 1;
};

/* Phone width. The one responsive question a builder asks constantly — "does this survive a phone?" — answered
 * in place instead of through devtools on a cross-origin frame. Full is the default and the panel's whole
 * width; phone centres a 390px column (a current iPhone's CSS width) on the canvas. */
const fit = ref<`full` | `phone`>(`full`);
</script>

<template>
    <div class="flex h-full min-h-0 w-full flex-col bg-canvas">
        <!-- The strip. One row, h-10: switcher + status on the left, verbs on the right. -->
        <div class="flex h-10 shrink-0 items-center gap-1 border-b border-line bg-card px-1.5">
            <Picker
                v-if="pickerGroups.length > 0"
                v-model="selected"
                :options="pickerGroups"
                variant="ghost"
                aria-label="Which app to preview"
                header="Preview"
            />
            <StatusBadge v-if="target && target.startable" :variant="statusVariant" :label="stateOf(target)" size="xs" />

            <span class="flex-1"></span>

            <template v-if="target">
                <Button v-if="target.startable && !target.running" label="Start" size="small" :disabled="busy" @click="act(start)">
                    <template #icon><Icon name="play" /></template>
                </Button>
                <Button v-else-if="target.startable" label="Stop" size="small" severity="secondary" :disabled="busy" @click="act(stop)">
                    <template #icon><Icon name="stop" /></template>
                </Button>

                <SegmentedControl
                    v-model="fit"
                    size="xs"
                    :options="[
                        { label: `Full`, value: `full` },
                        { label: `Phone`, value: `phone` },
                    ]"
                />

                <button
                    v-if="previewSrc"
                    type="button"
                    class="flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-overlay hover:text-content"
                    aria-label="Reload the preview"
                    v-tooltip.bottom="'Reload'"
                    @click="reload"
                >
                    <Icon name="refresh" />
                </button>
                <button
                    v-if="target.session"
                    type="button"
                    class="flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-overlay hover:text-content"
                    aria-label="Open this dev server's terminal"
                    v-tooltip.bottom="'Terminal'"
                    @click="terminal.openFocused(target.session!)"
                >
                    <Icon name="code" />
                </button>
                <!-- The link is public the moment the server answers — a live demo anyone can open. Offered
                     only while something is actually up, so a copied link never 502s on arrival. -->
                <template v-if="target.url && target.healthy">
                    <CopyButton :text="target.url" aria-label="Copy the public link" v-tooltip.bottom="'Copy the public link'" />
                    <a
                        :href="target.url"
                        target="_blank"
                        rel="noopener"
                        class="flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-overlay hover:text-content"
                        :aria-label="`Open ${target.label} in a new tab`"
                        v-tooltip.bottom="'Open in new tab'"
                    >
                        <Icon name="external-link" />
                    </a>
                </template>
            </template>

            <button
                type="button"
                class="flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-overlay hover:text-content"
                :aria-label="poppedOut ? `Dock the preview back` : `Move the preview into its own window`"
                v-tooltip.bottom="poppedOut ? 'Dock back' : 'Move into new window'"
                @click="togglePreviewPopout(router)"
            >
                <Icon :name="poppedOut ? 'sign-in' : 'window-maximize'" />
            </button>
        </div>

        <!-- Errors overlay the top edge instead of pushing the preview around. -->
        <div class="relative flex min-h-0 flex-1 flex-col">
            <Notice v-if="actionError" :of="noticeOf(actionError)" class="absolute inset-x-3 top-3 z-10" />

            <!-- NOTHING TO PREVIEW. Only claimed once the lists have actually answered. -->
            <div v-if="!target && settled" class="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
                <Icon name="eye" class="text-2xl text-subtle" />
                <p class="text-sm text-muted">Nothing to preview yet.</p>
                <p class="max-w-sm text-2xs text-subtle">
                    Start a dev server in a repository, or ask the agent to build an app — its live preview appears here the moment it answers.
                </p>
            </div>
            <div v-else-if="!target" class="flex flex-1 items-center justify-center" role="status" aria-busy="true">
                <span class="sr-only">Reading what can be previewed…</span>
                <Icon name="spinner" spin class="text-2xl text-subtle" aria-hidden="true" />
            </div>

            <!-- The app itself: the real dev server through the tunnel — hot reload works; apps that forbid
                 framing (X-Frame-Options) stay blank here, and the new-tab link is the escape hatch. Mounted
                 only after the hostname probe succeeds, so the browser's DNS error page can never appear.
                 The public page runs sandboxed (scripts, no same-origin): it is anyone-on-the-internet
                 content, and it needs nothing of this app's. -->
            <div v-else-if="previewSrc" class="flex min-h-0 flex-1 justify-center overflow-hidden">
                <iframe
                    :key="`${previewEpoch}-${previewSrc}`"
                    :src="previewSrc"
                    :title="`${target.label} preview`"
                    :sandbox="target.kind === `public` ? `allow-scripts` : undefined"
                    class="h-full min-h-0 flex-1 bg-white"
                    :class="fit === `phone` ? `max-w-[390px] border-x border-line` : ``"
                ></iframe>
            </div>

            <div v-else-if="target.running && probeFailed" class="flex flex-1 flex-col items-center justify-center gap-2 text-center">
                <Icon name="exclamation-triangle" class="text-muted" />
                <p class="text-sm text-muted">The preview address didn't come up.</p>
                <p class="text-2xs text-subtle">The dev server may still be starting — its terminal shows it live.</p>
                <Button label="Retry" size="small" @click="resolvePreview()" />
            </div>
            <div v-else-if="target.running" class="flex flex-1 flex-col items-center justify-center gap-2 text-center">
                <Icon name="spinner" class="text-muted" spin />
                <p class="text-sm text-muted">Preparing the preview…</p>
                <p v-if="probeSlow" class="max-w-sm text-2xs text-subtle">
                    A first start can take a minute while the preview address propagates — the terminal shows the dev server live.
                </p>
            </div>
            <div v-else class="flex flex-1 flex-col items-center justify-center gap-2 text-center">
                <p class="text-sm text-muted">
                    <span class="font-mono">{{ target.label }}</span> isn't running.
                </p>
                <Button v-if="target.startable" label="Start" size="small" :disabled="busy" @click="act(start)">
                    <template #icon><Icon name="play" /></template>
                </Button>
            </div>
        </div>
    </div>
</template>
