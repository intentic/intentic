<script setup lang="ts">
import { Card, cmp } from "@intentic-app/ui";
import { confirm } from "@tauri-apps/plugin-dialog";
import Button from "primevue/button";
import { computed, onMounted, onUnmounted, ref } from "vue";
import RunLog from "./components/RunLog.vue";
import SandboxCard from "./components/SandboxCard.vue";
import {
    desktopInfo,
    onPendingRecreate,
    onPendingSetup,
    onRun,
    onUpdateAvailable,
    pendingSetup,
    sandboxList,
    sandboxPower,
    sandboxRecreate,
    sandboxRemove,
    setupRun,
    takePendingRecreate,
    workspaceOpen,
    type DesktopInfo,
    type RunEvent,
    type SandboxStatus,
    type SetupArgs,
} from "./desktop";

/* THE LAUNCHER — the app's only native screen, and deliberately not a wizard.
 *
 * The workspace window shows the real product (the hosted SPA), so everything about naming a sandbox, picking
 * reachability and minting a setup code stays there, where it already works and where a change ships without
 * an app release. What is left for this window is the two things a web page on another origin cannot do:
 *
 *   • run the setup the SPA just handed over (an `intentic://setup` link), showing what the script says
 *   • manage the containers on THIS machine afterwards — start/stop, update, remove, read the logs
 *
 * The archived version had three personas here (a wizard, an environment checklist, a manager) in 527 lines.
 * The checklist is gone because the scripts do the reconciling and narrate it as they go; the wizard is gone
 * because it was a second copy of the SPA's setup screen. */

const info = ref<DesktopInfo | undefined>(undefined);
const sandboxes = ref<SandboxStatus[]>([]);
const listError = ref<string | undefined>(undefined);
const busy = ref<{ slug: string; action: string } | undefined>(undefined);
const updateVersion = ref<string | undefined>(undefined);

// The setup the SPA handed over, and the run it turns into.
const pending = ref<SetupArgs | undefined>(undefined);
const setupError = ref<string | undefined>(undefined);
const runs = ref<Record<string, RunEvent[]>>({});
const activeRun = ref<string | undefined>(undefined);

const eventsOf = (run: string): RunEvent[] => runs.value[run] ?? [];
const running = computed(() => activeRun.value !== undefined);

const refresh = async (): Promise<void> => {
    try {
        sandboxes.value = await sandboxList();
        listError.value = undefined;
    } catch (error) {
        // Docker not being up is the ordinary case on a machine nobody has set up yet, so it reads as an
        // empty manager with an explanation rather than an error state.
        sandboxes.value = [];
        listError.value = String(error);
    }
};

const loadPending = async (): Promise<void> => {
    pending.value = (await pendingSetup()) ?? undefined;
};

/* Every operation is one script run and they all report the same way, so there is one place that starts a
 * run, one that renders it, and no per-action progress state. `activeRun` is what serializes them: the
 * scripts all drive docker on this one machine, and two recreates at once is not a thing to support. */
const start = async (id: string, action: () => Promise<void>): Promise<string | undefined> => {
    runs.value = { ...runs.value, [id]: [] };
    activeRun.value = id;
    try {
        await action();
        return undefined;
    } catch (error) {
        return String(error);
    } finally {
        activeRun.value = undefined;
        await refresh();
    }
};

const runSetup = async (): Promise<void> => {
    const args = pending.value;
    if (args === undefined || running.value) {
        return;
    }
    setupError.value = await start(`setup`, () => setupRun(args));
    if (setupError.value === undefined) {
        pending.value = undefined;
        // The daemon announced itself to the platform on boot, which is exactly what the SPA's setup screen
        // has been polling for — so the workspace window is one poll away from opening the workspace.
        await workspaceOpen();
    }
};

const power = async (slug: string, startIt: boolean): Promise<void> => {
    busy.value = { slug, action: `power` };
    await start(`power:${slug}`, () => sandboxPower(slug, startIt));
    busy.value = undefined;
};

const update = async (slug: string, hash?: string): Promise<void> => {
    busy.value = { slug, action: `update` };
    await start(`recreate:${slug}`, () => sandboxRecreate(slug, hash));
    busy.value = undefined;
};

/* The SPA's two "paste this on the machine that runs your sandbox" cards, arriving as a click instead: the
 * Update card sends a slug, the Environment card sends a slug and the approved overlay's digest. Taken rather
 * than read, so reopening this window later does not re-run an update that already ran. */
const drainRecreate = async (): Promise<void> => {
    const requested = await takePendingRecreate();
    if (requested === null || running.value) {
        return;
    }
    await update(requested.slug, requested.hash);
};

// Removing a sandbox deletes its /work and /history volumes, which is not recoverable and not what the
// neighbouring buttons do — so it asks, in the OS's own dialog rather than one this window draws.
const remove = async (slug: string): Promise<void> => {
    const sandbox = sandboxes.value.find((entry) => entry.slug === slug);
    const confirmed = await confirm(
        `This deletes ${sandbox?.name ?? slug} and everything in it — its files and its history. This cannot be undone.`,
        {
            title: `Remove this sandbox?`,
            kind: `warning`,
            okLabel: `Remove`,
        },
    );
    if (!confirmed) {
        return;
    }
    busy.value = { slug, action: `remove` };
    await start(`remove:${slug}`, () => sandboxRemove(slug));
    busy.value = undefined;
};

