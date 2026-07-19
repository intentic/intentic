<script setup lang="ts">
import { cmp, StepSection } from "@intentic-app/ui";
import { ask } from "@tauri-apps/plugin-dialog";
import Button from "primevue/button";
import { computed, onMounted, onUnmounted, ref } from "vue";
import EnvironmentChecklist from "./components/EnvironmentChecklist.vue";
import SandboxCard from "./components/SandboxCard.vue";
import SetupProgress from "./components/SetupProgress.vue";
import {
    desktopInfo,
    environmentFix,
    environmentProbe,
    onPendingSetup,
    onProgress,
    onUpdateAvailable,
    pendingSetup,
    sandboxList,
    sandboxRemove,
    sandboxStart,
    sandboxStop,
    sandboxUpdate,
    setupRun,
    settingsGet,
    settingsSet,
    workspaceOpen,
    type CheckId,
    type DesktopInfo,
    type EnvironmentReport,
    type ProgressEvent,
    type SandboxRecord,
    type SandboxStatus,
    type SetupArgs,
    type Settings,
} from "./desktop";

/* The launcher window, in three personas:
 *   • WIZARD (no local sandboxes yet) — the installer experience: get the machine ready (guided
 *     Docker/WSL fixes), then choose where the sandbox runs (this computer via the workspace's
 *     "Run on this computer", or a server via the copy-paste command). The actual setup request
 *     arrives as an intercepted intentic:// link and flips this window into…
 *   • SETUP — reconcile → claim → containers → health, with a live progress timeline.
 *   • MANAGER (sandboxes exist) — status, start/stop/update/logs/remove + environment health.
 * Served by Vite, so it can open in a plain browser where Tauri IPC doesn't exist — that renders a
 * dev notice instead of wedging on a probe that can never answer. */

const inTauri = `__TAURI_INTERNALS__` in window;

const info = ref<DesktopInfo | undefined>(undefined);
const report = ref<EnvironmentReport | undefined>(undefined);
const probing = ref(false);
const probeError = ref<string | undefined>(undefined);
const sandboxes = ref<SandboxStatus[]>([]);
const busy = ref<Record<string, string | null>>({});
const updateVersion = ref<string | undefined>(undefined);

// --- setup session ---
type Phase = `idle` | `reconciling` | `blocked` | `reboot` | `needs-token` | `provisioning` | `done` | `error`;
const phase = ref<Phase>(`idle`);
const setupArgs = ref<SetupArgs | undefined>(undefined);
const fixing = ref<CheckId | null>(null);
const events = ref<ProgressEvent[]>([]);
const result = ref<SandboxRecord | undefined>(undefined);
const setupError = ref<string | undefined>(undefined);
const cfTokenInput = ref(``);

const inSetup = computed(() => phase.value !== `idle`);
const wizard = computed(() => !inSetup.value && sandboxes.value.length === 0);
const manualChecks = computed(() => report.value?.checks.filter((check) => check.state === `manual`) ?? []);
const fixableChecks = computed(() => report.value?.checks.filter((check) => check.state === `fixable`) ?? []);

// Wizard-side outcome of "Fix everything" — mirrors the setup phases without entering a setup.
const wizardState = ref<`idle` | `fixing` | `reboot`>(`idle`);

// --- settings drawer ---
const settingsOpen = ref(false);
const settings = ref<Settings>({ appUrl: null, platformUrl: null, rootfsUrl: null });

const probe = async (): Promise<void> => {
    probing.value = true;
    probeError.value = undefined;
    try {
        report.value = await environmentProbe();
        if (report.value.ready) {
            sandboxes.value = await sandboxList();
        }
    } catch (error) {
        probeError.value = String(error);
    } finally {
        probing.value = false;
    }
};

const refreshSandboxes = async (): Promise<void> => {
    if (report.value?.ready) {
        sandboxes.value = await sandboxList().catch(() => sandboxes.value);
    }
};

/* Fix every fixable check in order, re-probing between fixes — the shared engine under both the
 * wizard's "Fix everything" and a setup's reconcile stage. Stops at manual checks (the honest
 * boundary: BIOS virtualization, re-login) or a required reboot. */
