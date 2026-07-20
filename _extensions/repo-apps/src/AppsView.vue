<script setup lang="ts">
import { Button, Card, cmp, Icon, Page, StatusBadge } from "@intentic/extension-ui";
import { computed, onMounted, onUnmounted, ref, toRef } from "vue";
import AddAppDialog from "./AddAppDialog.vue";
import { groupTests } from "./appTests";
import { host } from "./host";
import { listTerminals } from "./terminals";
import { useApps } from "./useApps";
import { useVitest } from "./useVitest";

/* The workspace extension (formerly two tiles: apps + vitest). One tile per repo. A monorepo shows three
 * groups: Apps (startable instances — live status + preview + start/stop + an Add-an-app dialog, each with its
 * own vitest projects as a Run-tests action), Packages (non-app _apps/<x> dirs that carry tests but no preview),
 * and Library tests (_libs/* + the repo root). A vitest-only repo shows a single flat Tests list. Every run —
 * dev servers, test runs, the add-apps job — is a tmux session the daemon creates and the ONE global terminal
 * panel attaches; there is no embedded terminal. Each Run targets its OWN session so a second Run never
 * no-ops against a still-running one. */

const props = defineProps<{ repo: string; monorepo: boolean }>();
const { apps, templates, error, isLoading, addApps, refresh, startApp, stopApp } = useApps(toRef(props, `repo`));
const { projects, error: testsError, isLoading: testsLoading, runTests: postRunTests } = useVitest(toRef(props, `repo`));
const openFocused = (session: string): void => host().terminal.open(session);

const busy = ref(false);
const actionError = ref<string | undefined>(undefined);
const addOpen = ref(false);
// The add-apps job runs in a one-shot tmux session (see workspace.routes addApps); its terminal is the live
// install log. `adding` drives the indicator from kickoff until the daemon's sweep sees the job's shell back at
// its prompt (watchAdd). The `--add_apps` key uses an underscore so it can never collide with an app panel
// session (panel-<repo>--<app>).
const adding = ref(false);
const ADD_SESSION = `panel-${props.repo}--add_apps`;
let addPoll: ReturnType<typeof setInterval> | undefined;

const stopped = computed(() => apps.value.filter((app) => !app.running));
const running = computed(() => apps.value.filter((app) => app.running));

// Vitest projects split into: this repo's startable apps' own tests, non-app _apps/<x> packages, and libraries.
const grouped = computed(() =>
    groupTests(
        projects.value,
        apps.value.map((app) => app.app),
        props.repo,
    ),
);
const testsOf = (app: string): string[] => grouped.value.byApp.get(app) ?? [];
const packageEntries = computed(() => [...grouped.value.packages.entries()]);
const label = (dir: string): string => (dir === props.repo ? `root` : dir.slice(`${props.repo}/`.length));

// The app's dev-server tmux session (started server-side by startApp).
const sessionOf = (app: string): string => `panel-${props.repo}--${app}`;
// A per-library-dir test session suffix, distinct from every app/package one (`<slug>__test`).
const libSuffix = (dir: string): string =>
    `${label(dir)
        .replace(/[^a-z0-9]+/g, `-`)
        .replace(/^-+|-+$/g, ``)
        .toLowerCase()}__test`;

const act = async (action: () => Promise<void>): Promise<void> => {
    actionError.value = undefined;
    busy.value = true;
    try {
        await action();
    } catch (err) {
        actionError.value = err instanceof Error ? err.message : `The action failed.`;
    } finally {
        busy.value = false;
    }
};

// Ask the daemon to run `pnpm vitest run` for these repo-relative dirs in a one-shot session
// panel-<repo>--<suffix>, then attach it in the global panel (the daemon created it, so focus is reliable).
const runTests = (suffix: string, dirs: readonly string[]): Promise<void> =>
    act(async () => {
        if (dirs.length === 0) {
            return;
        }
        await postRunTests(
            suffix,
            dirs.map((dir) => (dir === props.repo ? `` : dir.slice(`${props.repo}/`.length))),
        );
        openFocused(`panel-${props.repo}--${suffix}`);
    });

// Poll until the add-apps session is gone or its tab dims (running=false once the daemon's sweep sees the job's
// shell back at its prompt), then clear the spinner and refresh so the new apps appear. A transient list failure
// keeps polling — the job's fate is unknown.
const watchAdd = (): void => {
    addPoll ??= setInterval(async () => {
        const sessions = await listTerminals().catch(() => undefined);
        if (sessions === undefined || sessions.some((session) => session.name === ADD_SESSION && session.running)) {
            return;
        }
        clearInterval(addPoll);
        addPoll = undefined;
        adding.value = false;
        void refresh();
    }, 2500);
};