const busyFor = (slug: string): string | null => (busy.value?.slug === slug ? busy.value.action : null);

let stop: Array<() => void> = [];
onMounted(async () => {
    info.value = await desktopInfo();
    await Promise.all([refresh(), loadPending()]);
    stop = await Promise.all([
        onRun((event) => {
            runs.value = { ...runs.value, [event.run]: [...eventsOf(event.run), event] };
        }),
        onPendingSetup(() => void loadPending()),
        onPendingRecreate(() => void drainRecreate()),
        onUpdateAvailable((version) => (updateVersion.value = version)),
    ]);
    // After the listeners, so a link that arrives while this window is opening is picked up exactly once —
    // either by the event or by this call, whichever finds the request still parked.
    await drainRecreate();
});
onUnmounted(() => stop.forEach((unlisten) => unlisten()));
</script>

<template>
    <div class="flex h-dvh flex-col gap-4 overflow-auto bg-surface p-5 text-content">
        <header class="flex items-center gap-3">
            <h1 class="flex-1 text-base font-semibold">Sandbox Manager</h1>
            <span v-if="info" class="font-mono text-2xs text-subtle">v{{ info.version }}</span>
        </header>

        <!-- The app updates itself; this is the notice, not a gate. -->
        <div v-if="updateVersion" :class="cmp.alertInfo('flex items-center gap-2 text-xs')">
            <Icon name="arrow-circle-up" />
            <span class="flex-1">Intentic {{ updateVersion }} is available — it installs the next time you quit.</span>
        </div>

        <!-- The handoff from the SPA. Everything shown here was decided over there; this card asks for the one
             thing the browser could not ask for, which is permission to start touching this machine. -->
        <Card v-if="pending" class="flex flex-col gap-3">
            <div class="flex items-start gap-2.5">
                <Icon name="bolt" class="mt-0.5 text-primary-400" />
                <div class="min-w-0 flex-1">
                    <h2 class="font-semibold leading-tight">Set up {{ pending.name ?? `your sandbox` }} on this computer</h2>
                    <p class="text-2xs text-subtle">
                        Runs exactly what the install command runs: starts your sandbox in Docker, connects its tunnel, and opens your workspace once
                        it answers.
                    </p>
                </div>
            </div>
            <p v-if="info && !info.dockerReady" class="flex items-start gap-2 text-2xs text-warning">
                <Icon name="box" class="mt-0.5 shrink-0" />
                <span v-if="info.os === `windows`">Docker isn't running yet — setup installs Docker Desktop first, which is a large download.</span>
                <span v-else>Docker isn't running yet — setup installs it first, so your system will ask for your password once.</span>
            </p>
            <RunLog v-if="eventsOf(`setup`).length > 0" :events="eventsOf(`setup`)" :running="activeRun === `setup`" />
            <div v-if="setupError" :class="cmp.alertDanger('text-2xs')">{{ setupError }}</div>
            <Button
                class="self-start"
                :label="setupError ? `Try again` : `Set up on this computer`"
                :loading="activeRun === `setup`"
                :disabled="running"
                @click="runSetup"
            >
                <template #icon><Icon name="bolt" /></template>
            </Button>
        </Card>

        <section class="flex min-h-0 flex-col gap-3">
            <div class="flex items-center gap-2">
                <h2 class="flex-1 text-sm font-semibold">On this computer</h2>
                <Button size="small" severity="secondary" :text="true" label="Refresh" :disabled="running" @click="refresh">
                    <template #icon><Icon name="refresh" /></template>
                </Button>
            </div>

            <p v-if="listError" class="flex items-start gap-2 text-2xs text-muted">
                <Icon name="box" class="mt-0.5 shrink-0" />
                <span>Docker isn't reachable, so there is nothing to show yet. Start Docker, or set up a sandbox from the workspace window.</span>
            </p>
            <p v-else-if="sandboxes.length === 0" class="text-2xs text-muted">
                No sandboxes here yet. Open the workspace window and set one up — this window is where you manage it afterwards.
            </p>

            <SandboxCard
                v-for="sandbox in sandboxes"
                :key="sandbox.slug"
                :sandbox="sandbox"
                :busy="busyFor(sandbox.slug)"
                @power="power"
                @update="update"
                @remove="remove"
            />

            <!-- One run at a time, so one log: whichever operation is in flight owns this. -->
            <RunLog
                v-if="activeRun !== undefined && activeRun !== `setup`"
                :events="eventsOf(activeRun)"
                :running="true"
                class="rounded-xl border border-line bg-canvas p-4"
            />
        </section>

        <footer class="mt-auto flex items-center gap-2 pt-2">
            <Button size="small" severity="secondary" label="Open workspace" @click="workspaceOpen">
                <template #icon><Icon name="arrow-up-right" /></template>
            </Button>
            <span v-if="info" class="truncate font-mono text-2xs text-subtle">{{ info.appUrl }}</span>
        </footer>
    </div>
</template>
