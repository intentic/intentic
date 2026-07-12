<script setup lang="ts">
import { Button, cmp, Icon, StatusBadge, type StatusVariant } from "@intentic/extension-ui";
import { computed, onUnmounted, ref, watch } from "vue";
import { host } from "./host";
import { usePanels } from "./usePanels";

/* The preview extension's view: a repo's `operator/` (or root) dev server, started in the sandbox and shown
 * live in a full-bleed iframe (https://preview-<repo>-<sandboxId>.<zone>) with hot reload — the iframe is the
 * surface; controls float over it and reveal on hover, like the workspace's file-viewer chrome. The fallback
 * sidebar element for a plain runnable repo no first-party extension serves. */

const props = defineProps<{ repo: string }>();
const repo = computed(() => props.repo);

const { panels, error: listError, isLoading, start, stop } = usePanels();
const openTerminal = (session: string): void => host().terminal.open(session);
const panel = computed(() => panels.value.find((entry) => entry.repo === repo.value));

const busy = ref(false);
const actionError = ref<string | undefined>(undefined);
// The mounted iframe src — set only after the preview hostname is PROVEN reachable (probe below).
const previewSrc = ref<string | undefined>(undefined);
// True after ~30s of failed probes — surfaces the "DNS may still be propagating" hint.
const probeSlow = ref(false);
// Bumped to cancel an in-flight probe loop (repo switch, panel stop, unmount).
let probeGeneration = 0;

const PROBE_INTERVAL_MS = 3000;
const PROBE_SLOW_AFTER_MS = 30_000;

// Hand the browser the hostname only once a fetch proves it resolves: `no-cors` resolves on ANY HTTP response
// and rejects only on DNS/socket failure — exactly the needed signal, since a freshly-minted DNS record can
// lag at the user's resolver and an iframe that error-pages never retries.
const probeUntilReachable = async (url: string, src: string): Promise<void> => {
    const generation = ++probeGeneration;
    probeSlow.value = false;
    const startedAt = Date.now();
    for (;;) {
        try {
            await fetch(url, { mode: `no-cors`, cache: `no-store` });
            break;
        } catch {
            probeSlow.value = Date.now() - startedAt > PROBE_SLOW_AFTER_MS;
            await new Promise((resolve) => setTimeout(resolve, PROBE_INTERVAL_MS));
        }
        if (generation !== probeGeneration) {
            return;
        }
    }
    if (generation === probeGeneration) {
        previewSrc.value = src;
    }
};

// Resolved when the panel becomes HEALTHY — on `running` the dev server may still be installing/booting.
const resolvePreview = (): void => {
    const current = panel.value;
    if (current === undefined || !current.healthy || current.previewUrl === undefined) {
        probeGeneration += 1;
        previewSrc.value = undefined;
        return;
    }
    void probeUntilReachable(current.previewUrl, current.previewUrl);
};

const statusVariant = (): StatusVariant => (panel.value?.healthy ? `success` : panel.value?.running ? `info` : `neutral`);
const statusLabel = (): string => (panel.value?.healthy ? `healthy` : panel.value?.running ? `starting` : `stopped`);

const act = async (action: (repo: string) => Promise<void>): Promise<void> => {
    actionError.value = undefined;
    busy.value = true;
    try {
        await action(repo.value);
    } catch (err) {
        actionError.value = err instanceof Error ? err.message : `The action failed.`;
    } finally {
        busy.value = false;
    }
};

// Switching repos (rail navigation reuses this component) resets the transient view state.
watch(repo, () => {
    actionError.value = undefined;
    probeGeneration += 1;
    previewSrc.value = undefined;
    probeSlow.value = false;
});
onUnmounted(() => {
    probeGeneration += 1;
});

// (Re)resolve the iframe src whenever the panel's health or the repo changes. Primitive deps, so the poll's
// object-identity churn doesn't re-fire it — the probe starts once when the panel becomes healthy.
watch(
    () => [repo.value, panel.value?.healthy, panel.value?.previewUrl],
    () => resolvePreview(),
    { immediate: true },
);

// Re-key the iframe each time the panel turns healthy: a restarted (or recovered) public panel keeps the same
// src, and Vue would otherwise leave a stale error frame in place instead of re-navigating.
const previewEpoch = ref(0);
watch(
    () => panel.value?.healthy ?? false,
    (healthy, was) => {
        if (healthy && !was) {
            previewEpoch.value += 1;
        }
    },
);
</script>

