<!-- THE ADD SANDBOX FORM: a name and where it runs, one press (useAddSandbox.ts). Drawn by the phone's dialog
     (AddSandboxDialog.vue) and by Home's new sandbox dialog (features/home/newSandbox/NewSandboxDialog.vue); each puts its
     own buttons in the slot or its footer. Enter in the name field submits, through `submit` rather than straight to the run, so each place
     takes the press its own way. "More ways" folds the two that are not one press (a command to run on a server, an
     address a sandbox already answers on) under the picks, in the same form: there is no other page to go to for them. -->
<script setup lang="ts">
import { Notice, ui } from "@intentic/ui";
import { SANDBOX_NAME_MAX } from "@intentic/constants";
import { useT } from "@intentic/ui/i18n";
import { computed, ref, useId } from "vue";
import { RouterLink } from "vue-router";
import SetupNeedsGoogle from "../SetupNeedsGoogle.vue";
import AddSandboxAttach from "./AddSandboxAttach.vue";
import AddSandboxWays from "./AddSandboxWays.vue";
import { HERE } from "../flow/useSetupOnMachine";
import { ATTACH } from "./useAddSandbox";
import type { AddSandboxHere } from "./useAddSandboxHere";

const { add } = defineProps<{ add: AddSandboxHere[`add`] }>();
// The press, as each place takes it: the phone's dialog creates, Home's also puts up the new sandbox's tile first.
const emit = defineEmits<{ submit: [] }>();

const t = useT();
const { name, problem, pick, options, moreOptions, hostedProblem, loaded, busy, error, attach } = add;
const nothingOffered = computed(() => loaded.value && options.value.length === 0);
const morePicked = computed(() => moreOptions.value.some((option) => option.value === pick.value));
// Open by itself where nothing starts in one press, or where one of its ways is already the pick.
const moreAsked = ref(false);
const moreShown = computed(() => moreAsked.value || morePicked.value || nothingOffered.value);
// The machine of ours the reader cannot have right now, and why; a Google sign-in is a way on, said with its presses.
const hereOffered = computed(() => options.value.some((option) => option.value === HERE));
const chooseHere = async (): Promise<void> => {
    pick.value = HERE;
};
const hostedProblemLine = computed(() => {
    switch (hostedProblem.value) {
        case `occupied`:
            return t(`setup.addSandbox.hostedOccupied`);
        case `full`:
            return t(`setup.setup.outMachinesRightNow`);
        case `restricted`:
            return t(`setup.setup.notAvailableToAccount`);
        default:
            return ``;
    }
});
const runsOnId = useId();
// The name it was given is a suggestion: the first focus selects it, so typing replaces it and a press keeps it.
let suggested = true;
const takeSuggestion = (event: FocusEvent): void => {
    if (suggested && event.target instanceof HTMLInputElement) {
        suggested = false;
        event.target.select();
    }
};
// What the press does under "More ways", said before it is pressed.
const notice = computed(() => (pick.value === ATTACH ? attach.notice.value : error.value));
</script>

<template>
    <form class="flex flex-col gap-4" data-add-sandbox @submit.prevent="emit(`submit`)">
        <label class="ui-field">
            <span class="ui-field-label">{{ t(`shared.name`) }}</span>
            <input
                v-model="name"
                autofocus
                :maxlength="SANDBOX_NAME_MAX"
                :class="[ui.input(), problem ? `ui-field-error-box` : ``]"
                data-add-sandbox-name
                @focus="takeSuggestion"
            />
            <span v-if="problem" class="ui-field-error">
                <Icon name="exclamation-triangle" class="text-2xs" />
                {{ problem }}
            </span>
        </label>

        <!-- WHERE IT RUNS: one list of rows, each saying what the place is; "More ways" folds the two that are not one press
             under the same list, so the pick is one choice whichever row it lands on. -->
        <div class="flex flex-col gap-1.5">
            <span :id="runsOnId" class="ui-field-label">{{ t(`setup.setupOnMachine.runsOn`) }}</span>
            <p v-if="!loaded" class="flex items-center gap-2 py-2 text-xs text-muted">
                <Icon name="spinner" spin class="text-xs" />
                {{ t(`setup.addSandbox.lookingForMachines`) }}
            </p>
            <template v-else>
                <p v-if="nothingOffered" class="text-xs text-muted">{{ t(`setup.addSandbox.nothingInOnePress`) }}</p>
                <fieldset :disabled="busy" class="min-w-0">
                    <AddSandboxWays v-model="pick" :options="options" :more="moreShown ? moreOptions : undefined" :labelled-by="runsOnId">
                        <template #fold>
                            <button
                                type="button"
                                class="ui-row-select flex items-center gap-1.5 self-start rounded-lg px-2.5 py-1.5 text-xs text-muted hover:text-content"
                                data-add-sandbox-more
                                @click="moreAsked = true"
                            >
                                {{ t(`setup.addSandbox.moreWays`) }}
                                <Icon name="chevron-down" class="text-2xs" />
                            </button>
                        </template>
                    </AddSandboxWays>
                </fieldset>
                <!-- The free machine needs a Google sign-in on this account: the ways on, in place of its pick. -->
                <SetupNeedsGoogle v-if="hostedProblem === `google`" :choose-mine="hereOffered ? chooseHere : undefined" />
                <p v-else-if="hostedProblem !== undefined" class="text-xs text-muted" data-add-sandbox-hosted-problem>
                    {{ hostedProblemLine }}
                    <RouterLink v-if="hostedProblem === `occupied`" to="/settings/billing" :class="ui.textButton({ size: `xs` })">{{
                        t(`setup.setup.buyMachine`)
                    }}</RouterLink>
                </p>
            </template>
        </div>

        <AddSandboxAttach v-if="pick === ATTACH" :attach="attach" @submit="emit(`submit`)" />

        <Notice v-if="notice" :of="notice" />
        <button type="submit" class="hidden" tabindex="-1" aria-hidden="true"></button>
        <slot />
    </form>
</template>
