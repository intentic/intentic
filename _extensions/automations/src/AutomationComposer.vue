<script setup lang="ts">
import { Button, ui, CopyButton, Icon, Notice, noticeOf } from "@intentic/extension-ui";
import { computed, nextTick, ref } from "vue";
import AutomationFields from "./AutomationFields.vue";
import { host } from "./host";
import type { AutomationTemplate } from "@intentic/sandbox-contract";
import { availableTemplates, type AvailableSource, glyph } from "./catalog";
import { embedSnippet, useAutomations, webhookUrl } from "./useAutomations";
import { triggerKey, useAutomationForm } from "./useAutomationForm";

// Composes inline in the list, at page width, matching how editing already works (AutomationRow) rather than in a
// modal. Mounted only while open, so fields, pick and error always start empty. Keeps the dialog's handoff: a webhook
// or Front Desk isn't finished at save, so the panel swaps to what to paste instead of closing.

const { prefill, listenerSources, templates } = defineProps<{
    prefill?: AutomationTemplate;
    listenerSources: readonly AvailableSource[];
    templates: readonly AutomationTemplate[];
}>();
const emit = defineEmits<{ created: [id: string]; close: [] }>();

const { automations, save } = useAutomations();
const state = useAutomationForm(
    computed(() => listenerSources),
    computed(() => templates),
);
const { form, valid, touchAll, build, loadTemplate } = state;

const capabilities = computed(() => host().workspace.capabilities());
const picked = ref<AutomationTemplate | undefined>(prefill);
// The pick, held only while its trigger still matches the form's current one.
const template = computed(() =>
    picked.value !== undefined && triggerKey(picked.value.trigger) === state.triggerKey.value ? picked.value : undefined,
);
// Collapsed until opened, so ten template cards don't bury the form; a popover over the form, not inline, so opening it
// doesn't push the fields down the page.
const recipesOpen = ref(false);
const recipeFilter = ref(``);
const recipeFilterInput = ref<HTMLInputElement>();
// After creating an event or Front Desk automation the panel stays on this id to show what to paste.
const savedId = ref<string | undefined>(undefined);
const submitError = ref<string | undefined>(undefined);
const shaking = ref(false);
const fields = ref<InstanceType<typeof AutomationFields>>();

const CARD_SELECTED = `bg-primary-600/15 text-link ring-1 ring-inset ring-primary-500/40`;
const CARD_IDLE = `bg-overlay text-muted hover:text-content`;

// Templates needing nothing show always; others once a capability they name is connected.
const recipes = computed(() => availableTemplates(templates, capabilities.value));

