<script setup lang="ts">
import { Button, cmp, CopyButton, Dialog, Icon } from "@intentic/extension-ui";
import { computed, nextTick, ref, watch } from "vue";
import AutomationFields from "./AutomationFields.vue";
import { host } from "./host";
import { AUTOMATION_RECIPES, type AutomationRecipe } from "./recipes";
import { embedSnippet, useAutomations, webhookUrl } from "./useAutomations";
import { useAutomationForm } from "./useAutomationForm";

/* NEW automation: the template picker, the shared fields, and the one thing creating an automation does not
 * finish — the URL or snippet that still has to be pasted somewhere else.
 *
 * The fields themselves live in AutomationFields, which the row's editor renders too. What is left here is the
 * chrome around a FIRST save: a gallery of starting points (an existing automation has no use for one) and a
 * done-state (an edit has nothing new to paste). */

// Wide enough for the Doorbell branch, which is the longest form here by some way: at 32rem its labelled
// groups wrapped into a column of near-identical rows you had to scroll twice to see the shape of.
const WIDTH = `44rem`;

const visible = defineModel<boolean>(`visible`, { default: false });
/* A recipe the OPENER already chose — the page's suggestion strip, which offers the handful of automations a
 * user won't go looking for. It prefills exactly as picking the same template in here would, so there is one
 * prefill path and the suggestion cannot drift from the gallery entry it names. */
const props = defineProps<{ prefill?: AutomationRecipe }>();

const { automations, save } = useAutomations();
const state = useAutomationForm();
const { form, valid, touchAll, build, reset, loadRecipe } = state;

const capabilities = computed(() => host().workspace.capabilities());
const pickedRecipe = ref<AutomationRecipe | undefined>(undefined);
// Templates are a shortcut INTO the form, not a field of it, so they fold away. A gallery of cards grew one
// card per connected capability and pushed Name below the fold; a disclosure costs one row whatever the recipe
// count is, and what it opens is filterable and scroll-capped rather than unboundedly tall.
const recipesOpen = ref(false);
const recipeFilter = ref(``);
const recipeFilterInput = ref<HTMLInputElement>();
// After creating an event or Doorbell automation the dialog stays open on this id to show what to paste.
const savedId = ref<string | undefined>(undefined);
const submitError = ref<string | undefined>(undefined);
const shaking = ref(false);
const fields = ref<InstanceType<typeof AutomationFields>>();

// Larger tappable cards — idle sits on the overlay surface so it reads as a control without a border.
const CARD_SELECTED = `bg-primary-600/15 text-link ring-1 ring-inset ring-primary-500/40`;
const CARD_IDLE = `bg-overlay text-muted hover:text-content`;

// "Start from" suggestions: provider-less recipes always show; provider-bound ones only when one of their
// capabilities is enabled.
const recipes = computed(() => {
    const enabled = new Set(capabilities.value.map((capability) => capability.config[`provider`]).filter((provider) => typeof provider === `string`));
    return AUTOMATION_RECIPES.filter((recipe) => recipe.providers === undefined || recipe.providers.some((provider) => enabled.has(provider)));
});

// The open picker's list, filtered and split in two: chores watch this workspace, everything else is fired
// from outside it. Two short labelled runs stay scannable where one flat pile of near-identical rows would
// not — "Push to repo" is two different templates once GitHub and GitLab are both connected.
const recipeGroups = computed(() => {
    const needle = recipeFilter.value.trim().toLowerCase();
    const matches = recipes.value.filter((recipe) =>
        [recipe.title, recipe.note, recipe.description, recipe.id, recipe.providers?.join(` `)].some((field) =>
            field?.toLowerCase().includes(needle),
        ),
    );
    return [
        { label: `Code chores`, items: matches.filter((recipe) => recipe.chore === true) },
        { label: `Integrations`, items: matches.filter((recipe) => recipe.chore !== true) },
    ].filter((group) => group.items.length > 0);
});

const savedAutomation = computed(() => automations.value.find((automation) => automation.id === savedId.value));

const resetAll = (): void => {
    reset();
    submitError.value = undefined;
    pickedRecipe.value = undefined;
    recipesOpen.value = false;
    recipeFilter.value = ``;
    savedId.value = undefined;
    shaking.value = false;
};

// Applied on OPEN rather than on mount: the dialog stays mounted between openings and @hide resets the form,
// so prefilling at mount would be erased by the first close and never come back.
watch(visible, (open) => {
    if (open && props.prefill !== undefined) {
        pickedRecipe.value = props.prefill;
        loadRecipe(props.prefill);
    }
});

