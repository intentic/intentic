<script setup lang="ts">
import {
    Button,
    ui,
    Icon,
    Notice,
    noticeOf,
    Page,
    PageAction,
    PageHeader,
    StatusBadge,
    useLoadingReveal,
    type IconName,
} from "@intentic/extension-ui";
import { computed, onMounted, ref, toRef, watch } from "vue";
import AddAppDialog from "./AddAppDialog.vue";
import { groupTests } from "./appTests";
import { host } from "./host";
import { listTerminals, useTerminals } from "./terminals";
import { useApps } from "./useApps";
import { useVitest } from "./useVitest";

// One tile per repo. A monorepo shows Apps (status, preview, start/stop, Run-tests), Packages (tests-only dirs), and
// Library tests; a vitest-only repo shows one flat Tests list. Every run is its own tmux session in the one global
// terminal, so a second Run never no-ops against a running one.

const props = defineProps<{ repo: string; monorepo: boolean }>();
const { apps, templates, error, isLoading, addApps, refresh, startApp, stopApp } = useApps(toRef(props, `repo`));
// Drawn only once the wait has earned it, keyed on the repo so switching starts a fresh wait.
const outline = useLoadingReveal(isLoading, toRef(props, `repo`));
const { projects, error: testsError, isLoading: testsLoading, runTests: postRunTests } = useVitest(toRef(props, `repo`));
const openFocused = (session: string): void => host().terminal.open(session);

const busy = ref(false);
const actionError = ref<string | undefined>(undefined);
const addOpen = ref(false);
// One-shot tmux session; `adding` clears once the daemon's sweep sees the shell back at its prompt (watchAdd). Session
// key uses an underscore (`--add_apps`) so it can't collide with panel-<repo>--<app>.
const adding = ref(false);
const ADD_SESSION = `panel-${props.repo}--add_apps`;
// Whether the session has been seen alive; absence means finished only after presence, not on kickoff.
let sawAdd = false;

const stopped = computed(() => apps.value.filter((app) => !app.running));
const running = computed(() => apps.value.filter((app) => app.running));

// An app's kind names its scaffold template or detected framework, matched loosely against known frontend/backend
// patterns for a badge. Unrecognized or absent kinds fall back to a neutral glyph.
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

// Vitest projects split into this repo's startable apps' own tests, non-app _apps/<x> packages, and libraries.
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

// Runs `pnpm vitest run` for these repo-relative dirs in a one-shot session (panel-<repo>--<suffix>), then focuses it
// in the global terminal.
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

// Watches the shared, push-updated terminals list for the add-apps session to end, then clears the spinner and
// refreshes. `sawAdd` guards against reading absence as an ending before it was ever seen.
const { sessions } = useTerminals();
const watchAdd = (): void => {
    sawAdd = false;
};
watch(sessions, (list) => {
    if (!adding.value) {
        return;
    }
    if (list.some((session) => session.name === ADD_SESSION && session.running)) {
        sawAdd = true;
        return;
    }
    if (sawAdd) {
        sawAdd = false;
        adding.value = false;
        void refresh();
    }
});

// Kicks off the add-apps job and focuses its terminal tab, the live install log that survives navigation. Completion is
// picked up by watchAdd on the shared terminals list.
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

// Opens the terminal focused on the app's named session before the POST lands (an unnamed panel would open its own
// stray shell instead), then refocuses once start completes and the tab is really there.
const startOne = (app: string): Promise<void> =>
    act(async () => {
        openFocused(sessionOf(app));
        await startApp(app);
        openFocused(sessionOf(app));
    });
// Opens on the first app's terminal, since some session must be named and that's the one the panel would land on
// anyway.
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

// Recovers 'Adding…' state after a refresh via a one-shot terminals read, since the reactive list may not have answered
// yet, arming `sawAdd` for watchAdd. No unmount teardown: the watcher is scope-bound and retires with this view.
onMounted(async () => {
    const listed = await listTerminals().catch(() => undefined);
    if (listed?.some((session) => session.name === ADD_SESSION && session.running)) {
        adding.value = true;
        sawAdd = true;
    }
});
</script>

