<!-- One live app as a Browsers tab: a real iframe onto the dev server's own public hostname (or its loopback twin), not a
     streamed picture, with every state between "nothing runs" and "it answers" explained in its place. One per pinned
     app, kept mounted while another tab is in front, so the app keeps whatever state the reader built up in it. Its own
     verbs (start, stop, its terminal) go into the Browsers toolbar while it is in front; the address bar, reload and the
     phone frame are the toolbar's, steering this tab through what it exposes. -->
<script setup lang="ts">
import { Button, EmptyState, Notice, noticeOf, probePreview, probePreviewOnce, type PreviewProbe, type Tip, ui } from "@intentic/ui";
import { useNow, usePoll } from "@intentic/ui/async";
import { computed, onUnmounted, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import type { PanelLaunch } from "@intentic/sandbox-contract";
import { frameSandbox, type PreviewTarget } from "./previewModel";
import { loopbackPreviewUrl } from "./previewLane";
import type { PhoneModel } from "./phoneModels";
import PreviewStage from "./PreviewStage.vue";
import { useEndpoint } from "../../client/endpoint/useEndpoint";
import { useTerminalPanel } from "../terminal/useTerminalPanel";
import { useT } from "@intentic/ui/i18n";

export interface PreviewActions {
    readonly start: (target: PreviewTarget) => Promise<void>;
    readonly stop: (target: PreviewTarget) => Promise<void>;
    // Forwards one server of a fanned-out repo; answers the target it becomes, if it got a public address.
    readonly forward: (port: number) => Promise<string | undefined>;
    readonly refresh: () => Promise<void>;
}

const {
    target,
    settled,
    active,
    toolsTo,
    phone,
    compact = false,
    actions,
} = defineProps<{
    // The app this tab is of, as the live list has it now; undefined while the list reads, or once the app is gone.
    target: PreviewTarget | undefined;
    // Whether the live list has answered, so "gone" is a fact rather than a guess.
    settled: boolean;
    // In front and on screen: what puts this tab's verbs into the toolbar.
    active: boolean;
    // Where those verbs go: the toolbar's slot for the tab in front.
    toolsTo: HTMLElement | undefined;
    phone: PhoneModel | undefined;
    compact?: boolean;
    actions: PreviewActions;
}>();

// `open`: a server of a fanned-out repo was forwarded into a target of its own, which wants a tab of its own. `close`:
// the reader dismissed a tab whose app is no longer there.
const emit = defineEmits<{ open: [targetId: string]; close: [] }>();

const t = useT();
const terminal = useTerminalPanel();

// Start / stop
const busy = ref(false);
const actionError = ref<string | undefined>(undefined);
const act = async (action: (entry: PreviewTarget) => Promise<void>): Promise<void> => {
    const entry = target;
    if (entry === undefined) {
        return;
    }
    actionError.value = undefined;
    busy.value = true;
    try {
        await action(entry);
    } catch (error) {
        actionError.value = error instanceof Error ? error.message : t(`preview.previewPanel.actionFailed`);
    } finally {
        busy.value = false;
    }
};
const start = (entry: PreviewTarget): Promise<void> => actions.start(entry);
const stop = (entry: PreviewTarget): Promise<void> => actions.stop(entry);

// Forwards one server of a fanned-out repo and opens the target it becomes. Forwarding publishes the port; the Ports
// view is where it's taken back.
const forwarding = ref<number | undefined>(undefined);
const previewServer = async (port: number): Promise<void> => {
    actionError.value = undefined;
    forwarding.value = port;
    try {
        const id = await actions.forward(port);
        if (id === undefined) {
            actionError.value = t(`preview.previewPanel.noPublicAddress`);
            return;
        }
        emit(`open`, id);
    } catch (error) {
        actionError.value = error instanceof Error ? error.message : t(`preview.previewPanel.forwardFailed`, { port });
    } finally {
        forwarding.value = undefined;
    }
};

// The iframe, probe-gated
// Nothing is framed until the address probes itself as reachable (an iframe never retries a DNS/502 error page); a
// generation counter drops a superseded probe.
const previewSrc = ref<string | undefined>(undefined);
const probeSlow = ref(false);
const probing = ref(false);
const reach = ref<PreviewProbe | undefined>(undefined);
let probeGeneration = 0;

const { daemonBase, usingLocal } = useEndpoint();

const probeThenShow = async (url: string): Promise<void> => {
    const generation = ++probeGeneration;
    const current = (): boolean => generation === probeGeneration;
    probeSlow.value = false;
    probing.value = true;
    reach.value = undefined;
    // On the sandbox's own machine the loopback twin is asked first: it answers at once or not at all, and framing it
    // spares every request the tunnel's round trip. Anything but a serving answer falls through to the public address.
    const local = loopbackPreviewUrl(url, daemonBase.value, usingLocal.value);
    if (local !== undefined) {
        const nearby = await probePreviewOnce(local);
        if (!current()) {
            return;
        }
        if (nearby.outcome === `reached` && nearby.state === `serving`) {
            probing.value = false;
            reach.value = nearby;
            previewSrc.value = local;
            return;
        }
    }
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
    probeGeneration += 1;
    previewSrc.value = undefined;
    probeSlow.value = false;
    probing.value = false;
    reach.value = undefined;
    if (target?.url === undefined) {
        return;
    }
    void probeThenShow(target.url);
};

// Re-resolves on primitive deps only, so the poll's object churn doesn't re-fire it; re-keys the iframe when the target
// or its address changes, since a restarted server would otherwise keep the stale frame.
const previewEpoch = ref(0);
// Where the reader sent the frame through the address bar: a path on the app's own host, kept until the app restarts.
const visited = ref<string | undefined>(undefined);
watch(
    () => [target?.id, target?.url] as const,
    (now, was) => {
        actionError.value = undefined;
        // `was` is absent on the immediate first run, which is also a fresh mount: a fresh key either way.
        if (was === undefined || now[0] !== was[0] || (now[1] !== undefined && was[1] === undefined)) {
            previewEpoch.value += 1;
            visited.value = undefined;
        }
        resolvePreview();
    },
    { immediate: true },
);
onUnmounted(() => {
    probeGeneration += 1;
});

// The frame's address: where the reader went, carried onto the lane the frame is served on, else the app's own.
const frameSrc = computed<string | undefined>(() => {
    const base = previewSrc.value;
    if (base === undefined || visited.value === undefined) {
        return base;
    }
    const path = new URL(visited.value);
    return new URL(`${path.pathname}${path.search}${path.hash}`, base).toString();
});

// Reloads by re-keying the iframe, the only reliable reload across origins.
const reload = (): void => {
    previewEpoch.value += 1;
};

// The address bar's Enter on this tab: a path on the app's own host goes into the frame; anything else is not this
// tab's to show, and the caller sends it elsewhere. Answers whether it was taken.
const navigate = (url: string): boolean => {
    if (target?.url === undefined) {
        return false;
    }
    let typed: URL;
    try {
        typed = new URL(url);
    } catch {
        // allow(silent-catch): not an address at all is not this tab's; the caller decides what a search means.
        return false;
    }
    if (typed.host !== new URL(target.url).host) {
        return false;
    }
    visited.value = typed.toString();
    previewEpoch.value += 1;
    return true;
};

// What the address bar shows for this tab: the public address (the shareable one), at the path the reader went to.
const address = computed<string | undefined>(() => visited.value ?? target?.url);

defineExpose({ reload, navigate, address, framed: computed(() => frameSrc.value !== undefined) });

// Names what Start will run and where its output lands (`panel-<repo>` / `panel-<repo>--<app>`), since a bare "Start"
// names neither the target nor the command it's about to run.
const startSession = computed<string | undefined>(() => {
    if (target?.repo === undefined || !target.startable) {
        return undefined;
    }
    return target.app === undefined ? `panel-${target.repo}` : `panel-${target.repo}--${target.app}`;
});
const startHint = computed<string | undefined>(() => {
    if (target === undefined || !target.startable || startSession.value === undefined) {
        return undefined;
    }
    const what =
        target.app === undefined
            ? t(`preview.previewPanel.repoDevServer`, { repo: target.repo ?? `` })
            : t(`preview.previewPanel.appDevServer`, { app: target.app });
    // Cost is read off the tree's install state, not assumed.
    const cost = target.installed ? t(`preview.previewPanel.startCostInstalled`) : t(`preview.previewPanel.startCostInstall`);
    return t(`preview.previewPanel.startHint`, { what, session: startSession.value, cost });
});
// The Start button's hover: what it runs, where its output lands, and whether an install comes first.
const startTip = computed((): Tip | undefined => {
    if (target === undefined || !target.startable || startSession.value === undefined) {
        return undefined;
    }
    return {
        title: t(`preview.previewPanel.devServer`),
        rows: [
            { label: t(`preview.previewPanel.repo`), value: target.repo ?? `` },
            { label: t(`preview.previewPanel.app`), value: target.app ?? `` },
            { label: t(`shared.terminal`), value: startSession.value },
            target.installed
                ? { label: t(`preview.previewPanel.deps`), value: t(`preview.previewPanel.installed`) }
                : { label: t(`preview.previewPanel.deps`), value: t(`preview.previewPanel.installFirst`), tone: `warn` },
        ],
        note: target.installed ? t(`preview.previewPanel.upInSeconds`) : t(`preview.previewPanel.takesMinutes`),
    };
});

/* The wait duration stays visible while the preview is starting. */
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
    return minutes < 1
        ? t(`preview.previewPanel.waitedSeconds`, { seconds: Math.floor(waitedMs.value / 1000) })
        : t(`preview.previewPanel.waitedMinutes`, { minutes });
});

