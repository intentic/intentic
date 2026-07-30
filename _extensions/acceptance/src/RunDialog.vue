<script setup lang="ts">
import { Button, Checkbox, cmp, Dialog, Icon, InputText, Select } from "@intentic/extension-ui";
import { computed, ref, watch } from "vue";
import type { Story } from "./stories";
import { DEFAULT_MODEL_VALUE, modelForTurn, PROVIDER_OPTIONS, useModels } from "./useModels";
import type { StartRunInput } from "./useRuns";
import type { useTargets } from "./useTargets";

/* Everything a run needs, on one screen: WHICH stories, WHERE each app is, and WHO tests it.
 *
 * The addresses are the part that earns the dialog. A test pointed at nothing produces N sessions that each
 * discover the app is down and write the same blocked report — expensive, and the user learns it four minutes
 * later. So each URL is filled in from that repo's running dev server, the "start it" button is right here when
 * it is stopped, and the run cannot be submitted while any selected repo has no address.
 *
 * ONE URL FIELD PER REPO, driven by the selection. The area is workspace-wide, so a run may carry the web app's
 * stories and the API's together — two servers, two ports. Fields appear and disappear as stories are ticked,
 * which is also what makes the cross-repo cost visible before it is paid. */

const { stories, contents, criteria, notes, targets } = defineProps<{
    stories: readonly Story[];
    contents: Readonly<Record<string, string>>;
    criteria: Readonly<Record<string, readonly string[]>>;
    // Each repo's docs/user-stories/.acceptance.md, keyed by repo name.
    notes: Readonly<Record<string, string>>;
    targets: ReturnType<typeof useTargets>;
}>();
const visible = defineModel<boolean>(`visible`, { required: true });
const emit = defineEmits<{ submit: [StartRunInput] }>();

const selected = ref(new Set<string>());
const provider = ref(`claude`);
const model = ref(DEFAULT_MODEL_VALUE);
// Keyed by repo. Kept for repos no longer selected too, so unticking a story and re-ticking it does not lose a
// URL that was typed by hand.
const urls = ref<Record<string, string>>({});
const startingPanel = ref<string | undefined>(undefined);
const panelError = ref<string | undefined>(undefined);

const { models } = useModels(provider);

// A provider switch invalidates a pinned model — its ids belong to the provider that vends them.
watch(provider, () => (model.value = DEFAULT_MODEL_VALUE));

const chosen = computed(() => stories.filter((story) => selected.value.has(story.path)));
// First-appearance order of the repos the selection touches — the URL fields, and the keys the run's `targets`
// map is built from.
const repos = computed<readonly string[]>(() => [...new Set(chosen.value.map((story) => story.repo))]);

// Fill any address that is still blank from the daemon's own account of that repo's dev server. Runs on open (a
// panel may have been started since last time) and whenever the suggestion or the selection changes, so "Start
// it" fills the field without a second click. Never overwrites something typed.
const prefill = (): void => {
    urls.value = Object.fromEntries(
        repos.value.map((repo) => [repo, urls.value[repo] === undefined || urls.value[repo] === `` ? targets.suggestedFor(repo) : urls.value[repo]]),
    );
};

watch(visible, (open) => {
    if (!open) {
        return;
    }
    panelError.value = undefined;
    // Everything selected by default — the common gesture is "run them all", and unpicking is cheaper than picking.
    selected.value = new Set(stories.map((story) => story.path));
    prefill();
});
watch([repos, () => repos.value.map((repo) => targets.suggestedFor(repo)).join(`|`)], () => prefill());

const missing = computed<readonly string[]>(() => repos.value.filter((repo) => (urls.value[repo] ?? ``).trim() === ``));
const canRun = computed(() => chosen.value.length > 0 && missing.value.length === 0);

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
        targets: Object.fromEntries(repos.value.map((repo) => [repo, (urls.value[repo] ?? ``).trim()])),
        provider: provider.value,
        model: modelForTurn(model.value),
    });
};
</script>

<template>
    <Dialog v-model:visible="visible" modal header="Run acceptance tests" :style="{ width: `38rem` }">
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
                <div v-for="repo in repos" :key="repo" class="flex flex-col gap-1">
                    <div class="flex items-center gap-2">
                        <span class="w-32 shrink-0 truncate font-mono text-xs text-muted">{{ repo }}</span>
                        <InputText
                            :model-value="urls[repo] ?? ``"
                            placeholder="http://localhost:5173"
                            class="min-w-0 flex-1"
                            @update:model-value="urls = { ...urls, [repo]: $event ?? `` }"
                        />
                        <!-- The dev server exists but is stopped: offer it here rather than sending the user to
                             the Preview tab and back. -->
                        <Button
                            v-if="targets.hasPanel(repo) && !targets.running(repo)"
                            label="Start"
                            size="small"
                            severity="secondary"
                            :disabled="startingPanel === repo"
                            @click="startPanel(repo)"
                        >
                            <template #icon><Icon name="play" /></template>
                        </Button>
                    </div>
                    <p v-if="!targets.hasPanel(repo) && (urls[repo] ?? ``) === ``" class="pl-34 text-2xs text-subtle">
                        No dev server the daemon can start — give it a staging URL, or start the app yourself in a terminal.
                    </p>
                </div>
                <div v-if="panelError" :class="cmp.alertDanger()">{{ panelError }}</div>
                <p v-else-if="repos.length > 0" class="text-2xs text-subtle">
                    The agents reach these from inside the sandbox, so a localhost address is the direct route.
                </p>
            </section>

            <section class="flex gap-3">
                <label class="flex flex-1 flex-col gap-1.5">
                    <span :class="cmp.sectionLabel()">Agent</span>
                    <Select v-model="provider" :options="[...PROVIDER_OPTIONS]" option-label="label" option-value="value" size="small" />
                </label>
                <label class="flex flex-1 flex-col gap-1.5">
                    <span :class="cmp.sectionLabel()">Model</span>
                    <Select v-model="model" :options="models" option-label="label" option-value="value" size="small" />
                </label>
            </section>

            <p class="text-2xs text-subtle">
                Each session runs unattended in its own worktree with tool permissions bypassed, so nothing stops mid-test to ask. The brief forbids
                changing the application's source — defects get reported, not fixed.
            </p>
        </div>

        <template #footer>
            <span v-if="missing.length > 0" class="mr-auto text-2xs text-warning">{{ missing.join(`, `) }} needs an address</span>
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
