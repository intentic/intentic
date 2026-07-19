<script setup lang="ts">
import { cmp } from "@intentic-app/ui";
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

/* The launcher window: a sandbox manager that becomes a guided setup flow whenever a setup request
 * arrives (from the workspace's "Run on this computer" or an OS deep link). The flow reconciles the
 * environment step by step, then runs the native connect pipeline with live progress. */

const info = ref<DesktopInfo | undefined>(undefined);
const report = ref<EnvironmentReport | undefined>(undefined);
const probing = ref(false);
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
const manualChecks = computed(() => report.value?.checks.filter((check) => check.state === `manual`) ?? []);

// --- settings drawer ---
const settingsOpen = ref(false);
const settings = ref<Settings>({ appUrl: null, platformUrl: null, rootfsUrl: null });

const probe = async (): Promise<void> => {
    probing.value = true;
    try {
        report.value = await environmentProbe();
        if (report.value.ready) {
            sandboxes.value = await sandboxList();
        }
    } catch (error) {
        console.error(`probe failed`, error);
    } finally {
        probing.value = false;
    }
};

const refreshSandboxes = async (): Promise<void> => {
    if (report.value?.ready) {
        sandboxes.value = await sandboxList().catch(() => sandboxes.value);
    }
};

/* Reconcile until the environment is ready: fix every fixable check in order, re-probing between
 * fixes. Stops on manual checks (the honest boundary) or a required reboot. */
const reconcile = async (): Promise<boolean> => {
    phase.value = `reconciling`;
    for (let round = 0; round < 8; round += 1) {
        await probe();
        const current = report.value;
        if (current === undefined) {
            return false;
        }
        if (current.ready) {
            return true;
        }
        const fixable = current.checks.find((check) => check.state === `fixable`);
        if (fixable === undefined) {
            phase.value = `blocked`;
            return false;
        }
        fixing.value = fixable.id;
        try {
            const outcome = await environmentFix(fixable.id);
            if (outcome.result === `reboot-required`) {
                phase.value = `reboot`;
                return false;
            }
            if (outcome.result === `manual`) {
                phase.value = `blocked`;
                await probe();
                return false;
            }
        } catch (error) {
            setupError.value = String(error);
            phase.value = `error`;
            return false;
        } finally {
            fixing.value = null;
        }
    }
    phase.value = `blocked`;
    return false;
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
    if (await reconcile()) {
        await provision();
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
            phase.value = inSetup.value ? `reboot` : phase.value;
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
        <div class="mx-auto flex w-full max-w-xl flex-col gap-4 px-5 py-6">
            <header class="flex items-center gap-3">
                <span
                    class="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-primary-600/30 bg-linear-to-br from-primary-600/20 to-primary-600/5"
                >
                    <Icon name="box" class="text-primary-400" />
                </span>
                <div class="flex min-w-0 flex-col">
                    <h1 class="text-lg font-semibold">{{ inSetup ? `Setting up your sandbox` : `Sandbox Manager` }}</h1>
                    <p class="text-xs text-muted">{{ info ? `Intentic Desktop ${info.version}` : `` }}</p>
                </div>
                <Button label="Open workspace" size="small" severity="secondary" class="ml-auto shrink-0" @click="workspaceOpen">
                    <template #icon><Icon name="external-link" /></template>
                </Button>
                <Button v-if="!inSetup" size="small" severity="secondary" :text="true" aria-label="Settings" @click="openSettings">
                    <template #icon><Icon name="settings" /></template>
                </Button>
            </header>

            <div v-if="updateVersion" class="flex items-center gap-2 rounded-xl border border-info/40 bg-info/10 px-3 py-2 text-xs">
                <Icon name="download" class="text-info" />
                <span>Intentic Desktop {{ updateVersion }} is available — it installs on the next restart.</span>
            </div>

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
                        This sandbox uses your own Cloudflare. Paste the API token (Zone:Read · DNS:Edit · Tunnel:Edit) — it goes straight into your
                        sandbox, never to intentic.
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

            <!-- ============ MANAGER ============ -->
            <template v-else>
                <section v-if="settingsOpen" class="flex flex-col gap-3 rounded-xl border border-line bg-canvas p-4">
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

                <section class="flex flex-col gap-2">
                    <div class="flex items-center gap-2">
                        <h2 class="text-sm font-semibold">This computer</h2>
                        <Button size="small" severity="secondary" :text="true" :loading="probing" label="Re-check" class="ml-auto" @click="probe" />
                    </div>
                    <EnvironmentChecklist v-if="report" :checks="report.checks" :fixing="fixing" @fix="fixOne" />
                    <p v-else class="text-xs text-muted"><Icon name="spinner" spin /> Checking Docker and WSL…</p>
                </section>

                <section class="flex flex-col gap-2">
                    <h2 class="text-sm font-semibold">Sandboxes on this computer</h2>
                    <template v-if="sandboxes.length > 0">
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
                    </template>
                    <p v-else class="rounded-xl border border-dashed border-line px-3 py-4 text-xs text-muted">
                        No sandboxes here yet — open the workspace and choose <span class="text-content">Run on this computer</span> during setup.
                    </p>
                </section>

                <SetupProgress v-if="events.length > 0" :events="events" />
            </template>
        </div>
    </div>
</template>
