<script setup lang="ts">
import {
    Button,
    CopyButton,
    Notice,
    noticeOf,
    Picker,
    type PickerGroup,
    type PreviewProbe,
    probePreview,
    SegmentedControl,
    StatusBadge,
    type StatusVariant,
    ui,
} from "@intentic/ui";
import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import { RouterLink, useRouter } from "vue-router";
import { frameSandbox, pickTarget, type PreviewTarget } from "../composables/preview/previewModel";
import { usePreviewTargets } from "../composables/preview/usePreviewTargets";
import { previewAddress, previewOpened, previewSelectedId, selectPreviewTarget, setPreviewAddress } from "../composables/preview/previewSurface";
import { togglePreviewFloating, usePreviewFloating } from "../composables/preview/previewFloating";
import { useTerminalPanel } from "../composables/terminal/useTerminalPanel";

/* THE ONE PREVIEW PANEL: the live, clickable app, full-bleed under one slim strip of chrome. Mounted once per
 * window (shell/PoppablePanels) and teleported between the /preview area, a floating window's whole canvas and
 * the parking stage, so the iframe, and the previewed app's own state inside it, survives every move in a
 * window. Moving it to a window of its OWN is a fresh instance, which is the one place the app under preview
 * reloads (composables/floating.ts states that trade).
 *
 * DESIGNED FOR ONE SCREEN WITH NO ROOM TO SPARE. The app under preview gets everything below a single h-10
 * bar; nothing floats over it (hover-revealed chrome steals the exact pixels the previewed app's own header
 * sits under, and an overlay that appears on the way to a button in the app is chrome fighting content). The
 * bar holds the whole vocabulary: WHICH app (the switcher), whether it is UP (the badge), and the verbs:
 * start/stop, reload, phone width, its terminal, its public link, a window of its own.
 *
 * A REAL IFRAME, NOT A STREAMED BROWSER. The dev server already answers at a public preview hostname, so the
 * page here is the app itself: clickable at native latency, hot-reloading as the agent edits, where
 * /browsers shows screenshots of a browser the AGENT is driving. The two surfaces answer different questions
 * ("what is my app like" vs "what is the agent doing"), which is why this is not that view. */

const router = useRouter();
// Mounted ⇔ opened (PoppablePanels), so the panel's own lifetime gates the per-monorepo apps fan-out.
const { targets, settled, start, stop, forward } = usePreviewTargets(previewOpened);
const target = computed(() => pickTarget(targets.value, previewSelectedId.value));

const { floats } = usePreviewFloating();
const terminal = useTerminalPanel();

// --- The switcher -------------------------------------------------------------------------------
/* Grouped by where a row comes FROM: one heading per repo (an app wears its own name under its repo's), then
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
// hostname, so "public link" is the truth there, and a typed address is somebody else's page, where claiming
// anything about who can open it would be a guess.
const copyHint = computed(() => (target.value?.kind === `address` ? `Copy the address` : `Copy the public link`));

/* --- THE ADDRESS BAR, which is a bar only while it is wanted -----------------------------------------
 * Everything the switcher lists was discovered, and a discovered list is a closed one, so the panel takes a
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

/* Preview ONE of the servers a fanned-out repo is really running: forward that port and land on the target it
 * becomes. The forward is a publish (that address is open to anyone holding it), which the screen says next to
 * the button rather than here, and the Ports view is where one is taken back. */
const forwarding = ref<number | undefined>(undefined);
const previewServer = async (port: number): Promise<void> => {
    actionError.value = undefined;
    forwarding.value = port;
    try {
        const id = await forward(port);
        if (id === undefined) {
            actionError.value = `This sandbox has no public preview address, so its ports can't be previewed from a browser.`;
            return;
        }
        selectPreviewTarget(id);
    } catch (error) {
        actionError.value = error instanceof Error ? error.message : `Forwarding port ${port} failed.`;
    } finally {
        forwarding.value = undefined;
    }
};