<template>
    <!-- Full-bleed view: the shell's router-view wrapper adds no padding, so this fills the whole area. -->
    <div class="group relative flex h-full min-h-0 flex-col overflow-hidden">
        <!-- Floating controls, hover-revealed while the iframe is showing (always visible otherwise). -->
        <div
            :class="[
                `absolute right-3 top-3 z-10 flex items-center gap-2 rounded-lg border border-line bg-canvas/70 px-2 py-1.5 backdrop-blur transition-opacity focus-within:opacity-100`,
                previewSrc ? `opacity-0 group-hover:opacity-100` : `opacity-100`,
            ]"
        >
            <span class="px-1 font-mono text-xs text-muted">{{ repo }}</span>
            <StatusBadge v-if="panel?.hasPanel" :variant="statusVariant()" :label="statusLabel()" size="xs" />
            <template v-if="panel?.hasPanel">
                <!-- Only once running: the route is minted at repo creation, but a stopped panel's URL is a 502. -->
                <a
                    v-if="panel.previewUrl && panel.running"
                    :href="panel.previewUrl"
                    target="_blank"
                    rel="noopener"
                    class="flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-overlay hover:text-content"
                    :aria-label="`Open ${repo} preview in a new tab`"
                    v-tooltip.bottom="'Open in new tab'"
                >
                    <Icon name="external-link" />
                </a>
                <Button label="Terminal" size="small" severity="secondary" @click="openTerminal(`panel-${repo}`)">
                    <template #icon><Icon name="align-left" /></template>
                </Button>
                <Button v-if="!panel.running" label="Start" size="small" :disabled="busy" @click="act(start)">
                    <template #icon><Icon name="play" /></template>
                </Button>
                <Button v-else label="Stop" size="small" severity="secondary" :disabled="busy" @click="act(stop)">
                    <template #icon><Icon name="stop" /></template>
                </Button>
            </template>
        </div>

        <!-- Errors overlay the top edge instead of pushing the preview around. -->
        <div v-if="listError || actionError" :class="cmp.alertDanger('absolute inset-x-3 top-16 z-10')">
            {{ listError ?? actionError }}
        </div>

        <!-- Unknown repo (bad URL) or the panels list hasn't loaded yet. -->
        <div v-if="panel === undefined && !isLoading" class="flex flex-1 flex-col items-center justify-center gap-2 text-center text-sm text-muted">
            <p>
                No repository named <span class="font-mono">{{ repo }}</span> in this workspace.
            </p>
        </div>

        <!-- A repo with no operator/ panel: the agent hasn't built one yet. -->
        <div v-else-if="panel && !panel.hasPanel" class="flex flex-1 flex-col items-center justify-center gap-2 text-center">
            <Icon name="desktop" class="text-2xl text-subtle" />
            <p class="text-sm text-muted">
                <span class="font-mono">{{ repo }}</span> has no operator panel yet.
            </p>
            <p class="text-2xs text-subtle">Ask the agent to add an <span class="font-mono">operator/</span> dev server to this repository.</p>
        </div>

        <template v-else-if="panel">
            <!-- The real dev server through the tunnel — hot reload works; apps that forbid framing
                 (X-Frame-Options) stay blank here, the new-tab link is the escape hatch. Mounted only after the
                 hostname probe succeeds, so the browser's DNS error page can never appear. -->
            <iframe
                v-if="previewSrc"
                :key="`${previewEpoch}-${previewSrc}`"
                :src="previewSrc"
                :title="`${repo} preview`"
                class="h-full w-full flex-1 bg-white"
            ></iframe>
            <div v-else-if="panel.running" class="flex flex-1 flex-col items-center justify-center gap-2 text-center">
                <Icon name="spinner" class="text-muted" spin />
                <p class="text-sm text-muted">Preparing the preview…</p>
                <p v-if="probeSlow" class="text-2xs text-subtle">
                    A first start can take a minute while the preview address propagates — Terminals shows the dev server live.
                </p>
            </div>
            <div v-else class="flex flex-1 flex-col items-center justify-center gap-2 text-center">
                <p class="text-sm text-muted">The panel isn't running.</p>
                <Button label="Start" size="small" :disabled="busy" @click="act(start)">
                    <template #icon><Icon name="play" /></template>
                </Button>
            </div>
        </template>
    </div>
</template>