/* Launch hints describe the daemon's starting phase, not generic preview health. */
// Built when read, so a language switch reaches a hint already on screen.
const LAUNCH_HINTS: Record<PanelLaunch, { readonly waiting: () => string; readonly overdue: (waited: string) => string }> = {
    launching: {
        waiting: () => t(`preview.previewPanel.launchingWaiting`),
        overdue: (waited) => t(`preview.previewPanel.launchingOverdue`, { waited }),
    },
    installing: {
        waiting: () => t(`preview.previewPanel.installingWaiting`),
        overdue: (waited) => t(`preview.previewPanel.installingOverdue`, { waited }),
    },
    starting: {
        waiting: () => t(`preview.previewPanel.startingWaiting`),
        overdue: (waited) => t(`preview.previewPanel.startingOverdue`, { waited }),
    },
    exited: {
        waiting: () => t(`preview.previewPanel.exited`),
        overdue: () => t(`preview.previewPanel.exited`),
    },
};
const launchHint = computed<string | undefined>(() => {
    if (target === undefined) {
        return undefined;
    }
    if (target.launch !== undefined) {
        const hint = LAUNCH_HINTS[target.launch];
        return waitingLong.value ? hint.overdue(waitedFor.value) : hint.waiting();
    }
    // No launch state: the daemon sees it serving (or does not run it), and it is the ADDRESS that has not
    // answered. Past the minute that is a routing problem to name, not a start to wait out.
    if (waitingLong.value) {
        return t(`preview.previewPanel.addressSilent`, { waited: waitedFor.value });
    }
    return probeSlow.value ? t(`preview.previewPanel.addressSlow`) : undefined;
});

