<script setup lang="ts">
import { Button, cmp, CopyButton, Icon } from "@intentic/extension-ui";
import { computed, nextTick, ref } from "vue";
import AutomationFields from "./AutomationFields.vue";
import { host } from "./host";
import type { ListenerSource } from "./listenerSources";
import { AUTOMATION_RECIPES, type AutomationRecipe } from "./recipes";
import { embedSnippet, useAutomations, webhookUrl } from "./useAutomations";
import { triggerKey, useAutomationForm } from "./useAutomationForm";

/* NEW automation, IN the list rather than over it.
 *
 * This was a 44rem modal, and the modal had been losing for a while: its width had already gone 32rem → 44rem
 * to stop the Doorbell branch wrapping into a column you scrolled twice, and its template gallery had already
 * been demoted to a fold-away disclosure because one card per connected capability pushed Name below the fold.
 * Both are symptoms of the same thing — an automation is the biggest form in the app, and a dialog is the
 * smallest surface in it.
 *
 * Editing had already drawn that conclusion: it happens in the row, at page width (see AutomationRow). So one
 * form was rendering at two measures, the folds tuned for the narrow one, and every field added had to be
 * checked twice. Creating now uses the same panel, at the same width, and there is one layout again.
 *
 * MOUNTED ONLY WHILE OPEN, so every field, the pick and the error start empty — the dialog stayed mounted
 * between openings and had to hand-reset all three on @hide.
 *
 * The one thing it keeps from the dialog is the HANDOFF: a webhook and a Doorbell are not finished when they
 * are saved, because a URL or a snippet still has to be pasted into some other system. That belongs where the
 * act happened, so the panel stays in place and swaps its body for what to paste — the list is above and below
 * it the whole time, never covered. */

const { prefill, listenerSources } = defineProps<{ prefill?: AutomationRecipe; listenerSources: readonly ListenerSource[] }>();
const emit = defineEmits<{ created: [id: string]; close: [] }>();

const { automations, save } = useAutomations();
const state = useAutomationForm(computed(() => listenerSources));
const { form, valid, touchAll, build, loadRecipe } = state;

const capabilities = computed(() => host().workspace.capabilities());
const picked = ref<AutomationRecipe | undefined>(prefill);
/* The template the form is actually holding — the pick, for as long as the trigger is still the one it prefilled.
 * Choosing another trigger rewrites the prompt for whatever fires now (useAutomationForm), so a chip still naming
 * the template would be naming text that is gone. Derived rather than cleared by hand because the chip is a claim
 * ABOUT the form: read from the form, it cannot disagree with it. */
const template = computed(() =>
    picked.value !== undefined && triggerKey(picked.value.trigger) === state.triggerKey.value ? picked.value : undefined,
);
/* SHUT until asked for, which the dialog had right for a reason that outlived it: ten cards is a wall, and a
 * panel that opens on one has buried the form it exists to show. Collapsed it is one line naming what is behind
 * it, which is all an offer needs to be. What CHANGED with the width is the thing it opens: a grid of cards with
 * room for each template's description, where the dialog could only afford a scroll-capped list of truncated
 * single lines.
 *
 * IT OPENS OVER THE FORM, NOT ABOVE IT. Inline, the collapsed bar was a full-width slab sitting between the
 * panel's title and the Name field — the loudest thing in the panel, in the position that belongs to the first
 * question — and opening it pushed Name 470px down the page, which is the same displacement that got the
 * gallery folded away in the dialog. Both go away by giving it the geometry it always wanted: a control in the
 * panel's own header, and a popover that covers the form for as long as it is being read. Nothing under it
 * moves, so the answer to "what was I filling in?" is still exactly where it was. */
const recipesOpen = ref(false);
const recipeFilter = ref(``);
const recipeFilterInput = ref<HTMLInputElement>();
// After creating an event or Doorbell automation the panel stays on this id to show what to paste.
const savedId = ref<string | undefined>(undefined);
const submitError = ref<string | undefined>(undefined);
const shaking = ref(false);
const fields = ref<InstanceType<typeof AutomationFields>>();

const CARD_SELECTED = `bg-primary-600/15 text-link ring-1 ring-inset ring-primary-500/40`;
const CARD_IDLE = `bg-overlay text-muted hover:text-content`;

// "Start from" suggestions: provider-less recipes always show; provider-bound ones only when one of their
// capabilities is enabled.
const recipes = computed(() => {
    const enabled = new Set(capabilities.value.map((capability) => capability.config[`provider`]).filter((provider) => typeof provider === `string`));
    return AUTOMATION_RECIPES.filter((recipe) => recipe.providers === undefined || recipe.providers.some((provider) => enabled.has(provider)));
});