// --- The iframe, probe-gated --------------------------------------------------------------------
/* NOTHING IS FRAMED UNTIL THE ADDRESS HAS ANSWERED FOR ITSELF. An iframe that error-pages never retries, a
 * freshly-minted name lags at the user's resolver, and, worst of the three, an address that reaches no sandbox
 * at all still gets an answer: the edge's own 502, whose error page carries X-Frame-Options, which the browser
 * renders as a bare "<host> refused to connect" inside the frame. So the kit's probe (@intentic/ui
 * portPreview) asks the preview proxy about ITSELF over a CORS-open path, and this panel shows the answer it
 * gives instead of guessing from a request that settled. What is local here is the generation counter, which is
 * how a superseded probe stops being allowed to write this panel's state.
 *
 * Everything the sandbox serves is probed, panels, forwarded ports and the outbox alike; only a typed address
 * is not, because it is somebody else's site, it has no probe to answer, and a wrong one deserves the browser's
 * own plain "this didn't load" rather than a three-minute spinner. */
const previewSrc = ref<string | undefined>(undefined);
const probeSlow = ref(false);
const probing = ref(false);
const reach = ref<PreviewProbe | undefined>(undefined);
let probeGeneration = 0;

const probeThenShow = async (url: string): Promise<void> => {
    const generation = ++probeGeneration;
    const current = (): boolean => generation === probeGeneration;
    probeSlow.value = false;
    probing.value = true;
    reach.value = undefined;
    const probe = await probePreview(url, {
        stillWanted: current,
        onWaiting: (_elapsed, slow) => {
            probeSlow.value = slow;
        },
    });
    if (!current()) {
        return;
    }
    probing.value = false;
    reach.value = probe;
    if (probe.outcome === `reached` && probe.state === `serving`) {
        previewSrc.value = url;
    }
};

/* Resolved when the daemon has published an address for this target: `url` is present exactly while the
 * sandbox's own preview proxy resolves it to something serving, so its absence is one of the explained states
 * below (starting, several servers, nothing running) rather than a wait. */
const resolvePreview = (): void => {
    const entry = target.value;
    probeGeneration += 1;
    previewSrc.value = undefined;
    probeSlow.value = false;
    probing.value = false;
    reach.value = undefined;
    if (entry === undefined || entry.url === undefined) {
        return;
    }
    if (entry.kind === `address`) {
        previewSrc.value = entry.url;
        return;
    }
    void probeThenShow(entry.url);
};

// (Re)resolve on the facts that matter: primitive deps, so the poll's object churn doesn't re-fire it, and
// re-key the iframe when the target changes or its address comes back (a restarted server keeps its src, and
// Vue would otherwise leave the stale error frame in place instead of re-navigating).
const previewEpoch = ref(0);
watch(
    () => [target.value?.id, target.value?.url] as const,
    (now, was) => {
        actionError.value = undefined;
        // `was` is absent on the immediate first run, which is also a fresh mount: a fresh key either way.
        if (was === undefined || now[0] !== was[0] || (now[1] !== undefined && was[1] === undefined)) {
            previewEpoch.value += 1;
        }
        resolvePreview();
    },
    { immediate: true },
);
onUnmounted(() => {
    probeGeneration += 1;
});

// The bar's own reload: the previewed app navigated somewhere, or the user wants a clean load after an edit
// hot reload went wrong. Re-keying is the only reliable cross-origin reload.
const reload = (): void => {
    previewEpoch.value += 1;
};

/* Phone width. The one responsive question a builder asks constantly ("does this survive a phone?") answered
 * in place instead of through devtools on a cross-origin frame. Full is the default and the panel's whole
 * width; phone centres a 390px column (a current iPhone's CSS width) on the canvas. */
const fit = ref<`full` | `phone`>(`full`);

