<script setup lang="ts">
import { Button, cmp, Icon, type IconName, Page, PageHeader, StatusBadge } from "@intentic/extension-ui";
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

// The type signal (issue: api/web read identical). An app's `kind` is the manifest key it was scaffolded from,
// or the framework the daemon detected for an app it found by convention — a frontend (web/landing/astro) and
// a backend (api) get a distinct icon + tint + kind pill so they're told apart at a glance. Matched by the
// canonical keys and framework names with a loose contains() so a custom-named instance (e.g. "storefront-api")
// still classifies; an unrecognized kind falls back to the neutral package glyph and shows itself raw, and an
// app with no kind at all (a bare `dev` script, no framework) shows the glyph alone.
interface AppKind {
    readonly icon: IconName;
    readonly label: string | undefined;
    readonly tint: string;
    readonly pill: string;
    readonly known: boolean;
}
const BACKEND: AppKind = { icon: `server`, label: `API`, tint: `text-primary-500`, pill: `bg-primary-600/10 text-primary-500`, known: true };
const FRONTEND: AppKind = { icon: `globe`, label: `Web`, tint: `text-info`, pill: `bg-info/10 text-info`, known: true };
const kindOf = (kind: string | undefined): AppKind => {
    const key = kind?.toLowerCase() ?? ``;
    if (/api|server|backend|service|worker|daemon|gateway|hono|express|fastify|nest/.test(key)) {
        return BACKEND;
    }
    if (/web|landing|site|front|client|dashboard|admin|spa|astro|vite|next|nuxt|svelte|remix|docs/.test(key)) {
        return FRONTEND;
    }
    // An unrecognized kind labels itself; no kind at all (a bare `dev` script) leaves the glyph to speak.
    return { icon: `box`, label: kind, tint: `text-muted`, pill: `bg-subtle/10 text-subtle`, known: false };
};
// Decorate each app with its resolved kind so the template binds one value per row (no repeated kindOf calls).
const appRows = computed(() => apps.value.map((app) => ({ ...app, badge: kindOf(app.kind) })));

const headerTitle = computed(() => (props.monorepo ? `Apps` : `Tests`));
const headerDescription = computed(() =>
    props.monorepo ? `Start your apps, open a live preview, and run their tests.` : `Run this repo’s vitest suites.`,
);

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
// boot stream live). The panel is opened UP FRONT so its chrome appears instantly, and it is opened BY NAME:
// the session doesn't exist until the POST lands, and a panel opened with no name on an empty strip fills the
// gap with its own `web-*` shell — the stray "1" tab that used to greet every Start. Naming it makes the panel
// wait for this session instead. Focused again once the POST returns (startApp no longer blocks on a refetch),
// which is when the tab is really there.
const startOne = (app: string): Promise<void> =>
    act(async () => {
        openFocused(sessionOf(app));
        await startApp(app);
        openFocused(sessionOf(app));
    });
