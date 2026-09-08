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
import { useNow } from "@intentic/ui/async";
import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import { RouterLink, useRouter } from "vue-router";
import type { PanelLaunch } from "@intentic/api-contract";
import { frameSandbox, pickTarget, type PreviewTarget } from "./previewModel";
import { usePreviewTargets } from "./usePreviewTargets";
import { previewAddress, previewOpened, previewSelectedId, selectPreviewTarget, setPreviewAddress } from "./previewSurface";
import { togglePreviewFloating, usePreviewFloating } from "./previewFloating";
import { useTerminalPanel } from "../terminal/useTerminalPanel";

// Real iframe onto the dev server's own public hostname, not a streamed screenshot. Teleported between the /preview
// area, a floating window and the parking stage; state survives every move except into its own window, which is a fresh
// instance. Everything below one h-10 strip belongs to the app under preview.

const router = useRouter();
// Mounted ⇔ opened (PoppablePanels), so the panel's own lifetime gates the per-monorepo apps fan-out.
const { targets, settled, start, stop, forward, refresh } = usePreviewTargets(previewOpened);
const target = computed(() => pickTarget(targets.value, previewSelectedId.value));

const { floats } = usePreviewFloating();
const terminal = useTerminalPanel();

// The switcher
// Grouped by where a row comes from: one heading per repo, then forwarded ports, the workspace page, the address. Each
// row's annotation is its live state, so the list answers "what is up?" unclicked.
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
// Everything the sandbox serves has a public link; a typed address isn't claimed as shareable.
const copyHint = computed(() => (target.value?.kind === `address` ? `Copy the address` : `Copy the public link`));

// Toggle, not a permanent field, so the previewed app keeps every pixel below the bar; opened by the link button or the
// Address row. Starts prefilled with the current URL; Enter commits, Escape cancels.
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

// Start / stop
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

// Forwards one server of a fanned-out repo and lands on the target it becomes. Forwarding publishes the port; the Ports
// view is where it's taken back.
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

// The iframe, probe-gated
// Nothing is framed until the address probes itself as reachable (an iframe never retries a DNS/502 error page); a
// generation counter drops a superseded probe. Only sandbox-served targets are probed; a typed address gets the
// browser's own error.
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

// Resolves once the daemon has published an address for the target; url's absence is one of the explained states below
// (starting, fanned out, not running), not a wait.
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

// Re-resolves on primitive deps only, so the poll's object churn doesn't re-fire it; re-keys the iframe when the target
// or its address changes, since a restarted server would otherwise keep the stale frame.
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

// Reloads by re-keying the iframe, the only reliable reload across origins.
const reload = (): void => {
    previewEpoch.value += 1;
};

// Full is the panel's whole width; phone centers a 390px column (current iPhone CSS width) in place of devtools.
const fit = ref<`full` | `phone`>(`full`);

// Names what Start will run and where its output lands (`panel-<repo>` / `panel-<repo>--<app>`), since a bare "Start"
// names neither the target nor the command it's about to run.
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
    // Cost is read off the tree's install state, not assumed.
    const cost = entry.installed
        ? `Its dependencies are installed, so it's up in a few seconds.`
        : `Its dependencies aren't installed yet, so they install first, which can take a few minutes.`;
    return `Runs ${what} in the sandbox. It appears in the terminal ${startSession.value}. ${cost}`;
});

/* HOW LONG THIS WAIT HAS BEEN GOING, because the screen below is a promise ("the preview opens the moment it
 * answers") and a promise with no clock on it is what the reported spinner was: "Its dev server is starting"
 * over a start that had been going for ten minutes reads exactly like one that has been going for ten
 * seconds. Stamped when the wait begins (the same condition the fallback poll runs on, below) and cleared
 * when it ends, so a target that comes up and goes down again starts a fresh clock. */