// Kick off the add-apps tmux job (from the dialog's picks) and hand the user its terminal tab — the terminal IS
// the live install log and survives refresh/navigation. Completion is observed by watchAdd polling `running`.
const add = (entries: { template: string; name: string }[]): Promise<void> =>
    act(async () => {
        adding.value = true;
        try {
            await addApps(entries);
        } catch (err) {
            adding.value = false;
            throw err;
        }
        openFocused(ADD_SESSION);
        watchAdd();
    });

// Any start opens the global terminal focused on the app — the terminals ARE the launch feedback (install +
// boot stream live).
const startOne = (app: string): Promise<void> =>
    act(async () => {
        await startApp(app);
        openFocused(sessionOf(app));
    });
const startAll = (): Promise<void> =>
    act(async () => {
        await Promise.all(stopped.value.map((app) => startApp(app.app)));
        host().terminal.setOpen(true);
    });
const stopAll = (): Promise<void> => act(async () => Promise.all(running.value.map((app) => stopApp(app.app))).then(() => undefined));

// A refresh/navigation during a run: the tmux job survived it, so recover the "Adding…" state from the
// terminals list and resume watching. Unmount only stops the watcher — the job and its tab live on globally.
onMounted(async () => {
    const sessions = await listTerminals().catch(() => undefined);
    if (sessions !== undefined && sessions.some((session) => session.name === ADD_SESSION && session.running)) {
        adding.value = true;
        watchAdd();
    }
});
onUnmounted(() => {
    if (addPoll !== undefined) {
        clearInterval(addPoll);
        addPoll = undefined;
    }
});
</script>