<template>
    <div class="flex h-full min-h-0 flex-col">
        <div class="scrollbar-thin min-h-0 flex-1 overflow-auto">
            <Page width="wide">
                <PageHeader :title="headerTitle">
                    <template #actions>
                        <template v-if="monorepo">
                            <PageAction v-if="stopped.length > 0" icon="play" label="Start all" primary :disabled="busy" @click="startAll" />
                            <PageAction v-if="running.length > 0" icon="stop" label="Stop all" :disabled="busy" @click="stopAll" />
                            <PageAction v-if="templates.length > 0" icon="plus" label="Add app" :disabled="busy || adding" @click="addOpen = true" />
                        </template>
                        <PageAction v-else-if="projects.length > 1" icon="play" label="Run all" primary @click="runTests('all-tests', projects)" />
                    </template>
                </PageHeader>

                <Notice v-if="error" :of="noticeOf(error)" class="mb-4" />
                <Notice v-if="testsError" :of="noticeOf(testsError)" class="mb-4" />
                <Notice v-if="actionError" :of="noticeOf(actionError)" class="mb-4" />

                <!--
                    Startable app instances (monorepo only); each carries its own Run-tests when it owns projects, with a type icon/pill for frontend
                    vs backend at a glance.
                -->
                <section v-if="monorepo">
                    <!-- Skeleton rows stand in while scanning; without them, an empty section reads the same as a repo with no apps. -->
                    <div
                        v-if="isLoading && outline"
                        class="overflow-hidden rounded-lg border border-line-subtle bg-card"
                        role="status"
                        aria-busy="true"
                    >
                        <span class="sr-only">Reading this repository's apps…</span>
                        <div class="flex flex-col divide-y divide-line-subtle" aria-hidden="true">
                            <div v-for="row in 3" :key="row" class="flex items-center gap-3 px-4 py-2.5">
                                <span class="skeleton block h-5 w-5 shrink-0" />
                                <div class="flex min-w-0 flex-1 items-center gap-2">
                                    <span class="skeleton block h-3.5" :class="[`w-32`, `w-24`, `w-40`][row % 3]" />
                                    <span class="skeleton block h-3 w-14 shrink-0" />
                                </div>
                                <span class="skeleton block h-7 w-20 shrink-0" />
                            </div>
                        </div>
                    </div>

                    <div v-else-if="appRows.length === 0 && !isLoading" :class="ui.emptyState()">
                        No apps yet: use "Add app" to scaffold one and get a live preview.
                    </div>
                    <div v-else class="overflow-hidden rounded-lg border border-line-subtle bg-card">
                        <div class="flex flex-col divide-y divide-line-subtle">
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
                                    :class="ui.iconButton(`h-8 w-8`)"
                                    :aria-label="`Open ${app.app} preview in a new tab`"
                                    v-tooltip.top="'Open preview'"
                                >
                                    <Icon name="external-link" />
                                </a>
                                <button
                                    type="button"
                                    :class="ui.iconButton(`h-8 w-8`)"
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
                                    v-tooltip.top="'Run vitest for this app'"
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
                        <span>Adding apps: follow progress in the terminal.</span>
                    </div>
                </section>

                <!-- _apps/<x> dirs with tests but not startable apps; muted and denser so this never competes with Apps. -->
                <section v-if="monorepo && packageEntries.length > 0" class="mt-6">
                    <h3 :class="ui.sectionLabel('mb-2')">Packages</h3>
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
                        <h3 :class="ui.sectionLabel()">Library tests</h3>
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
                    <div v-if="projects.length === 0 && !testsLoading" :class="ui.emptyState()">
                        No vitest projects found: nothing here owns a vitest.config.* or *.test.* file.
                    </div>
                    <div v-else class="overflow-hidden rounded-lg border border-line-subtle bg-card">
                        <div class="flex flex-col divide-y divide-line-subtle">
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
