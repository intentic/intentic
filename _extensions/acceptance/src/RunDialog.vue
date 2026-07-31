<script setup lang="ts">
import { Button, Checkbox, cmp, Dialog, Icon, InputText, Picker } from "@intentic/extension-ui";
import { computed, ref, watch } from "vue";
import type { Story } from "./stories";
import { DEFAULT_MODEL_VALUE, modelForTurn, PROVIDER_OPTIONS, useModels } from "./useModels";
import type { StartRunInput } from "./useRuns";
import type { useTargets } from "./useTargets";

/* Everything a run needs, on one screen: WHICH stories, WHERE each app is, and WHO tests it.
 *
 * The addresses are the part that earns the dialog. A test pointed at nothing produces N sessions that each
 * discover the app is down and write the same blocked report — expensive, and the user learns it four minutes
 * later. So the run cannot be submitted until every selected repo resolves to something actually serving.
 *
 * THE DEFAULT IS THE APP, NOT ITS URL. Testing the local dev server is the overwhelmingly common case, and a
 * prefilled text box asked the user to verify a string when the honest question is "is it up?". So each repo
 * shows its dev server's STATE — stopped, starting, ready — and typing an address is a disclosure you open when
 * you genuinely mean a different environment (a staging deployment, an app you started by hand). A repo the
 * daemon runs nothing for has no state to show, so that one opens on the field: there, free text is the answer.
 *
 * THE CONTROL NEVER DISAPPEARS. `Start` used to be gated on `!running` and vanished the instant the process
 * spawned — leaving a dialog that looked like nothing had happened, pointed at an address that was still a 502.
 * Start now BECOMES "Starting…" and then "Ready", because those are the three things that can be true.
 *
 * ONE ROW PER REPO, driven by the selection. The area is workspace-wide, so a run may carry the web app's
 * stories and the API's together — two servers, two ports. Rows appear and disappear as stories are ticked,
 * which is also what makes the cross-repo cost visible before it is paid.
 *
 * NOT MODAL. This dialog's whole job is to get an app up, and the only place a boot is legible is the dev
 * server's terminal — which the shell already has a panel for. A mask over it meant the dialog said "Terminals
 * shows it live" while making Terminals unreachable. Without the mask the panel stays usable underneath, so
 * "start it, watch it, run" is one continuous gesture instead of three modes. */

const { stories, contents, criteria, notes, targets, preselect } = defineProps<{
    stories: readonly Story[];
    contents: Readonly<Record<string, string>>;
    criteria: Readonly<Record<string, readonly string[]>>;
    // Each repo's docs/user-stories/.acceptance.md, keyed by repo name.
    notes: Readonly<Record<string, string>>;
    targets: ReturnType<typeof useTargets>;
    // The paths to open ticked. Undefined means every story — see the watch below for why those are different.
    preselect?: readonly string[] | undefined;
}>();
const visible = defineModel<boolean>(`visible`, { required: true });
const emit = defineEmits<{ submit: [StartRunInput] }>();

const selected = ref(new Set<string>());
const provider = ref(`claude`);
const model = ref(DEFAULT_MODEL_VALUE);
/* Both keyed by repo, and both kept for repos no longer selected: unticking a story and re-ticking it must not
 * lose an address that was typed by hand, nor silently drop you back onto the dev server you had overridden. */
const urls = ref<Record<string, string>>({});
const modes = ref<Record<string, `panel` | `custom`>>({});
const startingPanel = ref<string | undefined>(undefined);
const panelError = ref<string | undefined>(undefined);

const { models } = useModels(provider);

// A provider switch invalidates a pinned model — its ids belong to the provider that vends them.
watch(provider, () => (model.value = DEFAULT_MODEL_VALUE));

/* The Picker's model is `T | undefined` because a picker CAN be cleared; neither of these ever is (both carry a
 * real default), so an undefined emission is ignored rather than written through. Explicit binding instead of
 * v-model for exactly that, the same shape AddWantDialog uses. */