/* THE WAY OUT OF A STUCK START: end the pane and start it again, which is what a person does in the terminal once they have looked. */
const restart = (): Promise<void> =>
    act(async (entry) => {
        await stop(entry);
        await start(entry);
    });

/* THE WAIT'S OWN FALLBACK. */
const STARTING_POLL_MS = 10_000;
// Asks again for as long as the start is waited on; a refused read is "not yet", the next tick asks again.
const startingPoll = usePoll({
    everyMs: STARTING_POLL_MS,
    check: async () => {
        await actions.refresh();
    },
    immediate: false,
});
watch(
    () => target?.running === true && previewSrc.value === undefined && reach.value?.outcome !== `unreachable`,
    (waiting) => {
        startingPoll.stop();
        waitingSince.value = waiting ? Date.now() : undefined;
        if (waiting) {
            startingPoll.start();
        }
    },
    { immediate: true },
);
</script>

<template>
    <!-- This tab's own verbs, in the toolbar while it is in front: whether its server runs, and the terminal it runs in. -->
    <Teleport v-if="active && toolsTo && target" :to="toolsTo">
        <!-- Tooltip names target and command, since "Start" alone says neither in a multi-repo workspace. -->
        <Button
            v-if="target.startable && !target.running"
            :label="compact ? undefined : t(`ui.action.start`)"
            :aria-label="t(`ui.action.start`)"
            size="small"
            :disabled="busy"
            v-tooltip.bottom="startTip"
            @click="act(start)"
        >
            <template #icon><Icon name="play" /></template>
        </Button>
        <Button
            v-else-if="target.startable || target.job !== undefined"
            :label="compact ? undefined : t(`ui.action.stop`)"
            :aria-label="t(`ui.action.stop`)"
            size="small"
            severity="secondary"
            :disabled="busy"
            @click="act(stop)"
        >
            <template #icon><Icon name="stop" /></template>
        </Button>
        <button
            v-if="target.session"
            type="button"
            :class="ui.iconButton(`h-7 w-7 rounded-full`)"
            :aria-label="t(`preview.previewPanel.openDevServersTerminal`)"
            v-tooltip.bottom="t(`shared.terminal`)"
            @click="terminal.openFocused(target.session!)"
        >
            <Icon name="terminal" class="text-xs" />
        </button>
    </Teleport>

    <div class="flex h-full min-h-0 w-full flex-col bg-canvas">
        <!-- Errors stay beside the app whose controls caused them. -->
        <Notice v-if="actionError" :of="noticeOf(actionError)" class="mx-3 mt-3" />

        <div v-if="!target && !settled" class="flex flex-1 items-center justify-center" role="status" aria-busy="true">
            <span class="sr-only">{{ t(`preview.previewPanel.readingWhatPreviewed`) }}</span>
            <Icon name="spinner" spin class="text-2xl text-subtle" aria-hidden="true" />
        </div>

        <!-- The list has answered and this app is not on it: a repo removed, a port taken back. -->
        <EmptyState v-else-if="!target" icon="eye-slash" :title="t(`browsers.preview.gone`)" :line="t(`browsers.preview.goneLine`)" class="flex-1">
            <template #actions>
                <Button :label="t(`browsers.browsers.closeTab`)" size="small" severity="secondary" @click="emit(`close`)" />
            </template>
        </EmptyState>

        <!-- Sandbox preview responses admit this editor as a frame ancestor; mounting still waits for the hostname probe. -->
        <PreviewStage v-else-if="frameSrc" :phone="phone">
            <template #default="{ frame }">
                <iframe
                    :key="`${previewEpoch}-${previewSrc}`"
                    :src="frameSrc"
                    :title="t(`preview.previewPanel.preview2`, { label: target.label })"
                    :sandbox="frameSandbox(target.kind)"
                    :style="frame"
                    class="block border-0 bg-white"
                ></iframe>
            </template>
        </PreviewStage>

        <!-- A missing route means this sandbox has no preview proxy. -->
        <EmptyState
            v-else-if="reach?.outcome === `unreachable`"
            icon="exclamation-triangle"
            :title="t(`preview.previewPanel.previewAddressDoesntReach`)"
            class="flex-1"
        >
            <template #line>
                <i18n-t keypath="preview.previewPanel.addressAnswersElsewhere" scope="global">
                    <template #url
                        ><span class="font-mono">{{ target.url }}</span></template
                    >
                </i18n-t>
            </template>
            <template #actions>
                <Button :label="t(`ui.action.tryAgain`)" size="small" severity="secondary" @click="resolvePreview()" />
                <Button :as="RouterLink" to="/sandbox/ports" :label="t(`preview.previewPanel.openPorts`)" size="small" severity="secondary" />
            </template>
        </EmptyState>

        <!-- Ordinary monorepo shape: `dev` fans out across packages on their own ports, so no single preview address applies. -->
        <EmptyState
            v-else-if="!target.url && target.servers.length > 0"
            icon="globe"
            :line="t(`preview.previewPanel.previewingOneForwardsPort`)"
            class="flex-1"
        >
            <!-- One message, not seven fragments: the count decides the form, and only a whole sentence lets a
                 translator put the number, the noun and the possessive where their own grammar needs them. -->
            <template #title>
                <i18n-t keypath="preview.previewPanel.serversOnOwnPorts" scope="global" :plural="target.servers.length">
                    <template #label
                        ><span class="font-mono">{{ target.label }}</span></template
                    >
                    <template #count>{{ target.servers.length }}</template>
                </i18n-t>
            </template>
            <ul class="flex w-full max-w-md flex-col gap-1">
                <li
                    v-for="server in target.servers"
                    :key="server.port"
                    class="flex items-center justify-between gap-3 rounded-md border border-line px-2.5 py-1.5 text-left"
                >
                    <span class="min-w-0 truncate font-mono text-2xs text-subtle"> {{ server.dir ? `${server.dir} · ` : `` }}{{ server.url }} </span>
                    <Button
                        :label="forwarding === server.port ? t(`preview.previewPanel.opening`) : t(`shared.preview`)"
                        size="small"
                        severity="secondary"
                        :disabled="forwarding !== undefined"
                        @click="previewServer(server.port)"
                    />
                </li>
            </ul>
        </EmptyState>

        <!-- A server an agent left running for the person, not forwarded yet: forwarding publishes it, so it waits for their press. -->
        <EmptyState
            v-else-if="target.job !== undefined && !target.url"
            icon="server"
            :title="t(`preview.previewPanel.leftRunningForYou`, { label: target.detail ?? target.label })"
            :line="t(`preview.previewPanel.previewingItForwardsPort`)"
            class="flex-1"
        >
            <template #actions>
                <Button
                    :label="forwarding !== undefined ? t(`preview.previewPanel.opening`) : t(`shared.preview`)"
                    size="small"
                    :disabled="forwarding !== undefined"
                    @click="previewServer(target.job.port)"
                />
                <Button :label="t(`ui.action.stop`)" size="small" severity="secondary" :disabled="busy" @click="act(stop)" />
            </template>
        </EmptyState>

        <!-- STARTED, NOT YET SERVING: installing, compiling, or failing in its terminal, which is the one place that says which. -->
        <!-- The heading identifies the preview's verdict, timeout, or active wait state. -->
        <EmptyState
            v-else-if="probing || target.running"
            :icon="target.launch === `exited` || waitingLong ? `exclamation-triangle` : `spinner`"
            :spin="!(target.launch === `exited` || waitingLong)"
            :title="
                target.launch === `exited`
                    ? t(`preview.previewPanel.devServerStopped`)
                    : waitingLong
                      ? t(`preview.previewPanel.takingTooLong`)
                      : t(`preview.previewPanel.preparingPreview`)
            "
            :line="launchHint ?? ``"
            class="flex-1"
        >
            <template v-if="target.session || (target.startable && (waitingLong || target.launch === `exited`))" #actions>
                <Button
                    v-if="target.session"
                    :label="t(`preview.previewPanel.openTerminal`)"
                    size="small"
                    severity="secondary"
                    @click="terminal.openFocused(target.session!)"
                />
                <!-- Restart appears only after the wait becomes a verdict. -->
                <Button
                    v-if="target.startable && (waitingLong || target.launch === `exited`)"
                    :label="t(`ui.action.restart`)"
                    size="small"
                    :disabled="busy"
                    @click="restart"
                >
                    <template #icon><Icon name="refresh" /></template>
                </Button>
            </template>
        </EmptyState>

        <!-- The stopped state explains the next action and its destination. -->
        <EmptyState v-else class="flex-1">
            <template #title>
                <i18n-t keypath="preview.previewPanel.labelIsntRunning" scope="global">
                    <template #label
                        ><span class="font-mono">{{ target.label }}</span></template
                    >
                </i18n-t>
            </template>
            <template #line>
                <template v-if="startHint">{{ startHint }}</template>
                <i18n-t v-else keypath="preview.previewPanel.noDevServerToStart" scope="global">
                    <template #operator><span class="font-mono">operator/</span></template>
                    <template #dev><span class="font-mono">dev</span></template>
                </i18n-t>
            </template>
            <template v-if="target.startable" #actions>
                <Button :label="t(`ui.action.start`)" size="small" :disabled="busy" @click="act(start)">
                    <template #icon><Icon name="play" /></template>
                </Button>
            </template>
        </EmptyState>
    </div>
</template>