/* --- WHAT START IS ABOUT TO DO -------------------------------------------------------------------
 * A button labelled "Start" in a workspace of several repositories says nothing about WHICH thing starts,
 * WHAT it runs, or where the output goes, and it is not a small action: it installs dependencies on first use
 * and then runs the repository's own dev command, which can take minutes and can bring up whatever that
 * command brings up. So the sentence next to it names all three, and the terminal it names is real, the
 * daemon's own convention (`panel-<repo>` / `panel-<repo>--<app>`), which is where the output, and any failure,
 * actually lands. */
const startSession = computed<string | undefined>(() => {
    const entry = target.value;
    if (entry?.repo === undefined || !entry.startable) {
        return undefined;
    }
    return entry.app === undefined ? `panel-${entry.repo}` : `panel-${entry.repo}--${entry.app}`;
});
const startHint = computed<string | undefined>(() => {
    const entry = target.value;
    if (entry === undefined || !entry.startable || startSession.value === undefined) {
        return undefined;
    }
    const what =
        entry.app === undefined ? `${entry.repo}'s own dev server (its operator/ panel, or its dev script)` : `the ${entry.app} app's dev server`;
    return `Runs ${what} in the sandbox, installing its dependencies first if they're missing. It appears in the terminal ${startSession.value}, and a first start can take a few minutes.`;
});
</script>

