<script setup lang="ts">
import {
    Card,
    MachineDetail,
    MachineRunLog,
    type MachineSandboxGroup,
    type MachineSandboxRow,
    Notice,
    type SandboxVerb,
    SandboxVerbs,
    sandboxVerbPrompt,
    VERB_LABEL,
} from "@intentic/ui";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { confirm } from "@tauri-apps/plugin-dialog";
import Button from "primevue/button";
import { computed, onMounted, onUnmounted, ref, watchEffect } from "vue";
import { initAnalytics, track } from "./analytics";
import RunLog from "./components/RunLog.vue";
import {
    desktopInfo,
    isStep,
    machineReport,
    onPendingRecreate,
    onPendingSetup,
    onRun,
    onUpdateAvailable,
    pendingSetup,
    sandboxList,
    sandboxLogs,
    sandboxPower,
    sandboxRecreate,
    sandboxRemove,
    setupRun,
    stepLabel,
    takePendingRecreate,
    workspaceOpen,
    type DesktopInfo,
    type MachineReport,
    type RunEvent,
    type SandboxStatus,
    type SetupArgs,
} from "./desktop";

/* THE APP'S OWN FACE — the other half of the one window, and deliberately not a wizard.
 *
 * The workspace face shows the real product (the hosted SPA), so everything about naming a sandbox, picking
 * reachability and minting a setup code stays there, where it already works and where a change ships without
 * an app release. What is left for this one is the two things a web page on another origin cannot do:
 *
 *   • run the setup the SPA just handed over (an `intentic://setup` link), showing what the script says
 *   • manage the containers on THIS machine afterwards — the sandbox rows and their verbs
 *
 * They are two SCREENS rather than two sections, and a setup is the whole window while it is happening
 * (`setupMode`). It arrives in the frame the SPA was filling a moment ago (windows.rs), and the manager's
 * furniture beside it — a container list, a version, an "Open workspace" button — would be a set of decisions
 * to make about a machine whose sandbox is still being built.
 *
 * The archived version had three personas here (a wizard, an environment checklist, a manager) in 527 lines.
 * The checklist is gone because the scripts do the reconciling and narrate it as they go; the wizard is gone
 * because it was a second copy of the SPA's setup screen.
 *
 * ONE LIST, AND IT IS THE WEB'S. This screen and the SPA's Computers tab manage the same containers on the same
 * machine, and they had drifted into two answers: this one printed its sandboxes as cards with their own buttons
 * and then printed the SAME sandboxes again underneath as folders and ports, under a second heading, with
 * nothing on screen relating the two — the exact double-rendering the Computers tab was rebuilt to remove. It
 * now hands its containers to <MachineDetail>, the way that tab does, so a sandbox is one row carrying its
 * folder, its ports, its image and its verbs. The verbs are the kit's too (<SandboxVerbs>), so "which buttons
 * exist here" is no longer a thing two apps can disagree about — this window had a log tail and no Restart, the
 * tab had a Restart and no log tail, and neither offered the rollback both of their backends could already do. */

const info = ref<DesktopInfo | undefined>(undefined);
const sandboxes = ref<SandboxStatus[]>([]);
const listError = ref<string | undefined>(undefined);
// What desktop sync is doing here. Undefined = no agent on this computer, which is a fact about the machine and
// not a failure; a string = the agent is installed but would not answer, which is.
const report = ref<MachineReport | undefined>(undefined);
const reportError = ref<string | undefined>(undefined);
const busy = ref<{ slug: string; verb: SandboxVerb } | undefined>(undefined);
const updateVersion = ref<string | undefined>(undefined);

/* WHAT ONE ROW IS SHOWING BELOW ITSELF. The log tail is the only thing here that outlives its own run — every
 * other verb's lines are progress, and a container's last two hundred lines are read after they arrive — so the
 * open pane is remembered by slug rather than following whatever is busy. One at a time, because `activeRun`
 * already allows exactly one operation on this machine at a time. */