const runFixes = async (): Promise<`ready` | `blocked` | `reboot` | `error`> => {
    for (let round = 0; round < 8; round += 1) {
        await probe();
        const current = report.value;
        if (current === undefined) {
            return `error`;
        }
        if (current.ready) {
            return `ready`;
        }
        const fixable = current.checks.find((check) => check.state === `fixable`);
        if (fixable === undefined) {
            return `blocked`;
        }
        fixing.value = fixable.id;
        try {
            const outcome = await environmentFix(fixable.id);
            if (outcome.result === `reboot-required`) {
                return `reboot`;
            }
            if (outcome.result === `manual`) {
                await probe();
                return `blocked`;
            }
        } catch (error) {
            setupError.value = String(error);
            return `error`;
        } finally {
            fixing.value = null;
        }
    }
    return `blocked`;
};

const fixEverything = async (): Promise<void> => {
    wizardState.value = `fixing`;
    const outcome = await runFixes();
    wizardState.value = outcome === `reboot` ? `reboot` : `idle`;
};

const provision = async (): Promise<void> => {
    const args = setupArgs.value;
    if (args === undefined) {
        return;
    }
    if (args.mode === `own` && (args.cfToken === undefined || args.cfToken === ``)) {
        phase.value = `needs-token`;
        return;
    }
    phase.value = `provisioning`;
    events.value = [];
    setupError.value = undefined;
    try {
        result.value = await setupRun(args);
        phase.value = `done`;
        await refreshSandboxes();
    } catch (error) {
        setupError.value = String(error);
        phase.value = `error`;
    }
};

const beginSetup = async (args: SetupArgs): Promise<void> => {
    setupArgs.value = args;
    result.value = undefined;
    setupError.value = undefined;
    events.value = [];
    phase.value = `reconciling`;
    const outcome = await runFixes();
    if (outcome === `ready`) {
        await provision();
    } else {
        phase.value = outcome === `reboot` ? `reboot` : outcome === `error` ? `error` : `blocked`;
    }
};

const submitToken = async (): Promise<void> => {
    if (setupArgs.value === undefined || cfTokenInput.value.trim() === ``) {
        return;
    }
    setupArgs.value = { ...setupArgs.value, cfToken: cfTokenInput.value.trim() };
    cfTokenInput.value = ``;
    await provision();
};

const retrySetup = async (): Promise<void> => {
    if (setupArgs.value !== undefined) {
        await beginSetup(setupArgs.value);
    }
};

const leaveSetup = (): void => {
    phase.value = `idle`;
    setupArgs.value = undefined;
    events.value = [];
};

const fixOne = async (id: CheckId): Promise<void> => {
    fixing.value = id;
    try {
        const outcome = await environmentFix(id);
        if (outcome.result === `reboot-required`) {
            wizardState.value = `reboot`;
            if (inSetup.value) {
                phase.value = `reboot`;
            }
        }
    } catch (error) {
        console.error(`fix failed`, error);
    } finally {
        fixing.value = null;
        await probe();
    }
};

const act = async (slug: string, action: `start` | `stop` | `update` | `remove`): Promise<void> => {
    if (action === `remove`) {
        const confirmed = await ask(
            `Remove this sandbox and its workspace data from this machine? The sandbox stays on the platform and can be reconnected.`,
            { title: `Remove sandbox`, kind: `warning` },
        );
        if (!confirmed) {
            return;
        }
    }
    busy.value = { ...busy.value, [slug]: action };
    try {
        if (action === `start`) {
            await sandboxStart(slug);
        } else if (action === `stop`) {
            await sandboxStop(slug);
        } else if (action === `update`) {
            events.value = [];
            await sandboxUpdate(slug);
        } else {
            await sandboxRemove(slug);
        }
    } catch (error) {
        console.error(`${action} failed`, error);
    } finally {
        busy.value = { ...busy.value, [slug]: null };
        await refreshSandboxes();
    }
};

const openSettings = async (): Promise<void> => {
    settings.value = await settingsGet();
    settingsOpen.value = true;
};

const normalize = (value: string | null): string | null => (value === null || value.trim() === `` ? null : value.trim());
const saveSettings = async (): Promise<void> => {
    await settingsSet({
        appUrl: normalize(settings.value.appUrl),
        platformUrl: normalize(settings.value.platformUrl),
        rootfsUrl: normalize(settings.value.rootfsUrl),
    });
    settingsOpen.value = false;
};