<template>
    <div class="flex h-full min-h-0 flex-col">
        <div class="min-h-0 flex-1 overflow-auto">
            <Page width="wide" class="flex flex-col gap-6">
                <div v-if="error" :class="cmp.alertDanger()">{{ error }}</div>
                <div v-if="testsError" :class="cmp.alertDanger()">{{ testsError }}</div>
                <div v-if="actionError" :class="cmp.alertDanger()">{{ actionError }}</div>

                <!-- Apps: startable instances (monorepo only). Each app carries its own Run-tests when it owns projects. -->
                <section v-if="monorepo" class="flex flex-col gap-2">
                    <div class="flex items-center justify-between">
                        <h2 class="text-2xs font-medium uppercase tracking-wide text-subtle">Apps</h2>
                        <div class="flex items-center gap-2">
                            <Button v-if="stopped.length > 0" label="Start all" size="small" :disabled="busy" @click="startAll">
                                <template #icon><Icon name="play" /></template>
                            </Button>
                            <Button v-if="running.length > 0" label="Stop all" size="small" severity="secondary" :disabled="busy" @click="stopAll">
                                <template #icon><Icon name="stop" /></template>
                            </Button>
                            <Button
                                v-if="templates.length > 0"
                                label="Add app"
                                size="small"
                                severity="secondary"
                                :disabled="busy || adding"
                                @click="addOpen = true"
                            >
                                <template #icon><Icon name="plus" /></template>
                            </Button>
                        </div>
                    </div>
                    <Card v-if="apps.length === 0 && !isLoading" dashed class="text-center text-sm text-muted">
                        No apps yet — use “Add app” to scaffold one and get a live preview.
                    </Card>
                    <Card v-for="app in apps" :key="app.app" class="flex items-center justify-between gap-3">
                        <div class="flex min-w-0 items-center gap-2.5">
                            <Icon name="box" class="text-muted" />
                            <div class="min-w-0">
                                <span class="font-medium">{{ app.app }}</span>
                                <span v-if="app.template !== app.app" class="ml-1.5 text-2xs text-muted">({{ app.template }})</span>
                                <a
                                    v-if="app.previewUrl && app.healthy"
                                    :href="app.previewUrl"
                                    target="_blank"
                                    rel="noopener"
                                    class="block truncate text-2xs text-link hover:underline"
                                    >{{ app.previewUrl }}</a
                                >
                            </div>
                        </div>
                        <div class="flex shrink-0 items-center gap-2">
                            <StatusBadge
                                :variant="app.healthy ? 'success' : app.running ? 'info' : 'neutral'"
                                :label="app.healthy ? 'healthy' : app.running ? 'starting' : 'stopped'"
                                size="xs"
                            />
                            <Button
                                v-if="testsOf(app.app).length > 0"
                                label="Run tests"
                                size="small"
                                severity="secondary"
                                v-tooltip.top="'Run this app’s vitest projects'"
                                @click="runTests(`${app.app}__test`, testsOf(app.app))"
                            >
                                <template #icon><Icon name="bolt" /></template>
                            </Button>
                            <button
                                type="button"
                                class="flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-overlay hover:text-content"
                                :aria-label="`Open ${app.app} terminal`"
                                v-tooltip.top="'Terminal'"
                                @click="openFocused(sessionOf(app.app))"
                            >
                                <Icon name="align-left" />
                            </button>
                            <Button v-if="!app.running" label="Start" size="small" :disabled="busy" @click="startOne(app.app)">
                                <template #icon><Icon name="play" /></template>
                            </Button>
                            <Button v-else label="Stop" size="small" severity="secondary" :disabled="busy" @click="act(() => stopApp(app.app))">
                                <template #icon><Icon name="stop" /></template>
                            </Button>
                        </div>
                    </Card>
                    <div v-if="adding" class="flex items-center gap-2 text-xs text-muted">
                        <Icon name="spinner" spin />
                        <span>Adding apps — follow progress in the terminal.</span>
                    </div>
                </section>

                <!-- Packages: _apps/<x> dirs that carry tests but aren't startable template apps (e.g. cli/sandbox/sync). -->
                <section v-if="monorepo && packageEntries.length > 0" class="flex flex-col gap-2">
                    <h2 class="text-2xs font-medium uppercase tracking-wide text-subtle">Packages</h2>
                    <Card v-for="[name, dirs] in packageEntries" :key="name" class="flex items-center justify-between gap-3">
                        <div class="flex min-w-0 items-center gap-2.5">
                            <Icon name="box" class="text-muted" />
                            <span class="truncate font-mono text-sm">{{ name }}</span>
                        </div>
                        <Button label="Run tests" size="small" severity="secondary" @click="runTests(`${name}__test`, dirs)">
                            <template #icon><Icon name="bolt" /></template>
                        </Button>
                    </Card>
                </section>

                <!-- Library tests: _libs/* + the repo root (monorepo). -->
                <section v-if="monorepo && grouped.libraries.length > 0" class="flex flex-col gap-2">
                    <div class="flex items-center justify-between">
                        <h2 class="text-2xs font-medium uppercase tracking-wide text-subtle">Library tests</h2>
                        <Button v-if="grouped.libraries.length > 1" label="Run all" size="small" @click="runTests('all-tests', grouped.libraries)">
                            <template #icon><Icon name="play" /></template>
                        </Button>
                    </div>
                    <Card v-for="dir in grouped.libraries" :key="dir" class="flex items-center justify-between gap-3">
                        <div class="flex min-w-0 items-center gap-2.5">
                            <Icon name="bolt" class="text-muted" />
                            <span class="truncate font-mono text-sm">{{ label(dir) }}</span>
                        </div>
                        <Button label="Run" size="small" @click="runTests(libSuffix(dir), [dir])">
                            <template #icon><Icon name="play" /></template>
                        </Button>
                    </Card>
                </section>

                <!-- A vitest-only (non-monorepo) repo: a single flat Tests list over every project. -->
                <section v-if="!monorepo" class="flex flex-col gap-2">
                    <div class="flex items-center justify-between">
                        <h2 class="text-2xs font-medium uppercase tracking-wide text-subtle">Tests</h2>
                        <Button v-if="projects.length > 1" label="Run all" size="small" @click="runTests('all-tests', projects)">
                            <template #icon><Icon name="play" /></template>
                        </Button>
                    </div>
                    <Card v-if="projects.length === 0 && !testsLoading" dashed class="text-center text-sm text-muted">
                        No vitest projects found — nothing here owns a vitest.config.* or *.test.* file.
                    </Card>
                    <Card v-for="dir in projects" :key="dir" class="flex items-center justify-between gap-3">
                        <div class="flex min-w-0 items-center gap-2.5">
                            <Icon name="bolt" class="text-muted" />
                            <span class="truncate font-mono text-sm">{{ label(dir) }}</span>
                        </div>
                        <Button label="Run" size="small" @click="runTests(libSuffix(dir), [dir])">
                            <template #icon><Icon name="play" /></template>
                        </Button>
                    </Card>
                </section>
            </Page>
        </div>
        <AddAppDialog v-if="monorepo" v-model:visible="addOpen" :templates="templates" :apps="apps" @submit="add" />
    </div>
</template>