const openLog = ref<string | undefined>(undefined);
const logLines = ref<Record<string, string[]>>({});
// The machine's own words when a row's verb failed, kept beside that row rather than at the foot of the screen.
const rowFailure = ref<{ slug: string; message: string } | undefined>(undefined);

// How much of a container's tail to ask docker for — the same figure the machine agent uses for the same button.
const LOG_TAIL_LINES = 200;

// The setup the SPA handed over, and the run it turns into.
const pending = ref<SetupArgs | undefined>(undefined);
const setupError = ref<string | undefined>(undefined);
const runs = ref<Record<string, RunEvent[]>>({});
const activeRun = ref<string | undefined>(undefined);

const eventsOf = (run: string): RunEvent[] => runs.value[run] ?? [];
const running = computed(() => activeRun.value !== undefined);
// A handed-over setup owns the window from the moment it arrives until it hands the window back — which
// includes having failed, because a failure is the one state the user most needs undivided.
const setupMode = computed(() => pending.value !== undefined || activeRun.value === `setup`);

/* The OS title follows the screen. Both faces of the app live in ONE frame (windows.rs swaps them into each
 * other's place), so the title is not decoration: it is the taskbar entry, the alt-tab label, and the only
 * thing outside this process that can say which screen is up — which is what the desktop smoke tier asserts
 * against, having deliberately no test hook to read instead. */
watchEffect(() => {
    void getCurrentWindow().setTitle(setupMode.value ? `Intentic — Setting up your sandbox` : `Intentic — This computer`);
});

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
    /* The sync half, read separately and allowed to fail separately: the two answers come from different places
     * (docker, and the sync agent) and either can be absent on a perfectly working computer. Folding them into
     * one try would let a machine with no sync agent read as a machine with no sandboxes. */
    try {
        report.value = await machineReport();
        reportError.value = undefined;
    } catch (error) {
        report.value = undefined;
        reportError.value = String(error);
    }
};

/* THE CONTAINERS, IN THE SHAPE THE SHARED VIEW READS. Docker's own answer carries `null` for the two facts it
 * may not have; the row type spells the same absence as an absent KEY, because absent and false are different
 * things there (no tunnel sidecar at all, versus a sidecar that is down). The join between a container and the
 * sync agent's pairing is <MachineDetail>'s own — this app used to make it here, by hand, into one line of text. */
const sandboxRows = computed<MachineSandboxRow[]>(() =>
    sandboxes.value.map((sandbox) => ({
        slug: sandbox.slug,
        running: sandbox.running,
        image: sandbox.image,
        ...(sandbox.name === null ? {} : { name: sandbox.name }),
        ...(sandbox.tunnelRunning === null ? {} : { tunnelRunning: sandbox.tunnelRunning }),
    })),
);

// The docker row behind one of the view's groups, which is what every verb below needs and the group carries.
const slugOf = (group: MachineSandboxGroup): string | undefined => group.sandbox?.slug;

/* Whether the shared view would draw anything at all. It groups containers, folders and ports, and a machine can
 * have the last two and none of the first (a pairing whose container is stopped and pruned) — so "is there a row"
 * is all three, not just docker's answer. Below this, the screen says so in its own words rather than letting the
 * shared view fall through to a sentence written for the SPA's reader. */
const hasRows = computed(() => sandboxes.value.length > 0 || (report.value?.pairings.length ?? 0) > 0 || (report.value?.ports.length ?? 0) > 0);

/* HOW A FINISHED RUN IS REPORTED — the outcome, and where it stopped, and nothing else.
 *
 * The scripts narrate themselves in `intentic: …` lines (desktop.ts), so the last one before a failure is the
 * most specific thing anybody can say about where an install died — and it is a string this repo writes rather
 * than machine output, which is what makes it safe to send. The log beside it is full of paths, names and
 * tokens and none of that leaves here. */
const isStepLine = (event: RunEvent): boolean => event.kind === `line` && event.stream === `stdout` && isStep(event.text);

