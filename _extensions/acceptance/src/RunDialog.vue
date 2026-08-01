<script setup lang="ts">
import { Button, Checkbox, cmp, Dialog, Icon, InputText, Picker } from "@intentic/extension-ui";
import { computed, ref, watch } from "vue";
import { type Story, targetKeyOf } from "./stories";
import { DEFAULT_MODEL_VALUE, modelForTurn, PROVIDER_OPTIONS, useModels } from "./useModels";
import type { StartRunInput } from "./useRuns";
import type { useTargets } from "./useTargets";

/* Everything a run needs, on one screen: WHICH stories, WHERE each app is, and WHO tests it.
 *
 * The addresses are the part that earns the dialog. A test pointed at nothing produces N sessions that each
 * discover the app is down and write the same blocked report — expensive, and the user learns it four minutes
 * later. So the run cannot be submitted until every selected group resolves to something actually serving.
 *
 * THE DEFAULT IS THE APP, NOT ITS URL. Testing the local dev server is the overwhelmingly common case, and a
 * prefilled text box asked the user to verify a string when the honest question is "is it up?". So each row
 * shows its dev server's STATE — stopped, starting, ready — and typing an address is a disclosure you open when
 * you genuinely mean a different environment (a staging deployment, an app you started by hand). A repo the
 * daemon runs nothing for has no state to show, so that one opens on the field: there, free text is the answer.
 *
 * THE CONTROL NEVER DISAPPEARS. `Start` used to be gated on `!running` and vanished the instant the process
 * spawned — leaving a dialog that looked like nothing had happened, pointed at an address that was still a 502.
 * Start now BECOMES "Starting…" and then "Ready", because those are the three things that can be true.
 *
 * ONE ROW PER STORY GROUP, driven by the selection. A run may carry the web app's stories and the API's
 * together, and one repository may serve both — a monorepo's marketing site and its app are two ports behind one
 * `pnpm dev`. The group is the only thing in a stories tree that already says which is which, so it is what an
 * address is chosen for. The dev SERVER is still per repo (the daemon runs one), which is why two groups of one
 * repo share its state and its Start button and differ only in where they are aimed.
 *
 * NOT MODAL. This dialog's whole job is to get an app up, and the only place a boot is legible is the dev
 * server's terminal — which the shell already has a panel for. A mask over it meant the dialog said "Terminals
 * shows it live" while making Terminals unreachable. Without the mask the panel stays usable underneath, so
 * "start it, watch it, run" is one continuous gesture instead of three modes. */

// One address is chosen per (repo, group) pair; the repo is carried alongside because the dev server, its state
// and its Start button are the repo's, not the group's.
interface TargetRow {
    readonly key: string;
    readonly repo: string;
    readonly group: string;
}

const { stories, contents, criteria, notes, targets, remembered, preselect } = defineProps<{
    stories: readonly Story[];
    contents: Readonly<Record<string, string>>;
    criteria: Readonly<Record<string, readonly string[]>>;
    // Each repo's docs/user-stories/.acceptance.md, keyed by repo name.
    notes: Readonly<Record<string, string>>;
    targets: ReturnType<typeof useTargets>;
    // The address each target key was last actually run against, newest run first. This is what saves the
    // marketing site's group from being re-typed every run — see defaultMode below.
    remembered: Readonly<Record<string, string>>;
    // The paths to open ticked. Undefined means every story — see the watch below for why those are different.
    preselect?: readonly string[] | undefined;
}>();
const visible = defineModel<boolean>(`visible`, { required: true });
const emit = defineEmits<{ submit: [StartRunInput] }>();

const selected = ref(new Set<string>());
const provider = ref(`claude`);
const model = ref(DEFAULT_MODEL_VALUE);
/* Both keyed by target key, and both kept for groups no longer selected: unticking a story and re-ticking it must
 * not lose an address that was typed by hand, nor silently drop you back onto the dev server you had overridden. */
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
// First-appearance order of the (repo, group) pairs the selection touches — the URL fields, and the keys the
// run's `targets` map is built from.
const targetRows = computed<readonly TargetRow[]>(() => {
    const rows = new Map<string, TargetRow>();
    for (const story of chosen.value) {
        const key = targetKeyOf(story);
        if (!rows.has(key)) {
            rows.set(key, { key, repo: story.repo, group: story.group });
        }
    }
    return [...rows.values()];
});

/* DERIVED, not stored — three cases, in this order:
 *   • the daemon runs no dev server for the repo, so the field is the only answer there is;
 *   • this group was last run somewhere OTHER than that dev server, which is precisely the marketing-site case
 *     the group targeting exists for: offer that address again rather than making it be re-typed every run;
 *   • otherwise the dev server, which is what almost every group means almost every time.
 * Deriving rather than storing is what keeps this honest as facts land: a repo that gains a panel (started from
 * Preview while this was open) stops being stranded on the field, and a group whose remembered address IS the
 * dev server's settles back onto it the moment the panels query resolves — with no watcher to keep in sync. */