// Opening the picker always starts from an empty filter and the caret in it — the list is long enough that
// typing two letters beats scrolling it.
const toggleRecipes = (): void => {
    recipesOpen.value = !recipesOpen.value;
    if (!recipesOpen.value) {
        return;
    }
    recipeFilter.value = ``;
    void nextTick(() => recipeFilterInput.value?.focus());
};

const pickRecipe = (recipe: AutomationRecipe): void => {
    pickedRecipe.value = recipe;
    recipesOpen.value = false;
    loadRecipe(recipe);
};

// Enter in the filter takes the top match — and, because the picker sits inside the form, never submits it.
const pickFirstMatch = (): void => {
    const first = recipeGroups.value[0]?.items[0];
    if (first !== undefined) {
        pickRecipe(first);
    }
};

// Choosing a trigger by hand detaches a prefilled recipe once it no longer matches (the user's edits stay).
const onKindChange = (kind: typeof form.kind): void => {
    if (pickedRecipe.value !== undefined && pickedRecipe.value.trigger.kind !== kind) {
        pickedRecipe.value = undefined;
    }
};

const submit = async (): Promise<void> => {
    touchAll();
    if (!valid.value) {
        // Send the user to the first field to fix rather than only shaking the footer.
        (fields.value?.nameInput ?? fields.value?.promptInput)?.focus();
        shaking.value = false;
        void nextTick(() => {
            shaking.value = true;
        });
        return;
    }
    if (save.isPending.value) {
        return;
    }
    submitError.value = undefined;
    try {
        await save.mutateAsync(build());
        // Event and Doorbell automations keep the dialog open: the thing the owner still has to DO lives in the
        // done-state — paste the webhook URL into the sending system, paste the embed snippet into the site.
        if (form.kind === `event` || state.isDoorbell.value) {
            savedId.value = form.id.trim();
            return;
        }
        visible.value = false;
        resetAll();
    } catch (err) {
        submitError.value = err instanceof Error ? err.message : `Could not save the automation.`;
    }
};
</script>