const runOutcome = (id: string, ok: boolean, startedAt: number): Record<string, unknown> => {
    const events = eventsOf(id);
    const exit = events.findLast((event) => event.kind === `exit`);
    const last = events.findLast(isStepLine);
    return {
        ok,
        durationMs: Date.now() - startedAt,
        exitCode: exit?.kind === `exit` ? exit.code : null,
        steps: events.filter(isStepLine).length,
        // Only on the way out: on a run that worked, the last step is just the last step.
        ...(ok || last?.kind !== `line` ? {} : { failedStep: stepLabel(last.text) }),
    };
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
    const startedAt = Date.now();
    track(`desktop_install_started`, { dockerReady: info.value?.dockerReady ?? null, sync: (args.syncDir ?? ``) !== `` });
    setupError.value = await start(`setup`, () => setupRun(args));
    const ok = setupError.value === undefined;
    /* THE DESKTOP FUNNEL'S LAST STEP, REPORTED FROM WHERE IT ACTUALLY HAPPENS. The SPA has its own
     * `sandbox_connected`, but on this path it is fired by a page that has been behind this window for the
     * whole install — late at best, and never at all when the handover came from a browser tab the user then
     * closed. Exit zero here means the daemon booted and announced itself, which is the same fact that page
     * was waiting to observe. */
    track(`desktop_install_finished`, runOutcome(`setup`, ok, startedAt));
    if (ok) {
        pending.value = undefined;
        // The daemon announced itself to the platform on boot, which is exactly what the SPA's setup screen
        // has been polling for — so handing the window back is one poll away from showing the workspace.
        await workspaceOpen();
    }
};

/* A parked setup RUNS on arrival rather than waiting to be asked. The SPA's "Set up on this computer" button
 * is the consent — it says what this does, in the sentence directly above it — and repeating the question on
 * a screen the user did not open is what made the handoff read as a second, unrelated installer. The guard in
 * `runSetup` is what keeps the two ways in here (the event, and the read below on mount) to one run.
 *
 * That consent only covers a link the SPA's own window navigated to. One arriving from the OS — which any page
 * can send, on nothing more than a browser's "Open Intentic?" — is asked about in windows.rs BEFORE it is
 * parked, so anything that reaches this screen has been agreed to one way or the other. */
const loadPending = async (): Promise<void> => {
    pending.value = (await pendingSetup()) ?? undefined;
    await runSetup();
};

/* WHICH RUN A VERB IS. The ids predate the shared row and are kept as they are, because the analytics below
 * report against them and one of them is also what an `intentic://recreate` handover produces. */
const RUN_OF: Record<Exclude<SandboxVerb, `logs`>, (slug: string) => string> = {
    start: (slug) => `power:${slug}`,
    stop: (slug) => `power:${slug}`,
    restart: (slug) => `power:${slug}`,
    update: (slug) => `recreate:${slug}`,
    rollback: (slug) => `recreate:${slug}`,
    remove: (slug) => `remove:${slug}`,
};

/* `source` is the one thing the event cannot work out for itself: the same operation arrives either as a click
 * on this screen's own list, or as the SPA's Update/Environment card handing it over (`drainRecreate`). Which
 * of the two people actually use is the question the app's existence rests on. */
const recreate = async (slug: string, hash: string | undefined, rollback: boolean, source: `manager` | `link`): Promise<void> => {
    busy.value = { slug, verb: rollback ? `rollback` : `update` };
    const startedAt = Date.now();
    // The mode rides the argument shape here exactly as it does in the script (recreate.sh): a hash means the
    // owner-approved overlay, `--rollback` means the image before the last update, neither means the fresh base.
    const mode = rollback ? `rollback` : hash === undefined ? `update` : `rebuild`;
    track(`desktop_recreate_started`, { mode, source });
    const failure = await start(`recreate:${slug}`, () => sandboxRecreate(slug, hash, rollback));
    track(`desktop_recreate_finished`, { mode, source, ...runOutcome(`recreate:${slug}`, failure === undefined, startedAt) });
    rowFailure.value = failure === undefined ? undefined : { slug, message: failure };
    busy.value = undefined;
};

