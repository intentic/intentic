<script setup lang="ts">
import {
    CopyButton,
    Notice,
    noticeOf,
    Picker,
    type PickerGroup,
    probeUntilReachable,
    SegmentedControl,
    StatusBadge,
    type StatusVariant,
} from "@intentic/ui";
import Button from "primevue/button";
import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import { RouterLink, useRouter } from "vue-router";
import { frameSandbox, pickTarget, type PreviewTarget } from "../composables/preview/previewModel";
import { usePreviewTargets } from "../composables/preview/usePreviewTargets";
import { previewAddress, previewOpened, previewSelectedId, selectPreviewTarget, setPreviewAddress } from "../composables/preview/previewSurface";
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
/* Grouped by where a row comes FROM — one heading per repo (an app wears its own name under its repo's), then
 * the forwarded ports, then the workspace's page, then the address the user typed. The row's annotation is its
 * live state, so the list answers "what is up?" before anything is clicked. */
const stateOf = (entry: PreviewTarget): string =>
    entry.kind === `repo` || entry.kind === `app` ? (entry.healthy ? `running` : entry.running ? `starting` : `stopped`) : `live`;
const rowOf = (entry: PreviewTarget) => ({
    value: entry.id,
    label: entry.label,
    description: entry.detail === undefined ? stateOf(entry) : `${entry.detail} · ${stateOf(entry)}`,
});
const pickerGroups = computed<readonly PickerGroup[]>(() => {
    const repos = [...new Set(targets.value.flatMap((entry) => (entry.repo === undefined ? [] : [entry.repo])))];
    const groups: PickerGroup[] = repos.map((repo) => ({
        label: repo,
        options: targets.value.filter((entry) => entry.repo === repo).map(rowOf),
    }));
    const grouped: readonly { readonly label: string; readonly kind: PreviewTarget[`kind`] }[] = [
        { label: `Forwarded ports`, kind: `port` },
        { label: `Workspace`, kind: `public` },
        { label: `Address`, kind: `address` },
    ];
    for (const { label, kind } of grouped) {
        const rows = targets.value.filter((entry) => entry.kind === kind);
        if (rows.length > 0) {
            groups.push({ label, options: rows.map(rowOf) });
        }
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
// What copying this target's URL actually gets you. Everything the sandbox serves answers at a public preview
// hostname, so "public link" is the truth there — and a typed address is somebody else's page, where claiming
// anything about who can open it would be a guess.
const copyHint = computed(() => (target.value?.kind === `address` ? `Copy the address` : `Copy the public link`));

/* --- THE ADDRESS BAR, which is a bar only while it is wanted -----------------------------------------
 * Everything the switcher lists was discovered, and a discovered list is a closed one — so the panel takes a
 * typed address too (a staging URL, another route of the app, a page on another box). It is a TOGGLE rather
 * than a permanent field because this panel's whole design is that the app under preview owns every pixel
 * below one 40px strip, and an always-open URL box would spend a third of that strip on a control most looks
 * never touch. Opened by the link button, by picking the Address row, and by nothing else.
 *
 * The field starts on whatever is on screen, so "the same page one path deeper" is an edit rather than a
 * retype. Enter commits; Escape leaves what was showing alone. */
const addressOpen = ref(false);
const addressDraft = ref(``);
const addressField = ref<HTMLInputElement | undefined>(undefined);

const openAddress = (): void => {
    addressDraft.value = previewAddress.value ?? target.value?.url ?? ``;
    addressOpen.value = true;
    void nextTick(() => addressField.value?.select());
};
const commitAddress = (): void => {
    setPreviewAddress(addressDraft.value);
    addressOpen.value = false;
};
// Picking the Address row with nothing typed yet is a request for the field, not for a blank frame.
watch(
    () => target.value?.kind,
    (kind) => {
        if (kind === `address` && previewAddress.value === undefined) {
            openAddress();
        }
    },
);

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
/* Hand the browser the hostname only once a fetch proves it resolves — an iframe that error-pages never
 * retries, and a freshly-minted DNS record can lag at the user's resolver. The loop and its intervals are the
 * kit's (@intentic/ui portPreview); what is local is the generation counter, which is how a superseded probe
 * stops being allowed to write this panel's state. The public page skips the probe entirely: its address is the
 * sandbox's own, which everything on screen already resolved to load. */
const previewSrc = ref<string | undefined>(undefined);
const probeSlow = ref(false);
const probeFailed = ref(false);
let probeGeneration = 0;

const probeThenShow = async (url: string): Promise<void> => {
    const generation = ++probeGeneration;
    const current = (): boolean => generation === probeGeneration;
    probeSlow.value = false;
    probeFailed.value = false;
    const outcome = await probeUntilReachable(url, {
        stillWanted: current,
        onWaiting: (_elapsed, slow) => {
            probeSlow.value = slow;
        },
    });
    if (!current()) {
        return;
    }
    if (outcome === `reachable`) {
        previewSrc.value = url;
    }
    probeFailed.value = outcome === `gaveUp`;
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
    /* Only a freshly minted preview hostname is worth waiting on. A forwarded port, the outbox and a typed
     * address are all addresses that already exist — probing them would turn a site that simply refuses this
     * browser's fetch into a preview that never appears, and a wrong address into a three-minute spinner
     * instead of the browser's own plain "this didn't load". */
    if (entry.kind !== `repo` && entry.kind !== `app`) {
        probeGeneration += 1;
        previewSrc.value = entry.url;
        return;
    }
    void probeThenShow(entry.url);
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
        <!-- The strip. One row, h-10: switcher + status on the left, verbs on the right — or, while an address
             is being typed, the field takes the left half and the verbs stay put. -->
        <div class="flex h-10 shrink-0 items-center gap-1 border-b border-line bg-card px-1.5">
            <template v-if="addressOpen">
                <input
                    ref="addressField"
                    v-model="addressDraft"
                    type="url"
                    inputmode="url"
                    spellcheck="false"
                    placeholder="localhost:3000, or any address"
                    aria-label="Address to preview"
                    class="min-w-0 flex-1 rounded-md border border-line bg-canvas px-2 py-1 font-mono text-xs text-content placeholder:text-subtle focus:border-primary-500 focus:outline-none"
                    @keydown.enter.prevent="commitAddress"
                    @keydown.esc.prevent="addressOpen = false"
                />
                <Button label="Go" size="small" :disabled="addressDraft.trim().length === 0" @click="commitAddress" />
                <button
                    type="button"
                    class="flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-overlay hover:text-content"
                    aria-label="Cancel"
                    @click="addressOpen = false"
                >
                    <Icon name="times" />
                </button>
            </template>
            <template v-else>
                <Picker
                    v-if="pickerGroups.length > 0"
                    v-model="selected"
                    :options="pickerGroups"
                    variant="ghost"
                    aria-label="Which app to preview"
                    header="Preview"
                />
                <StatusBadge v-if="target && target.startable" :variant="statusVariant" :label="stateOf(target)" size="xs" />
                <!-- Point it somewhere of your own. Always offered, including with nothing discovered at all:
                     that is exactly the state where a typed address is the only preview there can be. -->
                <button
                    type="button"
                    class="flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-overlay hover:text-content"
                    aria-label="Preview another address"
                    v-tooltip.bottom="'Preview another address'"
                    @click="openAddress"
                >
                    <Icon name="link" />
                </button>
            </template>

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
                <!-- A dev server's link is public the moment it answers — a live demo anyone can open — so the
                     copy says so; a typed address is just an address and must not be described as shareable.
                     Offered only while something is actually up, so a copied link never 502s on arrival.
                     `arrow-up-right` for the new tab, because `external-link` belongs to the pop-out below and
                     one bar may not spell two different verbs with one glyph. -->
                <template v-if="target.url && target.healthy">
                    <CopyButton :text="target.url" :aria-label="copyHint" v-tooltip.bottom="copyHint" />
                    <a
                        :href="target.url"
                        target="_blank"
                        rel="noopener"
                        class="flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-overlay hover:text-content"
                        :aria-label="`Open ${target.label} in a new tab`"
                        v-tooltip.bottom="'Open in new tab'"
                    >
                        <Icon name="arrow-up-right" />
                    </a>
                </template>
            </template>

            <!-- `external-link`, the glyph the chat's own pop-out button wears (ChatTabs.vue) — one gesture,
                 one icon. `window-maximize` was here first and read as fullscreen, which is a different
                 promise entirely: the press opens a separate OS window, it does not grow this one. -->
            <button
                type="button"
                class="flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-overlay hover:text-content"
                :aria-label="poppedOut ? `Dock the preview back` : `Move the preview into its own window`"
                v-tooltip.bottom="poppedOut ? 'Dock back' : 'Move into new window'"
                @click="togglePreviewPopout(router)"
            >
                <Icon :name="poppedOut ? 'sign-in' : 'external-link'" />
            </button>
        </div>

        <!-- Errors overlay the top edge instead of pushing the preview around. -->
        <div class="relative flex min-h-0 flex-1 flex-col">
            <Notice v-if="actionError" :of="noticeOf(actionError)" class="absolute inset-x-3 top-3 z-10" />

            <!-- NOTHING TO PREVIEW. Only claimed once the lists have actually answered — and it always offers
                 the one preview that needs nothing discovered, which is an address the user knows themselves. -->
            <div v-if="!target && settled" class="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
                <Icon name="eye" class="text-2xl text-subtle" />
                <p class="text-sm text-muted">Nothing to preview yet.</p>
                <p class="max-w-sm text-2xs text-subtle">
                    Start a dev server in a repository, or ask the agent to build an app — its live preview appears here the moment it answers.
                </p>
                <Button label="Preview an address" size="small" severity="secondary" @click="openAddress">
                    <template #icon><Icon name="link" /></template>
                </Button>
            </div>
            <div v-else-if="!target" class="flex flex-1 items-center justify-center" role="status" aria-busy="true">
                <span class="sr-only">Reading what can be previewed…</span>
                <Icon name="spinner" spin class="text-2xl text-subtle" aria-hidden="true" />
            </div>

            <!-- The app itself: the real dev server through the tunnel — hot reload works; apps that forbid
                 framing (X-Frame-Options) stay blank here, and the new-tab link is the escape hatch. Mounted
                 only after the hostname probe succeeds, so the browser's DNS error page can never appear.

                 A SERVER GETS ITS OWN ORIGIN — see frameSandbox, which owns that rule and why the previous
                 blanket sandbox left a dev server's own images 403ing inside its own preview. -->
            <div v-else-if="previewSrc" class="flex min-h-0 flex-1 justify-center overflow-hidden">
                <iframe
                    :key="`${previewEpoch}-${previewSrc}`"
                    :src="previewSrc"
                    :title="`${target.label} preview`"
                    :sandbox="frameSandbox(target.kind)"
                    class="h-full min-h-0 flex-1 bg-white"
                    :class="fit === `phone` ? `max-w-[390px] border-x border-line` : ``"
                ></iframe>
            </div>

            <!-- ANSWERING, BUT NOT THROUGH ANYTHING THIS PANEL CAN REACH: a dev server started in a terminal
                 binds a port the preview proxy was never told about, so the repo's own preview hostname routes
                 to nothing. Both ways out are here, and the ports page is the one that keeps the running
                 server (starting it from here would leave two). -->
            <div v-else-if="target.healthy && !target.url" class="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
                <Icon name="globe" class="text-2xl text-subtle" />
                <p class="text-sm text-muted">
                    <span class="font-mono">{{ target.label }}</span> is answering, but not from a preview this panel can open.
                </p>
                <p class="max-w-sm text-2xs text-subtle">
                    Something started it outside this panel — a terminal, a container. Forward its port and it appears here as its own entry.
                </p>
                <RouterLink
                    to="/sandbox/ports"
                    class="rounded-md border border-line px-2.5 py-1 text-xs text-content transition-colors hover:border-line-strong hover:bg-overlay"
                >
                    Open Ports
                </RouterLink>
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