const unlisteners: Array<() => void> = [];
onMounted(async () => {
    if (!inTauri) {
        return;
    }
    info.value = await desktopInfo().catch(() => undefined);
    unlisteners.push(await onProgress((event) => events.value.push(event)));
    unlisteners.push(
        await onPendingSetup(async () => {
            const args = await pendingSetup();
            if (args !== null) {
                await beginSetup(args);
            }
        }),
    );
    unlisteners.push(await onUpdateAvailable((version) => (updateVersion.value = version)));
    const args = await pendingSetup().catch(() => null);
    if (args !== null) {
        await beginSetup(args);
    } else {
        await probe();
    }
});
onUnmounted(() => unlisteners.forEach((unlisten) => unlisten()));
</script>

<template>
    <div class="min-h-screen w-full overflow-auto bg-canvas text-content">
        <div class="animate-fade-in mx-auto flex w-full max-w-xl flex-col gap-4 px-5 py-6">
            <header class="flex items-center gap-3">
                <span
                    class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-primary-600/30 bg-linear-to-br from-primary-600/20 to-primary-600/5"
                >
                    <Icon name="box" class="text-primary-400" />
                </span>
                <div class="flex min-w-0 flex-col">
                    <h1 class="text-lg font-semibold">
                        {{ inSetup ? `Setting up your sandbox` : wizard ? `Let's get you set up` : `Sandbox Manager` }}
                    </h1>
                    <p class="text-xs text-muted">{{ info ? `Intentic Desktop ${info.version}` : `` }}</p>
                </div>
                <Button v-if="inTauri" label="Open workspace" size="small" severity="secondary" class="ml-auto shrink-0" @click="workspaceOpen">
                    <template #icon><Icon name="external-link" /></template>
                </Button>
                <Button v-if="inTauri && !inSetup" size="small" severity="secondary" :text="true" aria-label="Settings" @click="openSettings">
                    <template #icon><Icon name="settings" /></template>
                </Button>
            </header>

            <!-- Vite serves this UI to any browser, but only the Tauri shell has the native side. -->
            <div v-if="!inTauri" class="flex flex-col gap-2 rounded-xl border border-warning/40 bg-warning/10 p-4 text-sm">
                <span class="flex items-center gap-2 font-semibold"
                    ><Icon name="warning" class="text-warning" /> This is only the launcher's UI shell</span
                >
                <span class="text-xs text-muted">
                    You're viewing it in a regular browser, where the app's native side (Docker/WSL checks, sandbox lifecycle) doesn't exist. Run the
                    real thing with <code>pnpm --filter @intentic-app/desktop tauri:dev</code> — it starts this dev server and opens it inside the app
                    window.
                </span>
            </div>

            <template v-else>
                <div v-if="updateVersion" class="flex items-center gap-2 rounded-xl border border-info/40 bg-info/10 px-3 py-2 text-xs">
                    <Icon name="download" class="text-info" />
                    <span>Intentic Desktop {{ updateVersion }} is available — it installs on the next restart.</span>
                </div>

                <section v-if="settingsOpen && !inSetup" class="flex flex-col gap-3 rounded-xl border border-line bg-canvas p-4">
                    <h2 class="text-sm font-semibold">Settings</h2>
                    <label class="ui-field">
                        <span class="ui-field-label">Workspace URL</span>
                        <input v-model="settings.appUrl" :placeholder="info?.appUrl" :class="cmp.input(`w-full font-mono`)" />
                    </label>
                    <label class="ui-field">
                        <span class="ui-field-label">Platform URL</span>
                        <input v-model="settings.platformUrl" :placeholder="info?.platformUrl" :class="cmp.input(`w-full font-mono`)" />
                    </label>
                    <div class="flex gap-2">
                        <Button label="Save" size="small" @click="saveSettings" />
                        <Button label="Cancel" size="small" severity="secondary" :text="true" @click="settingsOpen = false" />
                    </div>
                </section>

                <!-- ============ SETUP FLOW ============ -->
                <template v-if="inSetup">
                    <p class="text-sm text-muted">
                        <template v-if="setupArgs?.name">Sandbox “{{ setupArgs.name }}” —</template>
                        {{
                            setupArgs?.mode === `local`
                                ? `private to this computer (no tunnel)`
                                : setupArgs?.mode === `own`
                                  ? `reachable through your own Cloudflare`
                                  : `reachable through intentic's domain`
                        }}
                    </p>

                    <section v-if="report && (phase === `reconciling` || phase === `blocked` || phase === `reboot`)" class="flex flex-col gap-2">
                        <h2 class="text-sm font-semibold">Checking this computer</h2>
                        <EnvironmentChecklist :checks="report.checks" :fixing="fixing" @fix="fixOne" />
                        <div v-if="phase === `reboot`" :class="cmp.alertDanger()">
                            Windows needs to restart to finish enabling WSL. Restart, then open Intentic again — setup resumes here.
                        </div>
                        <template v-if="phase === `blocked`">
                            <div v-if="manualChecks.length > 0" class="text-xs text-muted">Finish the steps above, then check again.</div>
                            <Button label="Check again" size="small" class="self-start" :loading="probing" @click="retrySetup" />
                        </template>
                    </section>

                    <section v-else-if="phase === `needs-token`" class="flex flex-col gap-2">
                        <h2 class="text-sm font-semibold">Your Cloudflare API token</h2>
                        <p class="text-xs text-muted">
                            This sandbox uses your own Cloudflare. Paste the API token (Zone:Read · DNS:Edit · Tunnel:Edit) — it goes straight into
                            your sandbox, never to intentic.
                        </p>
                        <div class="flex items-center gap-2">
                            <input
                                v-model="cfTokenInput"
                                type="password"
                                autocomplete="off"
                                spellcheck="false"
                                placeholder="Cloudflare API token"
                                :class="cmp.input(`w-full font-mono`)"
                                @keydown.enter="submitToken"
                            />
                            <Button label="Continue" :disabled="cfTokenInput.trim() === ``" @click="submitToken" />
                        </div>
                    </section>

                    <section v-else class="flex flex-col gap-2">
                        <h2 class="text-sm font-semibold">Progress</h2>
                        <SetupProgress :events="events" />
                        <div v-if="phase === `error`" :class="cmp.alertDanger()">{{ setupError }}</div>
                        <div v-if="phase === `done` && result" class="flex flex-col gap-2 rounded-xl border border-success/40 bg-success/10 p-4">
                            <span class="flex items-center gap-2 text-sm font-semibold"
                                ><Icon name="check-circle" class="text-success" /> Your sandbox is running</span
                            >
                            <span class="font-mono text-xs text-muted">{{ result.url }}</span>
                            <span class="text-xs text-muted">Your workspace opens it automatically — switch back to the Intentic window.</span>
                        </div>
                    </section>

                    <div class="flex items-center gap-2">
                        <Button v-if="phase === `error`" label="Try again" size="small" @click="retrySetup" />
                        <Button
                            v-if="phase === `done` || phase === `error`"
                            :label="phase === `done` ? `Go to workspace` : `Close`"
                            size="small"
                            :severity="phase === `done` ? undefined : `secondary`"
                            @click="phase === `done` ? (workspaceOpen(), leaveSetup()) : leaveSetup()"
                        />
                    </div>
                </template>

                <!-- ============ WIZARD (no sandboxes yet) ============ -->
                <template v-else-if="wizard">
                    <!-- Step 1: reconcile the machine — the "installer" part. Probes are read-only;
                         fixes run on demand so elevation prompts never fire unasked. -->
                    <StepSection :step="1" :done="report?.ready === true" title="Get this computer ready">
                        <template #actions>
                            <Button size="small" severity="secondary" :text="true" :loading="probing" label="Re-check" @click="probe" />
                        </template>
                        <p v-if="report?.ready" class="text-xs text-muted">
                            All set — this computer can run sandboxes{{ report.engine?.kind === `wsl` ? ` (via the Intentic WSL machine)` : `` }}.
                        </p>
                        <p v-else class="text-xs text-muted">
                            A sandbox is a Docker container. The app checks what's missing and sets it up for you — no Docker Desktop required.
                        </p>
                        <EnvironmentChecklist v-if="report" :checks="report.checks" :fixing="fixing" @fix="fixOne" />
                        <p v-else-if="probing" class="text-xs text-muted"><Icon name="spinner" spin /> Checking Docker and WSL…</p>
                        <div v-if="probeError" :class="cmp.alertDanger('text-2xs')">{{ probeError }}</div>
                        <Button
                            v-if="fixableChecks.length > 0"
                            :label="wizardState === `fixing` ? `Fixing…` : `Fix everything for me`"
                            :loading="wizardState === `fixing`"
                            class="self-start"
                            @click="fixEverything"
                        >
                            <template #icon><Icon name="bolt" /></template>
                        </Button>
                        <div v-if="wizardState === `reboot`" :class="cmp.alertDanger()">
                            Windows needs to restart to finish enabling WSL. Restart, then open Intentic again — you'll continue right here.
                        </div>
                        <div v-if="manualChecks.length > 0 && fixableChecks.length === 0 && report?.ready === false" class="text-xs text-muted">
                            Finish the steps above, then hit Re-check.
                        </div>
                    </StepSection>

                    <!-- Step 2: where should the sandbox live? Both paths go through the workspace
                         (it owns your account + sandbox identity); the difference is what happens
                         after — this app takes over locally, or you paste one command on a server. -->
                    <StepSection :step="2" :done="false" title="Choose where your sandbox runs">
                        <div class="flex flex-col gap-3">
                            <div class="flex flex-col gap-2 rounded-xl border border-primary-600/40 bg-primary-600/5 p-4">
                                <span class="flex items-center gap-2 text-sm font-semibold"
                                    ><Icon name="bolt" class="text-primary-400" /> This computer</span
                                >
                                <p class="text-xs text-muted">
                                    Sign in, name your sandbox, and click <span class="text-content">Set up on this computer</span> — this app takes
                                    it from there: pulls the sandbox, connects the tunnel (or keeps it private to this machine), and your workspace
                                    opens by itself.
                                </p>
                                <Button label="Open the workspace to start" class="self-start" @click="workspaceOpen">
                                    <template #icon><Icon name="external-link" /></template>
                                </Button>
                            </div>
                            <div class="flex flex-col gap-2 rounded-xl border border-line bg-canvas p-4">
                                <span class="flex items-center gap-2 text-sm font-semibold"><Icon name="cloud" class="text-info" /> A server</span>
                                <p class="text-xs text-muted">
                                    Same start — but in step 3 of setup, copy the one-line command and paste it on any Linux server or VPS. The
                                    sandbox runs there; this computer just connects to it.
                                </p>
                                <Button label="Open the workspace to start" severity="secondary" class="self-start" @click="workspaceOpen">
                                    <template #icon><Icon name="external-link" /></template>
                                </Button>
                            </div>
                        </div>
                    </StepSection>

                    <!-- Step 3: passive — the intercepted intentic:// handoff activates the setup flow above. -->
                    <StepSection :step="3" :done="false" title="The app takes it from here">
                        <p class="text-xs text-muted">
                            The moment you choose <span class="text-content">Set up on this computer</span> in the workspace, this window comes
                            forward and shows live progress — nothing to copy, nothing to paste.
                        </p>
                    </StepSection>
                </template>

                <!-- ============ MANAGER (sandboxes exist) ============ -->
                <template v-else>
                    <section class="flex flex-col gap-2">
                        <div class="flex items-center gap-2">
                            <h2 class="text-sm font-semibold">This computer</h2>
                            <Button
                                size="small"
                                severity="secondary"
                                :text="true"
                                :loading="probing"
                                label="Re-check"
                                class="ml-auto"
                                @click="probe"
                            />
                        </div>
                        <EnvironmentChecklist v-if="report" :checks="report.checks" :fixing="fixing" @fix="fixOne" />
                        <div v-if="probeError" :class="cmp.alertDanger('text-2xs')">{{ probeError }}</div>
                    </section>

                    <section class="flex flex-col gap-2">
                        <h2 class="text-sm font-semibold">Sandboxes on this computer</h2>
                        <SandboxCard
                            v-for="sandbox in sandboxes"
                            :key="sandbox.slug"
                            :sandbox="sandbox"
                            :busy="busy[sandbox.slug] ?? null"
                            @start="act($event, `start`)"
                            @stop="act($event, `stop`)"
                            @update="act($event, `update`)"
                            @remove="act($event, `remove`)"
                        />
                    </section>

                    <SetupProgress v-if="events.length > 0" :events="events" />
                </template>
            </template>
        </div>
    </div>
</template>