const setProvider = (value: string | undefined): void => {
    provider.value = value ?? provider.value;
};
const setModel = (value: string | undefined): void => {
    model.value = value ?? model.value;
};

const chosen = computed(() => stories.filter((story) => selected.value.has(story.path)));
// First-appearance order of the repos the selection touches — the URL fields, and the keys the run's `targets`
// map is built from.
const repos = computed<readonly string[]>(() => [...new Set(chosen.value.map((story) => story.repo))]);

/* DERIVED, not stored: a repo is on its dev server unless the user said otherwise, and one the daemon runs
 * nothing for has only the field. Deriving it means a repo that gains a panel (started from Preview while this
 * was open) stops being stranded in custom mode, with no watcher to keep in sync. */
const modeOf = (repo: string): `panel` | `custom` => modes.value[repo] ?? (targets.stateOf(repo) === `none` ? `custom` : `panel`);
const setMode = (repo: string, mode: `panel` | `custom`): void => {
    modes.value = { ...modes.value, [repo]: mode };
    // Opening the field on a ready server hands over the address it resolved to — the starting point for "same
    // app, different port" — rather than an empty box. Nothing is prefilled from a server that isn't serving.
    if (mode === `custom` && (urls.value[repo] ?? ``) === ``) {
        urls.value = { ...urls.value, [repo]: targets.localUrl(repo) ?? `` };
    }
};

watch(visible, (open) => {
    if (!open) {
        return;
    }
    panelError.value = undefined;
    /* Everything selected by default — the common gesture is "run them all", and unpicking is cheaper than
     * picking. Opened FROM a story it is that story alone: iterating on one promise is the other gesture this
     * dialog serves, and it would be a strange one that started by unticking nine other stories. */
    selected.value = new Set(preselect ?? stories.map((story) => story.path));
    // A panel may have been started from Preview since this list was last read, and the poll only runs while
    // something is mid-start — so without this the dialog can open believing a running server is stopped.
    void targets.refresh();
});

/* THE ADDRESS EACH REPO RESOLVES TO, or undefined when there is none yet. Undefined is the gate: `Run` stays
 * disabled while any selected repo is stopped, still starting, or has an empty field. This is the whole point of
 * the section — a run costs one agent session per story, and every one of them would spend minutes rediscovering
 * that the app is down. */
const targetFor = (repo: string): string | undefined =>
    modeOf(repo) === `custom` ? (urls.value[repo] ?? ``).trim() || undefined : targets.localUrl(repo);

const blocked = computed<readonly string[]>(() => repos.value.filter((repo) => targetFor(repo) === undefined));
const canRun = computed(() => chosen.value.length > 0 && blocked.value.length === 0);

// Named for the reason, not just the repo: "is still starting" and "needs an address" call for different moves,
// and a footer that only said which repo was wrong made the user hunt for which of the two it was.
const blockedNote = computed<string | undefined>(() => {
    const repo = blocked.value[0];
    if (repo === undefined) {
        return undefined;
    }
    const more = blocked.value.length > 1 ? ` (+${blocked.value.length - 1} more)` : ``;
    if (modeOf(repo) === `custom`) {
        return `${repo} needs an address${more}`;
    }
    return targets.stateOf(repo) === `starting` ? `${repo} is still starting${more}` : `${repo}'s dev server isn't running${more}`;
});

const toggle = (path: string): void => {
    const next = new Set(selected.value);
    if (!next.delete(path)) {
        next.add(path);
    }
    selected.value = next;
};

const startPanel = async (repo: string): Promise<void> => {
    startingPanel.value = repo;
    panelError.value = undefined;
    try {
        await targets.startPanel(repo);
    } catch (error) {
        panelError.value = error instanceof Error ? error.message : String(error);
    } finally {
        startingPanel.value = undefined;
    }
};