<template>
    <div class="flex h-full min-h-0 w-full flex-col bg-canvas">
        <!-- The strip. One row, h-10: switcher + status on the left, verbs on the right, or, while an address
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
                <button type="button" :class="ui.iconButton(`h-8 w-8`)" aria-label="Cancel" @click="addressOpen = false">
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
                <!-- Up or down, for the things that can be either. On kind, not on `startable`: a monorepo with
                     no root `dev` script can't be started from here and is still plainly running or not. -->
                <StatusBadge
                    v-if="target && (target.kind === `repo` || target.kind === `app`)"
                    :variant="statusVariant"
                    :label="stateOf(target)"
                    size="xs"
                />
                <!-- Point it somewhere of your own. Always offered, including with nothing discovered at all:
                     that is exactly the state where a typed address is the only preview there can be. -->
                <button
                    type="button"
                    :class="ui.iconButton(`h-8 w-8`)"
                    aria-label="Preview another address"
                    v-tooltip.bottom="'Preview another address'"
                    @click="openAddress"
                >
                    <Icon name="link" />
                </button>
            </template>

            <span class="flex-1"></span>

            <template v-if="target">
                <!-- The verb carries what it will do: in a workspace of several repositories the button alone
                     names neither the target nor the command, and this one installs and runs things. -->
                <Button
                    v-if="target.startable && !target.running"
                    label="Start"
                    size="small"
                    :disabled="busy"
                    v-tooltip.bottom="startHint"
                    @click="act(start)"
                >
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
                    :class="ui.iconButton(`h-8 w-8`)"
                    aria-label="Reload the preview"
                    v-tooltip.bottom="'Reload'"
                    @click="reload"
                >
                    <Icon name="refresh" />
                </button>
                <button
                    v-if="target.session"
                    type="button"
                    :class="ui.iconButton(`h-8 w-8`)"
                    aria-label="Open this dev server's terminal"
                    v-tooltip.bottom="'Terminal'"
                    @click="terminal.openFocused(target.session!)"
                >
                    <Icon name="code" />
                </button>
                <!-- A dev server's link is public the moment it answers: a live demo anyone can open, so the
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
                        :class="ui.iconButton(`h-8 w-8`)"
                        :aria-label="`Open ${target.label} in a new tab`"
                        v-tooltip.bottom="'Open in new tab'"
                    >
                        <Icon name="arrow-up-right" />
                    </a>
                </template>
            </template>

            <!-- `external-link`, the glyph the chat's own pop-out button wears (ChatTabs.vue): one gesture,
                 one icon. `window-maximize` was here first and read as fullscreen, which is a different
                 promise entirely: the press opens a separate OS window, it does not grow this one. -->
            <button
                type="button"
                :class="ui.iconButton(`h-8 w-8`)"
                :aria-label="floats ? `Dock the preview back` : `Move the preview into its own window`"
                v-tooltip.bottom="floats ? 'Dock back' : 'Move into new window'"
                @click="togglePreviewFloating()"
            >
                <Icon :name="floats ? 'sign-in' : 'external-link'" />
            </button>
        </div>

        <!-- An action that failed reports IN FLOW, at the top of the panel it failed in. It used to float over
             the preview's top edge on an absolute offset of its own, which is the shape this app now reserves
             for one thing only — the notification lane — and this is not one of its three kinds: it is a
             view-local failure, it belongs beside the controls that raised it, and pushing the preview down by
             two lines is a smaller imposition than covering the top of the page being previewed. -->
        <div class="flex min-h-0 flex-1 flex-col">
            <Notice v-if="actionError" :of="noticeOf(actionError)" class="mx-3 mt-3" />

            <!-- NOTHING TO PREVIEW. Only claimed once the lists have actually answered, and it always offers
                 the one preview that needs nothing discovered, which is an address the user knows themselves. -->
            <div v-if="!target && settled" class="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
                <Icon name="eye" class="text-2xl text-subtle" />
                <p class="text-sm text-muted">Nothing to preview yet.</p>
                <p class="max-w-sm text-2xs text-subtle">
                    Start a dev server in a repository, or ask the agent to build an app: its live preview appears here the moment it answers.
                </p>
                <Button label="Preview an address" size="small" severity="secondary" @click="openAddress">
                    <template #icon><Icon name="link" /></template>
                </Button>
            </div>
            <div v-else-if="!target" class="flex flex-1 items-center justify-center" role="status" aria-busy="true">
                <span class="sr-only">Reading what can be previewed…</span>
                <Icon name="spinner" spin class="text-2xl text-subtle" aria-hidden="true" />
            </div>

            <!-- The app itself: the real dev server through the tunnel, hot reload works; apps that forbid
                 framing (X-Frame-Options) stay blank here, and the new-tab link is the escape hatch. Mounted
                 only after the hostname probe succeeds, so the browser's DNS error page can never appear.

                 A SERVER GETS ITS OWN ORIGIN: see frameSandbox, which owns that rule and why the previous
                 blanket sandbox left a dev server's own images 403ing inside its own preview. -->
            <div v-else-if="previewSrc" class="flex min-h-0 flex-1 justify-center overflow-hidden">
                <iframe
                    :key="`${previewEpoch}-${previewSrc}`"
                    :src="previewSrc"
                    :title="`${target.label} preview`"
                    :sandbox="frameSandbox(target.kind)"
                    class="h-full min-h-0 flex-1 bg-white"
                    :class="fit === `phone` ? `max-w-phone border-x border-line` : ``"
                ></iframe>
            </div>

            <!-- THE ADDRESS REACHES NO SANDBOX. The name resolved and something answered, and it was not this
                 sandbox's preview proxy: no route was ever attached for it (a box with no tunnel grant
                 publishes none), or the record is still propagating. This is the state the panel used to have
                 no words for, because the probe called any answer a success and framed it, leaving the user
                 with the browser's own "refused to connect" and nowhere to go. Forwarded ports are the way out
                 that does not depend on a per-panel name. -->
            <div v-else-if="reach?.outcome === `unreachable`" class="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
                <Icon name="exclamation-triangle" class="text-2xl text-subtle" />
                <p class="text-sm text-muted">This preview address doesn't reach your sandbox.</p>
                <p class="max-w-sm text-2xs text-subtle">
                    <span class="font-mono">{{ target.url }}</span> answers from somewhere that isn't this sandbox's preview proxy: its name may still
                    be propagating, or this sandbox publishes no preview hostnames at all.
                </p>
                <div class="flex items-center gap-2">
                    <Button label="Try again" size="small" severity="secondary" @click="resolvePreview()" />
                    <RouterLink
                        to="/sandbox/ports"
                        class="rounded-md border border-line px-2.5 py-1 text-xs text-content transition-colors hover:border-line-strong hover:bg-overlay"
                    >
                        Open Ports
                    </RouterLink>
                </div>
            </div>

            <!-- ANSWERING ON PORTS NO ONE HOSTNAME CAN STAND FOR. The ordinary monorepo: `dev` fans a turbo run
                 out across packages that each pin their own port, so the repo is plainly up and its repo-level
                 preview address means nothing. Naming what it IS serving is the whole answer, and picking one
                 finishes it right here: forwarding is what makes a port previewable, and it is one press. -->
            <div v-else-if="!target.url && target.servers.length > 0" class="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
                <Icon name="globe" class="text-2xl text-subtle" />
                <p class="text-sm text-muted">
                    <span class="font-mono">{{ target.label }}</span> is running
                    {{ target.servers.length === 1 ? `a dev server` : `${target.servers.length} dev servers` }} on
                    {{ target.servers.length === 1 ? `a port` : `ports` }} of {{ target.servers.length === 1 ? `its` : `their` }} own, so one preview
                    address can't stand for it. Pick the one you mean:
                </p>
                <ul class="flex w-full max-w-md flex-col gap-1">
                    <li
                        v-for="server in target.servers"
                        :key="server.port"
                        class="flex items-center justify-between gap-3 rounded-md border border-line px-2.5 py-1.5 text-left"
                    >
                        <span class="min-w-0 truncate font-mono text-2xs text-subtle">
                            {{ server.dir ? `${server.dir} · ` : `` }}{{ server.url }}
                        </span>
                        <Button
                            :label="forwarding === server.port ? `Opening…` : `Preview`"
                            size="small"
                            severity="secondary"
                            :disabled="forwarding !== undefined"
                            @click="previewServer(server.port)"
                        />
                    </li>
                </ul>
                <p class="max-w-sm text-2xs text-subtle">
                    Previewing one forwards its port, which publishes it at an address anyone with the link can open. The Ports view lists every
                    forward and takes them back.
                </p>
            </div>

            <!-- STARTED, NOT YET SERVING: installing, compiling, or failing in its terminal, which is the one
                 place that says which. Also covers the wait on a freshly minted name. -->
            <div v-else-if="probing || target.running" class="flex flex-1 flex-col items-center justify-center gap-2 text-center">
                <Icon name="spinner" class="text-muted" spin />
                <p class="text-sm text-muted">Preparing the preview…</p>
                <p v-if="probeSlow || target.running" class="max-w-sm text-2xs text-subtle">
                    A first start can take a few minutes while dependencies install and the address propagates: the terminal shows the dev server
                    live.
                </p>
                <Button
                    v-if="target.session"
                    label="Open its terminal"
                    size="small"
                    severity="secondary"
                    @click="terminal.openFocused(target.session!)"
                />
            </div>

            <!-- NOT RUNNING, and the one screen where a button is about to do something substantial: it says
                 what, where, and how long, because "Start" alone answers none of the three. -->
            <div v-else class="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
                <p class="text-sm text-muted">
                    <span class="font-mono">{{ target.label }}</span> isn't running.
                </p>
                <p v-if="startHint" class="max-w-md text-2xs text-subtle">{{ startHint }}</p>
                <p v-else class="max-w-md text-2xs text-subtle">
                    It has no dev server this panel can start: no <span class="font-mono">operator/</span> panel and no
                    <span class="font-mono">dev</span> script at its root. Anything it runs from a terminal shows up under Forwarded ports.
                </p>
                <Button v-if="target.startable" label="Start" size="small" :disabled="busy" class="mt-1" @click="act(start)">
                    <template #icon><Icon name="play" /></template>
                </Button>
            </div>
        </div>
    </div>
</template>