const waitingSince = ref<number | undefined>(undefined);
const now = useNow(() => waitingSince.value !== undefined);
const waitedMs = computed(() => (waitingSince.value === undefined ? 0 : now.value - waitingSince.value));
// Past this, a start is no longer "starting": something in its terminal is waiting or stuck, and the honest
// screen says so and offers the way out. A dev server that is going to come up has come up long before this;
// the starter site takes seconds on an installed tree.
const STARTING_SLOW_MS = 60_000;
const waitingLong = computed(() => waitedMs.value > STARTING_SLOW_MS);
const waitedFor = computed(() => {
    const minutes = Math.floor(waitedMs.value / 60_000);
    return minutes < 1 ? `${Math.floor(waitedMs.value / 1000)}s` : `${minutes} min`;
});

/* WHAT THE STARTING SCREEN SAYS, off the daemon's own account of where the start has got to (PanelLaunch)
 * rather than a fixed sentence about installs. `exited` is the one that matters most: a dev command that died
 * on its first line used to sit behind "Preparing the preview…" for as long as anyone cared to wait. Each
 * state has two sentences, the wait and the verdict, because a start that has outlived any reasonable start
 * is no longer a wait: the screen stops promising an iframe and starts pointing at the terminal. */
const LAUNCH_HINTS: Record<PanelLaunch, { readonly waiting: string; readonly overdue: (waited: string) => string }> = {
    launching: {
        waiting: `Opening its terminal.`,
        overdue: (waited) =>
            `Its terminal has been opening for ${waited}, which is far longer than it should: the sandbox may be out of memory or CPU. Restart it below.`,
    },
    installing: {
        waiting: `Installing its dependencies first, which can take a few minutes: its terminal shows the install live.`,
        overdue: (waited) =>
            `Still installing its dependencies after ${waited}. Its terminal shows the install live: a slow registry is normal, an error there is not.`,
    },
    starting: {
        waiting: `Its dev server is starting; the preview opens the moment it answers.`,
        overdue: (waited) =>
            `Its dev server has been starting for ${waited} without answering, which a working start never takes. Its terminal shows what it is waiting on; restarting it is the usual fix.`,
    },
    exited: {
        waiting: `Its dev server exited before it served anything. Its terminal has the reason.`,
        overdue: () => `Its dev server exited before it served anything. Its terminal has the reason.`,
    },
};
const launchHint = computed<string | undefined>(() => {
    const entry = target.value;
    if (entry === undefined) {
        return undefined;
    }
    if (entry.launch !== undefined) {
        const hint = LAUNCH_HINTS[entry.launch];
        return waitingLong.value ? hint.overdue(waitedFor.value) : hint.waiting;
    }
    // No launch state: the daemon sees it serving (or does not run it), and it is the ADDRESS that has not
    // answered. Past the minute that is a routing problem to name, not a start to wait out.
    if (waitingLong.value) {
        return `Its dev server is up, but its preview address has not answered in ${waitedFor.value}: this sandbox's public address may not be routing yet. Its terminal shows the server live.`;
    }
    return probeSlow.value ? `The address is taking a while to answer: its terminal shows the dev server live.` : undefined;
});

/* THE WAY OUT OF A STUCK START: end the pane and start it again, which is what a person does in the terminal
 * once they have looked. One press rather than Stop then Start, because by the time this button is drawn the
 * screen has already told them the start is stuck, and two presses to act on that is one too many. */
const restart = (): Promise<void> =>
    act(async (entry) => {
        await stop(entry);
        await start(entry);
    });

/* THE WAIT'S OWN FALLBACK. The daemon pushes the flip from starting to serving, and this panel re-probes when
 * the pushed list carries the address; a frame dropped across a reconnect left both waiting for ever. While a
 * start is being watched, ask again every few seconds. Cheap (one invalidation of two shared entries), and it
 * stops the moment the wait does. */