const submit = (): void => {
    emit(`submit`, {
        stories: chosen.value,
        contents,
        criteria,
        notes,
        targets: Object.fromEntries(repos.value.map((repo) => [repo, targetFor(repo) ?? ``])),
        provider: provider.value,
        model: modelForTurn(model.value),
    });
};
</script>

<template>
    <!-- `position="top"` keeps it clear of the terminal panel, which docks at the bottom: the two surfaces are
         meant to be read together while a server boots. Draggable for the rest. -->
    <Dialog
        v-model:visible="visible"
        :modal="false"
        position="top"
        draggable
        header="Run acceptance tests"
        :style="{ width: `38rem` }"
        :pt="{ root: `shadow-2xl` }"
    >
        <div class="flex flex-col gap-5">
            <section class="flex flex-col gap-2">
                <div class="flex items-center justify-between">
                    <span :class="cmp.sectionLabel()">Stories</span>
                    <div class="flex items-center gap-2 text-2xs">
                        <button
                            type="button"
                            class="cursor-pointer text-muted hover:text-content"
                            @click="selected = new Set(stories.map((s) => s.path))"
                        >
                            All
                        </button>
                        <span class="text-subtle">·</span>
                        <button type="button" class="cursor-pointer text-muted hover:text-content" @click="selected = new Set()">None</button>
                    </div>
                </div>
                <div class="max-h-56 overflow-auto rounded-lg border border-line bg-canvas scrollbar-thin">
                    <label
                        v-for="story in stories"
                        :key="story.path"
                        class="flex cursor-pointer items-center gap-3 border-b border-line/60 px-3 py-2 last:border-b-0 hover:bg-overlay"
                    >
                        <Checkbox :model-value="selected.has(story.path)" binary @update:model-value="toggle(story.path)" />
                        <span class="min-w-0 flex-1">
                            <span class="block truncate text-sm text-content">{{ story.title }}</span>
                            <span class="block truncate font-mono text-2xs text-subtle"
                                >{{ story.repo }}{{ story.group ? ` · ${story.group}` : `` }}</span
                            >
                        </span>
                        <span class="shrink-0 text-2xs text-subtle">{{ (criteria[story.path] ?? []).length || `–` }}</span>
                    </label>
                </div>
                <p class="text-2xs text-subtle">One session per story, running in parallel.</p>
            </section>

            <section class="flex flex-col gap-2">
                <span :class="cmp.sectionLabel()">Applications under test</span>
                <div v-if="repos.length === 0" :class="cmp.emptyState()">Pick at least one story.</div>
                <div v-for="repo in repos" :key="repo" class="flex flex-col gap-2 rounded-lg border border-line bg-canvas px-3 py-2.5">
                    <div class="flex items-center gap-2">
                        <span class="min-w-0 flex-1 truncate font-mono text-xs text-muted">{{ repo }}</span>
                        <!-- The escape hatch, and only that: it is a link rather than a field because a different
                             environment is the exception, and the exception should cost a click, not a reading. -->
                        <button
                            v-if="targets.stateOf(repo) !== `none`"
                            type="button"
                            class="shrink-0 cursor-pointer text-2xs text-muted hover:text-content"
                            @click="setMode(repo, modeOf(repo) === `custom` ? `panel` : `custom`)"
                        >
                            {{ modeOf(repo) === `custom` ? `Use the dev server` : `Different address` }}
                        </button>
                    </div>

                    <template v-if="modeOf(repo) === `panel`">
                        <!-- READY. The address is shown because it is the one fact worth checking at a glance,
                             not because anyone has to approve it. -->
                        <div v-if="targets.stateOf(repo) === `ready`" class="flex min-w-0 items-center gap-2">
                            <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
                            <span class="shrink-0 text-xs text-content">Dev server ready</span>
                            <span class="min-w-0 flex-1 truncate font-mono text-2xs text-subtle">{{ targets.localUrl(repo) }}</span>
                            <Button label="Terminal" size="small" severity="secondary" text @click="targets.showLog(repo)">
                                <template #icon><Icon name="desktop" /></template>
                            </Button>
                        </div>
                        <!-- STARTING. Where Start used to vanish, and where the output lives: the command behind
                             it installs dependencies on a first run, so a silent minute reads as a hang and a
                             failed install has nowhere else to be seen. The terminal is opened by Start itself;
                             this button is how you get back to it. -->
                        <div v-else-if="targets.stateOf(repo) === `starting`" class="flex items-center gap-2">
                            <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                                <span class="flex items-center gap-2 text-xs text-content">
                                    <Icon name="spinner" class="shrink-0 animate-spin text-subtle" />
                                    Starting…
                                </span>
                                <span class="text-2xs text-subtle">A first start installs dependencies, which can take a minute.</span>
                            </div>
                            <Button label="Terminal" size="small" severity="secondary" @click="targets.showLog(repo)">
                                <template #icon><Icon name="desktop" /></template>
                            </Button>
                        </div>
                        <div v-else class="flex items-center gap-2">
                            <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-content/25" />
                            <span class="min-w-0 flex-1 text-xs text-muted">Dev server isn't running</span>
                            <Button label="Start" size="small" severity="secondary" :disabled="startingPanel === repo" @click="startPanel(repo)">
                                <template #icon><Icon name="play" /></template>
                            </Button>
                        </div>
                    </template>

                    <template v-else>
                        <InputText
                            :model-value="urls[repo] ?? ``"
                            placeholder="http://localhost:5173"
                            class="w-full"
                            @update:model-value="urls = { ...urls, [repo]: $event ?? `` }"
                        />
                        <span v-if="targets.stateOf(repo) === `none`" class="text-2xs text-subtle">
                            The daemon runs no dev server for this repo — start the app yourself in a terminal, or point at a deployment.
                        </span>
                    </template>
                </div>
                <div v-if="panelError" :class="cmp.alertDanger()">{{ panelError }}</div>
                <p v-else-if="repos.length > 0" class="text-2xs text-subtle">
                    The agents reach these from inside the sandbox, so a localhost address is the direct route.
                </p>
            </section>

            <!-- The design system's own picker — the control behind the Sandbox hub's model choice — rather
                 than two bare Selects. Same rows, same keyboard handling, same mobile sheet, and a filter box
                 that appears by itself once a provider's model list is long. -->
            <section class="flex gap-3">
                <div class="flex min-w-0 flex-1 flex-col gap-1.5">
                    <span :class="cmp.sectionLabel()">Agent</span>
                    <Picker
                        :model-value="provider"
                        :options="PROVIDER_OPTIONS"
                        class="w-full"
                        aria-label="Agent"
                        header="Agent"
                        @update:model-value="setProvider"
                    />
                </div>
                <div class="flex min-w-0 flex-1 flex-col gap-1.5">
                    <span :class="cmp.sectionLabel()">Model</span>
                    <Picker :model-value="model" :options="models" class="w-full" aria-label="Model" header="Model" @update:model-value="setModel" />
                </div>
            </section>

            <p class="text-2xs text-subtle">
                Each session runs unattended in its own worktree with tool permissions bypassed, so nothing stops mid-test to ask. The brief forbids
                changing the application's source — defects get reported, not fixed.
            </p>
        </div>

        <template #footer>
            <span v-if="blockedNote" class="mr-auto text-2xs text-warning">{{ blockedNote }}</span>
            <Button label="Cancel" severity="secondary" size="small" @click="visible = false" />
            <Button
                :label="`Run ${chosen.length || ``} ${chosen.length === 1 ? `story` : `stories`}`.replace(/\s+/g, ` `)"
                size="small"
                :disabled="!canRun"
                @click="submit"
            >
                <template #icon><Icon name="play" /></template>
            </Button>
        </template>
    </Dialog>
</template>