// Filtered gallery split in two, chores (watch this workspace) vs the rest (fired from outside it), so near-identical
// cards like two "Push to repo" templates stay scannable.
const recipeGroups = computed(() => {
    const needle = recipeFilter.value.trim().toLowerCase();
    const matches = recipes.value.filter((recipe) =>
        [recipe.title, recipe.note, recipe.description, recipe.id, recipe.requires.join(` `)].some((field) => field?.toLowerCase().includes(needle)),
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

const pickRecipe = (recipe: AutomationTemplate): void => {
    picked.value = recipe;
    recipesOpen.value = false;
    loadTemplate(recipe);
};

// Enter in the filter takes the top match, and, because the gallery sits inside the form, never submits it.
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
        // Event and Front Desk aren't finished by saving; everything else closes the panel right away.
        if (form.kind === `event` || state.isFrontDesk.value) {
            savedId.value = id;
            return;
        }
        finish(id);
    } catch (err) {
        submitError.value = err instanceof Error ? err.message : `Could not save the automation.`;
    }
};

// Deferred until Done, not fired at save, or the handoff and the new row would both show the same webhook URL at once:
// two answers to one question.
const finish = (id: string): void => {
    emit(`created`, id);
    emit(`close`);
};
</script>

<template>
    <section class="flex flex-col gap-3 rounded-lg border border-line bg-card p-4">
        <div class="flex items-center gap-2">
            <Icon name="plus" class="shrink-0 text-2xs text-subtle" />
            <!-- Sized like the rail labels inside the panel, not smaller: it's the heading for everything below it. -->
            <h2 class="flex-1 text-sm font-semibold text-content">New automation</h2>

            <!--
                One control in the header, beside close; once picked it shows the template's name, stating what prefilled the fields without a row of
                its own. The kit's chip: one of a set, lit when chosen.
            -->
            <div v-if="recipes.length > 0" class="relative flex shrink-0 items-center">
                <!--
                    The clear button sits inside the chip's own tint, not beside it as a second bare ✕ next to the panel's, which read as two
                    identical, easily confused glyphs.
                -->
                <div class="ui-chip gap-0 px-0" :class="template ? `ui-chip-on` : ``">
                    <button
                        type="button"
                        class="flex max-w-64 cursor-pointer items-center gap-1.5 py-1 pl-2.5 text-2xs"
                        :class="template ? `pr-1` : `pr-2.5`"
                        :aria-expanded="recipesOpen"
                        @click="toggleRecipes"
                    >
                        <img v-if="template?.logo" :src="`https://cdn.simpleicons.org/${template.logo}`" class="h-3.5 w-3.5 shrink-0" alt="" />
                        <Icon v-else :name="glyph(template?.icon) ?? 'bolt'" class="shrink-0" />
                        <span class="min-w-0 truncate">{{ template?.title ?? `Start from a template` }}</span>
                        <span v-if="!template" class="shrink-0 text-subtle">{{ recipes.length }}</span>
                        <Icon name="chevron-down" class="shrink-0" />
                    </button>
                    <button
                        v-if="template"
                        type="button"
                        class="shrink-0 cursor-pointer py-1 pr-2.5 pl-0.5 text-2xs opacity-70 transition-opacity hover:opacity-100"
                        aria-label="Clear template"
                        @click="picked = undefined"
                    >
                        <Icon name="times" />
                    </button>
                </div>

                <!-- Click-outside closes it; a popover with no way out but its own trigger would be worse than the bar it replaced. -->
                <div v-if="recipesOpen" class="fixed inset-0 z-10" @click="recipesOpen = false"></div>
                <!--
                    `bg-canvas`, not `bg-card`: over a `bg-card` panel, a same-toned popover reads as the panel growing, not a layer above it, and
                    its own `bg-overlay` cards need something darker to sit against.
                -->
                <div
                    v-if="recipesOpen"
                    class="absolute right-0 top-full z-20 mt-1.5 flex w-pop-lg flex-col gap-2 rounded-lg border border-line-strong bg-canvas p-2 shadow-2xl"
                    @keydown.escape.stop.prevent="recipesOpen = false"
                >
                    <input
                        ref="recipeFilterInput"
                        v-model="recipeFilter"
                        placeholder="Filter templates…"
                        :class="ui.inputSm()"
                        @keydown.enter.prevent="pickFirstMatch"
                    />
                    <div class="scrollbar-thin @container flex max-h-panel flex-col gap-2 overflow-y-auto">
                        <template v-for="group in recipeGroups" :key="group.label">
                            <span :class="ui.sectionLabel('px-0.5 pt-1 text-2xs first:pt-0')">{{ group.label }}</span>
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
                                    <Icon v-else :name="glyph(recipe.icon) ?? 'bolt'" class="mt-0.5 shrink-0 text-2xs" />
                                    <!--
                                        Stacked, not a row: at this width a note beside the title crowded it into truncating. Title, description,
                                        then note, each on its own line with the whole card's width.
                                    -->
                                    <span class="min-w-0 flex-1">
                                        <span class="block truncate font-medium">{{ recipe.title }}</span>
                                        <!--
                                            Chores show their description directly now, instead of a tooltip; an integration has none by design
                                            (AutomationTemplate.description) since title and note already say enough.
                                        -->
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

            <!-- The kit's icon button, not a bare glyph: same ink, but a thumb-sized hit area and the hover plate every other dismiss has. -->
            <button type="button" :class="ui.iconButton()" aria-label="Close" @click="emit(`close`)">
                <Icon name="times" class="text-xs" />
            </button>
        </div>

        <form v-if="savedId === undefined" class="flex flex-col gap-3" @submit.prevent="submit">
            <Notice v-if="submitError" :of="noticeOf(submitError)" />

            <AutomationFields ref="fields" :state="state" :recipe-note="template?.title" />

            <div :class="['flex justify-end gap-2 border-t border-line-subtle pt-3', shaking ? 'ui-shake' : '']" @animationend="shaking = false">
                <Button label="Cancel" severity="secondary" :text="true" @click="emit(`close`)" />
                <Button type="submit" label="Create" :loading="save.isPending.value">
                    <template #icon><Icon name="check" /></template>
                </Button>
            </div>
        </form>

        <!-- The handoff: what creating an automation doesn't finish by itself. Same shape either way, a copyable line and what to do with it. -->
        <div v-else-if="savedAutomation && embedSnippet(savedAutomation)" class="flex flex-col gap-3">
            <p class="text-sm text-content"><Icon name="check-circle" class="mr-1.5 text-success" />Front Desk created: drop this into your site:</p>
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
            <p class="text-sm text-content"><Icon name="check-circle" class="mr-1.5 text-success" />Automation created: wire up the webhook:</p>
            <div v-if="savedAutomation" class="flex items-center gap-2 rounded-md border border-line bg-canvas px-3 py-2">
                <code class="min-w-0 flex-1 break-all font-mono text-2xs text-content">{{ webhookUrl(savedAutomation) }}</code>
                <CopyButton :text="webhookUrl(savedAutomation) ?? ''" :aria-label="`Copy webhook URL for ${savedAutomation.id}`" />
            </div>
            <p class="text-xs text-muted">{{ template?.setup ?? `Any external system can wake this automation by POSTing this URL.` }}</p>
            <div class="flex justify-end"><Button label="Done" @click="finish(savedId ?? ``)" /></div>
        </div>
    </section>
</template>