// The open gallery, filtered and split in two: chores watch this workspace, everything else is fired from
// outside it. Two short labelled runs stay scannable where one flat pile of near-identical cards would not —
// "Push to repo" is two different templates once GitHub and GitLab are both connected.
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

const toggleRecipes = (): void => {
    recipesOpen.value = !recipesOpen.value;
    if (!recipesOpen.value) {
        return;
    }
    recipeFilter.value = ``;
    void nextTick(() => recipeFilterInput.value?.focus());
};

const pickRecipe = (recipe: AutomationRecipe): void => {
    picked.value = recipe;
    recipesOpen.value = false;
    loadRecipe(recipe);
};

// Enter in the filter takes the top match — and, because the gallery sits inside the form, never submits it.
const pickFirstMatch = (): void => {
    const first = recipeGroups.value[0]?.items[0];
    if (first !== undefined) {
        pickRecipe(first);
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
        const id = form.id.trim();
        await save.mutateAsync(build());
        // The two triggers that are not finished by saving hold the panel on their handoff; everything else is
        // done, so the panel closes and the new row opens to show what was made.
        if (form.kind === `event` || state.isDoorbell.value) {
            savedId.value = id;
            return;
        }
        finish(id);
    } catch (err) {
        submitError.value = err instanceof Error ? err.message : `Could not save the automation.`;
    }
};

/* Open the new row, then go. Deferred to HERE rather than fired the moment the save lands, because the handoff
 * and the row it describes would otherwise be on screen together showing the same webhook URL twice — a thing
 * that could not happen while this was a modal covering the list, and reads as two answers to one question.
 * Whichever of the two the user is looking at, it is the only one. */
const finish = (id: string): void => {
    emit(`created`, id);
    emit(`close`);
};
</script>