/* The SPA's "paste this on the machine that runs your sandbox" cards, arriving as a click instead: the Update
 * card sends a slug, the Environment card sends a slug and the approved overlay's digest, and the rollback on
 * the same card sends the flag. Taken rather than read, so coming back to this screen later does not re-run an
 * update that already ran. */
const drainRecreate = async (): Promise<void> => {
    const requested = await takePendingRecreate();
    if (requested === null || running.value) {
        return;
    }
    await recreate(requested.slug, requested.hash, requested.rollback, `link`);
};

/* ONE CLICK ON ONE ROW, whichever of the shared verbs it was.
 *
 * The kit decides which buttons exist and what the destructive ones ask; this decides what each one DOES here,
 * which is the whole of what differs between this window and the SPA's Computers tab — there, a verb is a
 * message to a machine over a socket; here it is a script or a docker call on the machine this window is on.
 *
 * The question is asked in the OS's own dialog rather than one this window draws, and its words are the kit's,
 * so the two apps warn about the same thing in the same sentence. */
const act = async (group: MachineSandboxGroup, verb: SandboxVerb): Promise<void> => {
    const slug = slugOf(group);
    if (slug === undefined || busy.value !== undefined || running.value) {
        return;
    }
    if (verb === `logs`) {
        // A toggle: a pane the reader opened is theirs to close, and re-reading is the same click again.
        if (openLog.value === slug) {
            openLog.value = undefined;
            return;
        }
        // Opened before the lines arrive, so an empty pane says "reading" rather than the row looking like it
        // ignored the click. This one does NOT go through `start`: nothing is spawned, so there is no run.
        openLog.value = slug;
        logLines.value = { ...logLines.value, [slug]: [] };
        busy.value = { slug, verb };
        const text = await sandboxLogs(slug, LOG_TAIL_LINES).catch((error: unknown) => String(error));
        logLines.value = { ...logLines.value, [slug]: text.split(/\r?\n/).filter((line) => line !== ``) };
        busy.value = undefined;
        return;
    }
    const asked = sandboxVerbPrompt(verb, group.title);
    if (asked !== undefined && !(await confirm(asked, { title: group.title, kind: `warning`, okLabel: VERB_LABEL[verb] }))) {
        return;
    }
    // A pane holding the log this row printed a moment ago is about a container that is now being changed.
    openLog.value = undefined;
    rowFailure.value = undefined;
    if (verb === `update` || verb === `rollback`) {
        await recreate(slug, undefined, verb === `rollback`, `manager`);
        return;
    }
    busy.value = { slug, verb };
    const failure = await start(RUN_OF[verb](slug), verb === `remove` ? () => sandboxRemove(slug) : () => sandboxPower(slug, verb));
    rowFailure.value = failure === undefined ? undefined : { slug, message: failure };
    busy.value = undefined;
};

// Which of THIS row's buttons is the one spinning, and what its pane is showing. A run's lines are the script's
// own output; a log tail's are the container's — one pane, because a row only ever has one thing to say.
const busyVerb = (group: MachineSandboxGroup): SandboxVerb | undefined => {
    const inFlight = busy.value;
    return inFlight !== undefined && inFlight.slug === slugOf(group) ? inFlight.verb : undefined;
};
const logOpen = (group: MachineSandboxGroup): boolean => openLog.value !== undefined && openLog.value === slugOf(group);
const paneLines = (group: MachineSandboxGroup): string[] => {
    const slug = slugOf(group);
    const verb = busyVerb(group);
    if (slug === undefined) {
        return [];
    }
    if (verb !== undefined && verb !== `logs`) {
        return eventsOf(RUN_OF[verb](slug)).flatMap((event) => (event.kind === `line` ? [event.text] : []));
    }
    return logLines.value[slug] ?? [];
};