<template>
    <Dialog
        v-model:visible="visible"
        :modal="true"
        :draggable="false"
        :dismissable-mask="true"
        :style="{ width: WIDTH }"
        header="New automation"
        @hide="resetAll"
    >
        <form id="automation-form" v-if="savedId === undefined" class="flex flex-col gap-3" @submit.prevent="submit">
            <div v-if="submitError" :class="cmp.alertDanger()">{{ submitError }}</div>
            <!-- One row until asked for: collapsed it is the invitation, open it is a filterable list, and once
                 something is picked it is that pick's summary. Same row throughout, so the height the templates
                 cost the form never depends on how many capabilities are connected. -->
            <div v-if="recipes.length > 0" class="ui-field">
                <div class="flex items-center rounded-md transition-colors" :class="pickedRecipe ? CARD_SELECTED : CARD_IDLE">
                    <button
                        type="button"
                        class="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-xs"
                        :aria-expanded="recipesOpen"
                        @click="toggleRecipes"
                    >
                        <img v-if="pickedRecipe?.logo" :src="`https://cdn.simpleicons.org/${pickedRecipe.logo}`" class="h-4 w-4 shrink-0" alt="" />
                        <Icon v-else :name="pickedRecipe?.icon ?? 'bolt'" class="shrink-0 text-2xs" />
                        <span class="min-w-0 flex-1 truncate">
                            <template v-if="pickedRecipe">
                                {{ pickedRecipe.title }}
                                <span v-if="pickedRecipe.note" class="text-2xs text-subtle">· {{ pickedRecipe.note }}</span>
                            </template>
                            <template v-else>Start from a template</template>
                        </span>
                        <span v-if="!pickedRecipe" class="shrink-0 text-2xs text-subtle">{{ recipes.length }} available</span>
                        <Icon :name="recipesOpen ? 'chevron-down' : 'chevron-right'" class="shrink-0 text-2xs" />
                    </button>
                    <button
                        v-if="pickedRecipe"
                        type="button"
                        class="shrink-0 px-2.5 py-2 text-2xs text-muted transition-colors hover:text-content"
                        aria-label="Clear template"
                        @click="pickedRecipe = undefined"
                    >
                        <Icon name="times" />
                    </button>
                </div>
                <p v-if="pickedRecipe" class="text-2xs text-subtle">Prefilled below — edit anything, or clear it to start from scratch.</p>
                <div v-if="recipesOpen" class="flex flex-col gap-1.5 rounded-md border border-line bg-canvas p-1.5">
                    <input
                        ref="recipeFilterInput"
                        v-model="recipeFilter"
                        placeholder="Filter templates…"
                        :class="cmp.input('px-2 py-1 text-xs')"
                        @keydown.enter.prevent="pickFirstMatch"
                        @keydown.escape.stop.prevent="recipesOpen = false"
                    />
                    <div class="scrollbar-thin flex max-h-56 flex-col overflow-auto">
                        <template v-for="group in recipeGroups" :key="group.label">
                            <span :class="cmp.sectionLabel('px-1.5 pb-1 pt-2 text-2xs first:pt-0.5')">{{ group.label }}</span>
                            <button
                                v-for="recipe in group.items"
                                :key="recipe.id"
                                type="button"
                                class="flex items-center gap-2 rounded px-1.5 py-1.5 text-left text-xs transition-colors hover:bg-overlay"
                                :class="pickedRecipe === recipe ? 'text-link' : 'text-muted hover:text-content'"
                                :aria-pressed="pickedRecipe === recipe"
                                @click="pickRecipe(recipe)"
                            >
                                <img v-if="recipe.logo" :src="`https://cdn.simpleicons.org/${recipe.logo}`" class="h-4 w-4 shrink-0" alt="" />
                                <Icon v-else :name="recipe.icon ?? 'bolt'" class="shrink-0 text-2xs" />
                                <span class="min-w-0 flex-1 truncate">{{ recipe.title }}</span>
                                <span v-if="recipe.note" class="shrink-0 text-2xs text-subtle">{{ recipe.note }}</span>
                                <Icon name="check-circle" v-if="pickedRecipe === recipe" class="shrink-0 text-2xs" />
                            </button>
                        </template>
                        <p v-if="recipeGroups.length === 0" class="px-1.5 py-2 text-2xs text-subtle">No template matches.</p>
                    </div>
                </div>
            </div>
            <AutomationFields ref="fields" :state="state" :recipe-note="pickedRecipe?.title" @kind-change="onKindChange" />
        </form>
        <!-- The done-state exists for the one thing creating an automation does NOT finish: something still has
             to be pasted elsewhere. Same shape for both — a copyable line and what to do with it. -->
        <div v-else-if="savedAutomation && embedSnippet(savedAutomation)" class="flex flex-col gap-3">
            <p class="text-sm text-content"><Icon name="check-circle" class="mr-1.5 text-success" />Doorbell created — drop this into your site:</p>
            <div class="flex items-center gap-2 rounded-md border border-line bg-canvas px-3 py-2">
                <code class="min-w-0 flex-1 break-all font-mono text-2xs text-content">{{ embedSnippet(savedAutomation) }}</code>
                <CopyButton :text="embedSnippet(savedAutomation) ?? ''" :aria-label="`Copy the embed snippet for ${savedAutomation.id}`" />
            </div>
            <p class="text-xs text-muted">
                Paste it before <span class="font-mono">&lt;/body&gt;</span> on any page you listed above. The launcher appears in the corner; visitor
                conversations show up on your agents board, where you can watch and take over.
            </p>
        </div>
        <div v-else class="flex flex-col gap-3">
            <p class="text-sm text-content"><Icon name="check-circle" class="mr-1.5 text-success" />Automation created — wire up the webhook:</p>
            <div v-if="savedAutomation" class="flex items-center gap-2 rounded-md border border-line bg-canvas px-3 py-2">
                <code class="min-w-0 flex-1 break-all font-mono text-2xs text-content">{{ webhookUrl(savedAutomation) }}</code>
                <CopyButton :text="webhookUrl(savedAutomation) ?? ''" :aria-label="`Copy webhook URL for ${savedAutomation.id}`" />
            </div>
            <p class="text-xs text-muted">{{ pickedRecipe?.setup ?? `Any external system can wake this automation by POSTing this URL.` }}</p>
        </div>
        <template #footer>
            <div v-if="savedId === undefined" :class="['flex justify-end gap-2', shaking ? 'ui-shake' : '']" @animationend="shaking = false">
                <Button label="Cancel" severity="secondary" :text="true" @click="visible = false" />
                <Button type="submit" form="automation-form" label="Create" :loading="save.isPending.value">
                    <template #icon><Icon name="check" /></template>
                </Button>
            </div>
            <div v-else class="flex justify-end">
                <Button label="Done" @click="visible = false" />
            </div>
        </template>
    </Dialog>
</template>