// Start all opens on the FIRST app's terminal for the same reason — some session has to be named, and the one
// at the top of the list is the one the panel would have landed on anyway.
const startAll = (): Promise<void> =>
    act(async () => {
        const names = stopped.value.map((app) => app.app);
        const first = names[0];
        if (first === undefined) {
            return;
        }
        openFocused(sessionOf(first));
        await Promise.all(names.map((app) => startApp(app)));
        openFocused(sessionOf(first));
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
            <Page width="wide">
                <PageHeader :title="headerTitle" :description="headerDescription">
                    <template #actions>
                        <template v-if="monorepo">
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
                        </template>
                        <Button v-else-if="projects.length > 1" label="Run all" size="small" @click="runTests('all-tests', projects)">
                            <template #icon><Icon name="play" /></template>
                        </Button>
                    </template>
                </PageHeader>

                <div v-if="error" :class="cmp.alertDanger('mb-4')">{{ error }}</div>
                <div v-if="testsError" :class="cmp.alertDanger('mb-4')">{{ testsError }}</div>
                <div v-if="actionError" :class="cmp.alertDanger('mb-4')">{{ actionError }}</div>

                <!-- Apps: startable instances (monorepo only), one grouped list keyed by type. Each app carries its
                     own Run-tests when it owns projects; the type icon (globe = frontend, server = backend) is the
                     at-a-glance signal, backed by a kind pill. -->
                <section v-if="monorepo">
                    <div v-if="appRows.length === 0 && !isLoading" :class="cmp.emptyState()">
                        No apps yet — use “Add app” to scaffold one and get a live preview.
                    </div>
                    <div v-else class="overflow-hidden rounded-lg border border-line bg-card">
                        <div class="flex flex-col divide-y divide-line">
                            <div v-for="app in appRows" :key="app.app" class="flex items-center gap-3 px-4 py-2.5">
                                <Icon :name="app.badge.icon" class="shrink-0 text-lg" :class="app.badge.tint" />
                                <div class="flex min-w-0 flex-1 items-center gap-2">
                                    <span class="truncate font-medium text-content">{{ app.app }}</span>
                                    <span
                                        v-if="app.badge.label"
                                        class="shrink-0 rounded px-1.5 py-0.5 text-2xs font-medium"
                                        :class="app.badge.pill"
                                        >{{ app.badge.label }}</span
                                    >
                                    <span v-if="app.kind && app.kind !== app.app && app.badge.known" class="shrink-0 truncate text-2xs text-subtle">{{
                                        app.kind
                                    }}</span>
                                </div>
                                <StatusBadge
                                    :variant="app.healthy ? 'success' : app.running ? 'info' : 'neutral'"
                                    :label="app.healthy ? 'healthy' : app.running ? 'starting' : 'stopped'"
                                    size="xs"
                                    dot
                                />
                                <a
                                    v-if="app.previewUrl && app.healthy"
                                    :href="app.previewUrl"
                                    target="_blank"
                                    rel="noopener"
                                    class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted hover:bg-overlay hover:text-content"
                                    :aria-label="`Open ${app.app} preview in a new tab`"
                                    v-tooltip.top="'Open preview'"
                                >
                                    <Icon name="external-link" />
                                </a>
                                <button
                                    type="button"
                                    class="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted hover:bg-overlay hover:text-content"
                                    :aria-label="`Open ${app.app} terminal`"
                                    v-tooltip.top="'Terminal'"
                                    @click="openFocused(sessionOf(app.app))"
                                >
                                    <Icon name="align-left" />
                                </button>
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
                                <Button v-if="!app.running" label="Start" size="small" :disabled="busy" @click="startOne(app.app)">
                                    <template #icon><Icon name="play" /></template>
                                </Button>
                                <Button v-else label="Stop" size="small" severity="secondary" :disabled="busy" @click="act(() => stopApp(app.app))">
                                    <template #icon><Icon name="stop" /></template>
                                </Button>
                            </div>
                        </div>
                    </div>
                    <div v-if="adding" class="mt-2 flex items-center gap-2 text-xs text-muted">
                        <Icon name="spinner" spin />
                        <span>Adding apps — follow progress in the terminal.</span>
                    </div>
                </section>

                <!-- Packages: _apps/<x> dirs that carry tests but aren't startable template apps (e.g. cli/sandbox/sync).
                     A secondary group — muted surface + denser rows — so it never competes with the startable apps. -->
                <section v-if="monorepo && packageEntries.length > 0" class="mt-6">
                    <h3 :class="cmp.sectionLabel('mb-2')">Packages</h3>
                    <div class="overflow-hidden rounded-lg border border-line/60 bg-card/40">
                        <div class="flex flex-col divide-y divide-line/60">
                            <div v-for="[name, dirs] in packageEntries" :key="name" class="flex items-center gap-3 px-4 py-2">
                                <Icon name="box" class="shrink-0 text-subtle" />
                                <span class="min-w-0 flex-1 truncate font-mono text-sm text-content">{{ name }}</span>
                                <Button label="Run tests" size="small" severity="secondary" @click="runTests(`${name}__test`, dirs)">
                                    <template #icon><Icon name="bolt" /></template>
                                </Button>
                            </div>
                        </div>
                    </div>
                </section>

                <!-- Library tests: _libs/* + the repo root (monorepo). Also secondary. -->
                <section v-if="monorepo && grouped.libraries.length > 0" class="mt-6">
                    <div class="mb-2 flex items-center justify-between">
                        <h3 :class="cmp.sectionLabel()">Library tests</h3>
                        <Button
                            v-if="grouped.libraries.length > 1"
                            label="Run all"
                            size="small"
                            severity="secondary"
                            @click="runTests('all-tests', grouped.libraries)"
                        >
                            <template #icon><Icon name="play" /></template>
                        </Button>
                    </div>
                    <div class="overflow-hidden rounded-lg border border-line/60 bg-card/40">
                        <div class="flex flex-col divide-y divide-line/60">
                            <div v-for="dir in grouped.libraries" :key="dir" class="flex items-center gap-3 px-4 py-2">
                                <Icon name="bolt" class="shrink-0 text-subtle" />
                                <span class="min-w-0 flex-1 truncate font-mono text-sm text-content">{{ label(dir) }}</span>
                                <Button label="Run" size="small" severity="secondary" @click="runTests(libSuffix(dir), [dir])">
                                    <template #icon><Icon name="play" /></template>
                                </Button>
                            </div>
                        </div>
                    </div>
                </section>

                <!-- A vitest-only (non-monorepo) repo: a single flat Tests list over every project (Run-all lives in the header). -->
                <section v-if="!monorepo">
                    <div v-if="projects.length === 0 && !testsLoading" :class="cmp.emptyState()">
                        No vitest projects found — nothing here owns a vitest.config.* or *.test.* file.
                    </div>
                    <div v-else class="overflow-hidden rounded-lg border border-line bg-card">
                        <div class="flex flex-col divide-y divide-line">
                            <div v-for="dir in projects" :key="dir" class="flex items-center gap-3 px-4 py-2">
                                <Icon name="bolt" class="shrink-0 text-subtle" />
                                <span class="min-w-0 flex-1 truncate font-mono text-sm text-content">{{ label(dir) }}</span>
                                <Button label="Run" size="small" @click="runTests(libSuffix(dir), [dir])">
                                    <template #icon><Icon name="play" /></template>
                                </Button>
                            </div>
                        </div>
                    </div>
                </section>
            </Page>
        </div>
        <AddAppDialog v-if="monorepo" v-model:visible="addOpen" :templates="templates" :apps="apps" @submit="add" />
    </div>
</template>