const STARTING_POLL_MS = 10_000;
let startingPoll: ReturnType<typeof setInterval> | undefined;
const stopStartingPoll = (): void => {
    clearInterval(startingPoll);
    startingPoll = undefined;
};
watch(
    () => target.value?.running === true && previewSrc.value === undefined && reach.value?.outcome !== `unreachable`,
    (waiting) => {
        stopStartingPoll();
        waitingSince.value = waiting ? Date.now() : undefined;
        if (waiting) {
            startingPoll = setInterval(() => void refresh().catch(() => undefined), STARTING_POLL_MS);
        }
    },
    { immediate: true },
);
onUnmounted(stopStartingPoll);
</script>

<template>
    <div class="flex h-full min-h-0 w-full flex-col bg-canvas">
        <!-- One h-10 row: switcher and status on the left, verbs on the right; typing an address swaps the left half for the field. -->
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
                    class="ui-field-box ui-field-sm min-w-0 flex-1 font-mono"
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
                <!--
                    Shown for repo/app kinds regardless of startable; a monorepo with no root `dev` can't be started here but is still running or
                    not.
                -->
                <StatusBadge
                    v-if="target && (target.kind === `repo` || target.kind === `app`)"
                    :variant="statusVariant"
                    :label="stateOf(target)"
                    size="xs"
                />
                <!-- Always offered, even with nothing discovered: a typed address is the only preview possible then. -->
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
                <!-- Tooltip names target and command, since "Start" alone says neither in a multi-repo workspace. -->
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
                <!--
                    Shown only once the target answers, so a copied link never 502s; `arrow-up-right` here since `external-link` is reserved for the
                    window pop-out below.
                -->
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

            <!-- external-link, matching the chat's pop-out button; opens a separate OS window, not fullscreen. -->
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

        <!--
            Reports in flow, not through the notification lane: a view-local failure belongs beside the controls that raised it, pushing the preview
            down rather than covering it.
        -->
        <div class="flex min-h-0 flex-1 flex-col">
            <Notice v-if="actionError" :of="noticeOf(actionError)" class="mx-3 mt-3" />

            <!-- Claimed only once the lists have answered; always offers a typed address, the one preview needing nothing discovered. -->
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

            <!--
                Real dev server through the tunnel; a server that forbids framing (X-Frame-Options) stays blank, with the new-tab link as the escape
                hatch. Mounted only once the hostname probe succeeds, so no DNS error page ever appears.
            -->
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

            <!--
                Something answered, but not this sandbox's preview proxy: no route was ever attached, or the record is still propagating. Forwarded
                ports don't depend on a per-panel name.
            -->
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

            <!--
                Ordinary monorepo shape: `dev` fans out across packages on their own ports, so no single preview address applies. Forwarding one, in
                one press, is what makes it previewable.
            -->
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
            <div v-else-if="probing || target.running" class="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
                <Icon v-if="target.launch === `exited` || waitingLong" name="exclamation-triangle" class="text-2xl text-subtle" />
                <Icon v-else name="spinner" class="text-muted" spin />
                <!-- Three headings for three states: a verdict, a wait that has gone on too long to still be
                     called one, and the wait itself. -->
                <p class="text-sm text-muted">
                    {{ target.launch === `exited` ? `Its dev server stopped.` : waitingLong ? `This is taking too long.` : `Preparing the preview…` }}
                </p>
                <p v-if="launchHint" class="max-w-sm text-2xs text-subtle">{{ launchHint }}</p>
                <div class="flex flex-wrap items-center justify-center gap-2">
                    <Button
                        v-if="target.session"
                        label="Open its terminal"
                        size="small"
                        severity="secondary"
                        @click="terminal.openFocused(target.session!)"
                    />
                    <!-- Offered only once the wait has become a verdict: a Restart beside a ten-second spinner
                         invites the click that turns a slow start into a slower one. -->
                    <Button
                        v-if="target.startable && (waitingLong || target.launch === `exited`)"
                        label="Restart"
                        size="small"
                        :disabled="busy"
                        @click="restart"
                    >
                        <template #icon><Icon name="refresh" /></template>
                    </Button>
                </div>
            </div>

            <!-- Not running, the one screen where the button is about to do something substantial, so it says what, where, and how long. -->
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