let stop: Array<() => void> = [];
onMounted(async () => {
    info.value = await desktopInfo();
    // Before the parked work below, because the first thing this screen does is often the setup it was opened
    // to run — and an install that reports nothing is exactly what this is here to stop happening.
    initAnalytics(info.value);
    track(`desktop_app_opened`, { dockerReady: info.value.dockerReady });
    /* Listeners BEFORE the parked work, not after: `loadPending` starts the handed-over setup the moment it
     * finds one, and a script reaches this screen only as events — so a run begun before `onRun` is listening
     * would show an empty log through its first, most informative seconds. */
    stop = await Promise.all([
        onRun((event) => {
            runs.value = { ...runs.value, [event.run]: [...eventsOf(event.run), event] };
        }),
        onPendingSetup(() => void loadPending()),
        onPendingRecreate(() => void drainRecreate()),
        onUpdateAvailable((version) => (updateVersion.value = version)),
    ]);
    // A link that arrived while this screen was opening was PARKED rather than delivered, so it is picked up
    // exactly once — by the event above or by these, whichever finds the request still there.
    await Promise.all([refresh(), loadPending(), drainRecreate()]);
});
onUnmounted(() => stop.forEach((unlisten) => unlisten()));
</script>

<template>
    <div class="h-dvh overflow-auto bg-surface text-content">
        <!-- A column, not a stretched form: this face inherits the workspace's frame (windows.rs), which is a
             wide window, and everything on either screen is a short list of short things. Setup is ONE card in
             that frame, so it sits in the middle of it — pinned to the top it reads as a page that failed to
             load the rest of itself. -->
        <div :class="['mx-auto flex min-h-full w-full max-w-3xl flex-col gap-4 p-5', setupMode && 'justify-center']">
            <!-- SETUP — the whole window while it runs. Everything shown here was decided in the SPA; this
                 screen is where the part that touches the machine happens, and says so as it goes. -->
            <template v-if="setupMode">
                <Card class="flex flex-col gap-3">
                    <div class="flex items-start gap-2.5">
                        <Icon name="bolt" class="mt-0.5 text-primary-400" />
                        <div class="min-w-0 flex-1">
                            <h1 class="font-semibold leading-tight">Setting up {{ pending?.name ?? `your sandbox` }} on this computer</h1>
                            <p class="text-2xs text-subtle">
                                Running exactly what the install command runs: starts your sandbox in Docker, connects its tunnel, and opens your
                                workspace once it answers.
                            </p>
                        </div>
                    </div>
                    <p v-if="info && !info.dockerReady" class="flex items-start gap-2 text-2xs text-warning">
                        <Icon name="box" class="mt-0.5 shrink-0" />
                        <span v-if="info.os === `windows`"
                            >Docker isn't running yet — setup installs Docker Desktop first, which is a large download.</span
                        >
                        <span v-else>Docker isn't running yet — setup installs it first, so your system will ask for your password once.</span>
                    </p>
                    <RunLog
                        v-if="activeRun === `setup` || eventsOf(`setup`).length > 0"
                        :events="eventsOf(`setup`)"
                        :running="activeRun === `setup`"
                    />
                    <Notice v-if="setupError" tone="danger" class="text-2xs">{{ setupError }}</Notice>
                    <!-- Only on failure, and paired with a way out. A setup that stopped is the one place this
                         app can strand someone, and "try again" as the only control is a dead end wearing a
                         button. -->
                    <div v-if="setupError" class="flex flex-wrap items-center gap-2">
                        <Button label="Try again" :disabled="running" @click="runSetup">
                            <template #icon><Icon name="bolt" /></template>
                        </Button>
                        <Button severity="secondary" :text="true" label="Back to your workspace" @click="workspaceOpen">
                            <template #icon><Icon name="arrow-up-right" /></template>
                        </Button>
                    </div>
                </Card>
            </template>

            <!-- THE MANAGER — what this machine is running, once nothing is being handed over. -->
            <template v-else>
                <header class="flex items-center gap-3">
                    <h1 class="flex-1 text-base font-semibold">This computer</h1>
                    <span v-if="info" class="font-mono text-2xs text-subtle">v{{ info.version }}</span>
                    <Button size="small" severity="secondary" :text="true" label="Refresh" :disabled="running" @click="refresh">
                        <template #icon><Icon name="refresh" /></template>
                    </Button>
                </header>

                <!-- The app updates itself; this is the notice, not a gate. -->
                <Notice v-if="updateVersion" tone="info" class="items-center">
                    Intentic {{ updateVersion }} is available — it installs the next time you quit.
                </Notice>

                <p v-if="listError" class="flex items-start gap-2 text-2xs text-muted">
                    <Icon name="box" class="mt-0.5 shrink-0" />
                    <span>Docker isn't reachable, so there is nothing to show yet. Start Docker, or set a sandbox up from your workspace.</span>
                </p>
                <p v-else-if="!hasRows" class="text-2xs text-muted">
                    No sandboxes here yet. Set one up from your workspace — this screen is where you manage it afterwards.
                </p>

                <!-- WHAT THIS COMPUTER IS RUNNING — one row per sandbox, carrying its folder, its ports, its
                     image and its verbs, exactly as the SPA's Computers tab draws the same machine.
                     `syncDir` rides the setup link into connect.sh and was never heard from again, so the app
                     whose whole premise is not needing a terminal could say a container was up and nothing about
                     the sync the same setup had just configured — the folders and ports below are that half, and
                     they belong ON the sandbox they are for rather than under a heading of their own. -->
                <section v-if="hasRows || reportError" class="flex flex-col gap-3 rounded-xl border border-line bg-canvas p-4">
                    <Notice v-if="reportError" tone="danger" class="text-2xs">{{ reportError }}</Notice>
                    <MachineDetail :pairings="report?.pairings" :ports="report?.ports" :sandboxes="sandboxRows" :watcher="report?.watcher">
                        <!-- What the list is, and the state of the agent behind it, on one line — the watcher is
                             a fact about the MACHINE rather than about any row under it. -->
                        <template #heading>
                            <span class="flex items-center gap-2 text-2xs font-semibold tracking-wide text-subtle uppercase">
                                Sandboxes on this computer
                                <span v-if="report?.agents.sync" class="font-mono normal-case">agent v{{ report.agents.sync }}</span>
                            </span>
                        </template>
                        <template #actions="{ group }">
                            <SandboxVerbs
                                v-if="group.sandbox"
                                :running="group.sandbox.running"
                                :busy="busyVerb(group)"
                                :disabled="running || busy !== undefined"
                                :logs-open="logOpen(group)"
                                @act="(verb) => act(group, verb)"
                            />
                        </template>
                        <!-- The machine's own output: while a row works, and afterwards for as long as a log tail
                             is being read. -->
                        <template #footer="{ group }">
                            <MachineRunLog
                                v-if="busyVerb(group) || logOpen(group)"
                                :lines="paneLines(group)"
                                :running="busyVerb(group) !== undefined"
                                empty="Starting on this computer…"
                                note="Running on this computer — it keeps going even if you close this window."
                            />
                            <Notice v-if="rowFailure && rowFailure.slug === group.sandbox?.slug" tone="danger" class="text-2xs">
                                {{ rowFailure.message }}
                            </Notice>
                        </template>
                    </MachineDetail>
                </section>

                <footer class="mt-auto flex items-center gap-2 pt-2">
                    <Button size="small" severity="secondary" label="Open workspace" @click="workspaceOpen">
                        <template #icon><Icon name="arrow-up-right" /></template>
                    </Button>
                    <span v-if="info" class="truncate font-mono text-2xs text-subtle">{{ info.appUrl }}</span>
                </footer>
            </template>
        </div>
    </div>
</template>