<template>
    <section class="flex flex-col gap-3 rounded-lg border border-line bg-card p-3.5">
        <div class="flex items-center gap-2">
            <Icon name="plus" class="shrink-0 text-2xs text-subtle" />
            <h2 class="flex-1 text-xs font-semibold text-content">New automation</h2>

            <!-- The offer, at the size of an offer: one control in the panel's chrome, beside the close button,
                 where a starting point belongs. Once something is picked it becomes the pick's name, so the
                 header states what the fields below were prefilled from without spending a row on saying it. -->
            <div v-if="recipes.length > 0" class="relative flex shrink-0 items-center">
                <!-- Clearing the template lives INSIDE the chip, on its tint, because outside it was a bare ✕
                     eight pixels from the panel's own bare ✕ — two identical glyphs side by side, one of which
                     throws away everything typed so far. On the tint it reads as part of the thing it clears. -->
                <div class="flex items-center rounded-md transition-colors" :class="template ? CARD_SELECTED : CARD_IDLE">
                    <button
                        type="button"
                        class="flex max-w-64 cursor-pointer items-center gap-1.5 px-2 py-1 text-2xs"
                        :aria-expanded="recipesOpen"
                        @click="toggleRecipes"
                    >
                        <img v-if="template?.logo" :src="`https://cdn.simpleicons.org/${template.logo}`" class="h-3.5 w-3.5 shrink-0" alt="" />
                        <Icon v-else :name="template?.icon ?? 'bolt'" class="shrink-0" />
                        <span class="min-w-0 truncate">{{ template?.title ?? `Start from a template` }}</span>
                        <span v-if="!template" class="shrink-0 text-subtle">{{ recipes.length }}</span>
                        <Icon name="chevron-down" class="shrink-0" />
                    </button>
                    <button
                        v-if="template"
                        type="button"
                        class="shrink-0 cursor-pointer py-1 pr-2 pl-0.5 text-2xs opacity-70 transition-opacity hover:opacity-100"
                        aria-label="Clear template"
                        @click="picked = undefined"
                    >
                        <Icon name="times" />
                    </button>
                </div>

                <!-- Clicking anywhere else puts it away. A popover with no way out but its own trigger is the
                     one thing worse than the inline bar it replaced. -->
                <div v-if="recipesOpen" class="fixed inset-0 z-10" @click="recipesOpen = false"></div>
                <!-- A WELL, not another card: the panel it floats over is `bg-card`, so a `bg-card` popover read
                     as the panel having grown rather than as a layer above it, and the cards inside it
                     (`bg-overlay`) had nothing to sit against. Canvas is the one surface darker than both, which
                     is what the inline gallery used for the same reason. -->
                <div
                    v-if="recipesOpen"
                    class="absolute right-0 top-full z-20 mt-1.5 flex w-[min(46rem,calc(100vw-6rem))] flex-col gap-2 rounded-lg border border-line-strong bg-canvas p-2 shadow-2xl"
                    @keydown.escape.stop.prevent="recipesOpen = false"
                >
                    <input
                        ref="recipeFilterInput"
                        v-model="recipeFilter"
                        placeholder="Filter templates…"
                        :class="cmp.input('px-2 py-1 text-xs')"
                        @keydown.enter.prevent="pickFirstMatch"
                    />
                    <div class="scrollbar-thin @container flex max-h-[60vh] flex-col gap-2 overflow-y-auto">
                        <template v-for="group in recipeGroups" :key="group.label">
                            <span :class="cmp.sectionLabel('px-0.5 pt-1 text-2xs first:pt-0')">{{ group.label }}</span>
                            <div class="grid gap-1.5 @lg:grid-cols-2 @3xl:grid-cols-3">
                                <button
                                    v-for="recipe in group.items"
                                    :key="recipe.id"
                                    type="button"
                                    class="flex cursor-pointer items-start gap-2 rounded-md px-2.5 py-2 text-left text-xs transition-colors"
                                    :class="template === recipe ? CARD_SELECTED : CARD_IDLE"
                                    :aria-pressed="template === recipe"
                                    @click="pickRecipe(recipe)"
                                >
                                    <img
                                        v-if="recipe.logo"
                                        :src="`https://cdn.simpleicons.org/${recipe.logo}`"
                                        class="mt-0.5 h-4 w-4 shrink-0"
                                        alt=""
                                    />
                                    <Icon v-else :name="recipe.icon ?? 'bolt'" class="mt-0.5 shrink-0 text-2xs" />
                                    <!-- STACKED, not a row. The note beside the title is what the dialog's one-line
                                         rows did, and at a third of this popover's width it took so much of the
                                         card that the title truncated to "Patch security ad…" and the description
                                         wrapped a word per line. Title, then what it does, then when it runs —
                                         each on its own line, each with the whole card to use. -->
                                    <span class="min-w-0 flex-1">
                                        <span class="block truncate font-medium">{{ recipe.title }}</span>
                                        <!-- Chores carry a description and now have room to show it — in the
                                             dialog's one-line rows it lived in a tooltip. An integration has none
                                             by design (see AutomationRecipe.description): title and note say
                                             enough. -->
                                        <span v-if="recipe.description" class="mt-0.5 line-clamp-2 block text-2xs text-subtle">
                                            {{ recipe.description }}
                                        </span>
                                        <span v-if="recipe.note" class="mt-0.5 block truncate text-2xs text-subtle">{{ recipe.note }}</span>
                                    </span>
                                </button>
                            </div>
                        </template>
                        <p v-if="recipeGroups.length === 0" class="px-1.5 py-2 text-2xs text-subtle">No template matches.</p>
                    </div>
                </div>
            </div>

            <button
                type="button"
                class="shrink-0 cursor-pointer text-2xs text-subtle transition-colors hover:text-content"
                aria-label="Close"
                @click="emit(`close`)"
            >
                <Icon name="times" />
            </button>
        </div>

        <form v-if="savedId === undefined" class="flex flex-col gap-3" @submit.prevent="submit">
            <div v-if="submitError" :class="cmp.alertDanger()">{{ submitError }}</div>

            <AutomationFields ref="fields" :state="state" :recipe-note="template?.title" />

            <div :class="['flex justify-end gap-2 border-t border-line pt-3', shaking ? 'ui-shake' : '']" @animationend="shaking = false">
                <Button label="Cancel" severity="secondary" :text="true" @click="emit(`close`)" />
                <Button type="submit" label="Create" :loading="save.isPending.value">
                    <template #icon><Icon name="check" /></template>
                </Button>
            </div>
        </form>

        <!-- The handoff: the one thing creating an automation does NOT finish. Same shape for both — a copyable
             line and what to do with it. -->
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
            <div class="flex justify-end"><Button label="Done" @click="finish(savedId ?? ``)" /></div>
        </div>
        <div v-else class="flex flex-col gap-3">
            <p class="text-sm text-content"><Icon name="check-circle" class="mr-1.5 text-success" />Automation created — wire up the webhook:</p>
            <div v-if="savedAutomation" class="flex items-center gap-2 rounded-md border border-line bg-canvas px-3 py-2">
                <code class="min-w-0 flex-1 break-all font-mono text-2xs text-content">{{ webhookUrl(savedAutomation) }}</code>
                <CopyButton :text="webhookUrl(savedAutomation) ?? ''" :aria-label="`Copy webhook URL for ${savedAutomation.id}`" />
            </div>
            <p class="text-xs text-muted">{{ template?.setup ?? `Any external system can wake this automation by POSTing this URL.` }}</p>
            <div class="flex justify-end"><Button label="Done" @click="finish(savedId ?? ``)" /></div>
        </div>
    </section>
</template>