const defaultMode = (row: TargetRow): `panel` | `custom` => {
    if (targets.stateOf(row.repo) === `none`) {
        return `custom`;
    }
    const last = remembered[row.key];
    return last !== undefined && last !== targets.localUrl(row.repo) ? `custom` : `panel`;
};
const modeOf = (row: TargetRow): `panel` | `custom` => modes.value[row.key] ?? defaultMode(row);
// What the field holds: what was typed here, else what this group was last run against.
const urlOf = (row: TargetRow): string => urls.value[row.key] ?? remembered[row.key] ?? ``;
const setMode = (row: TargetRow, mode: `panel` | `custom`): void => {
    modes.value = { ...modes.value, [row.key]: mode };
    // Opening the field on a ready server hands over the address it resolved to — the starting point for "same
    // app, different port" — rather than an empty box. Nothing is prefilled from a server that isn't serving.
    if (mode === `custom` && urlOf(row) === ``) {
        urls.value = { ...urls.value, [row.key]: targets.localUrl(row.repo) ?? `` };
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

/* THE ADDRESS EACH GROUP RESOLVES TO, or undefined when there is none yet. Undefined is the gate: `Run` stays
 * disabled while any selected group is stopped, still starting, or has an empty field. This is the whole point of
 * the section — a run costs one agent session per story, and every one of them would spend minutes rediscovering
 * that the app is down. */
const targetFor = (row: TargetRow): string | undefined => (modeOf(row) === `custom` ? urlOf(row).trim() || undefined : targets.localUrl(row.repo));

const blocked = computed<readonly TargetRow[]>(() => targetRows.value.filter((row) => targetFor(row) === undefined));
const canRun = computed(() => chosen.value.length > 0 && blocked.value.length === 0);

// Named for the reason, not just the group: "is still starting" and "needs an address" call for different moves,
// and a footer that only said which group was wrong made the user hunt for which of the two it was.
const blockedNote = computed<string | undefined>(() => {
    const row = blocked.value[0];
    if (row === undefined) {
        return undefined;
    }
    const more = blocked.value.length > 1 ? ` (+${blocked.value.length - 1} more)` : ``;
    if (modeOf(row) === `custom`) {
        return `${row.key} needs an address${more}`;
    }
    return targets.stateOf(row.repo) === `starting` ? `${row.key} is still starting${more}` : `${row.repo}'s dev server isn't running${more}`;
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
        targets: Object.fromEntries(targetRows.value.map((row) => [row.key, targetFor(row) ?? ``])),
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
                <div v-if="targetRows.length === 0" :class="cmp.emptyState()">Pick at least one story.</div>
                <div v-for="row in targetRows" :key="row.key" class="flex flex-col gap-2 rounded-lg border border-line bg-canvas px-3 py-2.5">
                    <div class="flex items-center gap-2">
                        <!-- Repo and group read as one address label, the same way a story row names itself —
                             two groups of one repo are two rows, and the group is what tells them apart. -->
                        <span class="min-w-0 flex-1 truncate font-mono text-xs text-muted"
                            >{{ row.repo }}<span v-if="row.group" class="text-subtle"> · {{ row.group }}</span></span
                        >
                        <!-- The escape hatch, and only that: it is a link rather than a field because a different
                             environment is the exception, and the exception should cost a click, not a reading. -->
                        <button
                            v-if="targets.stateOf(row.repo) !== `none`"
                            type="button"
                            class="shrink-0 cursor-pointer text-2xs text-muted hover:text-content"
                            @click="setMode(row, modeOf(row) === `custom` ? `panel` : `custom`)"
                        >
                            {{ modeOf(row) === `custom` ? `Use the dev server` : `Different address` }}
                        </button>
                    </div>

                    <template v-if="modeOf(row) === `panel`">
                        <!-- READY. The address is shown because it is the one fact worth checking at a glance,
                             not because anyone has to approve it. -->
                        <div v-if="targets.stateOf(row.repo) === `ready`" class="flex min-w-0 items-center gap-2">
                            <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
                            <span class="shrink-0 text-xs text-content">Dev server ready</span>
                            <span class="min-w-0 flex-1 truncate font-mono text-2xs text-subtle">{{ targets.localUrl(row.repo) }}</span>
                            <Button label="Terminal" size="small" severity="secondary" text @click="targets.showLog(row.repo)">
                                <template #icon><Icon name="desktop" /></template>
                            </Button>
                        </div>
                        <!-- STARTING. Where Start used to vanish, and where the output lives: the command behind
                             it installs dependencies on a first run, so a silent minute reads as a hang and a
                             failed install has nowhere else to be seen. The terminal is opened by Start itself;
                             this button is how you get back to it. -->
                        <div v-else-if="targets.stateOf(row.repo) === `starting`" class="flex items-center gap-2">
                            <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                                <span class="flex items-center gap-2 text-xs text-content">
                                    <Icon name="spinner" class="shrink-0 animate-spin text-subtle" />
                                    Starting…
                                </span>
                                <span class="text-2xs text-subtle">A first start installs dependencies, which can take a minute.</span>
                            </div>
                            <Button label="Terminal" size="small" severity="secondary" @click="targets.showLog(row.repo)">
                                <template #icon><Icon name="desktop" /></template>
                            </Button>
                        </div>
                        <div v-else class="flex items-center gap-2">
                            <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-content/25" />
                            <span class="min-w-0 flex-1 text-xs text-muted">Dev server isn't running</span>
                            <Button
                                label="Start"
                                size="small"
                                severity="secondary"
                                :disabled="startingPanel === row.repo"
                                @click="startPanel(row.repo)"
                            >
                                <template #icon><Icon name="play" /></template>
                            </Button>
                        </div>
                    </template>

                    <template v-else>
                        <InputText
                            :model-value="urlOf(row)"
                            placeholder="http://localhost:5173"
                            class="w-full"
                            @update:model-value="urls = { ...urls, [row.key]: $event ?? `` }"
                        />
                        <span v-if="targets.stateOf(row.repo) === `none`" class="text-2xs text-subtle">
                            The daemon runs no dev server for this repo — start the app yourself in a terminal, or point at a deployment.
                        </span>
                    </template>
                </div>
                <div v-if="panelError" :class="cmp.alertDanger()">{{ panelError }}</div>
                <p v-else-if="targetRows.length > 0" class="text-2xs text-subtle">
                    One address per story group, so a repository that serves more than one app can aim each of them separately. The agents reach these
                    from inside the sandbox, so a localhost address is the direct route.
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
