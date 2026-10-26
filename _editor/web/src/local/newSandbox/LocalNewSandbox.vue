<!-- A NEW SANDBOX, MADE FROM THIS COMPUTER (`/sandbox-new`, models/sandbox/addSandbox.ts `LOCAL_ADD_SANDBOX_PATH`): a name and where it runs, one press, in
     this window, as Home's dialog makes one in the workspace. Devices' "Set one up", the switcher's "Add a sandbox" and
     this PC's "use a machine of ours" (`?on=hosted`) open it here rather than sending the reader to the workspace. The
     app makes the row and starts it; from then it is a process on both faces' rails, and its page here follows it. -->
<script setup lang="ts">
import { errorMessage } from "@intentic/base/errors";
import { Button, Notice, Page, SegmentedControl, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { localHost } from "../../app/environments/localHost";
import type { LocalNewSandboxOffers } from "../../app/environments/processes/localProcessHost";
import { autoSandboxName, SANDBOX_NAME_MAX } from "../../client/sandbox/sandboxName";
import { processOnThisComputer } from "../../models/processes/processAddress";

const t = useT();
const route = useRoute();
const router = useRouter();
const host = localHost();

const offers = ref<LocalNewSandboxOffers | undefined>(undefined);
const typed = ref<string | undefined>(undefined);
const taken = ref<readonly string[]>([]);
const name = computed<string>({
    get: () => typed.value ?? autoSandboxName(taken.value),
    set: (next) => {
        typed.value = next;
    },
});
const problem = computed(() => {
    const clean = name.value.trim();
    if (clean === ``) {
        return t(`setup.addSandbox.nameNeeded`);
    }
    return clean.length > SANDBOX_NAME_MAX ? t(`setup.addSandbox.nameTooLong`, { max: SANDBOX_NAME_MAX }) : undefined;
});
const options = computed(() => [
    ...(offers.value?.here === true ? [{ value: `here`, label: t(`setup.setupOnMachine.thisComputer`), icon: `desktop` as const }] : []),
    ...(offers.value?.hosted === true ? [{ value: `hosted`, label: t(`setup.addSandbox.intenticMachine`), icon: `cloud` as const }] : []),
]);
const picked = ref<string>(route.query[`on`] === `hosted` ? `hosted` : `here`);
const pick = computed(() => (options.value.some((option) => option.value === picked.value) ? picked.value : options.value[0]?.value));
const creating = ref(false);
const failure = ref<string | undefined>(undefined);

// The account's names only suggest the next free one: a list the app could not read leaves the default, and says why in
// the log.
const takenNames = async (): Promise<readonly string[]> => {
    try {
        return (await host.roster()).sandboxes.map((entry) => entry.name);
    } catch (error) {
        console.warn(`[local] the account's sandboxes could not be read for a name:`, errorMessage(error));
        return [];
    }
};

onMounted(async () => {
    const [read, names] = await Promise.all([host.newSandbox?.offers(), takenNames()]);
    offers.value = read ?? { here: false, hosted: false };
    taken.value = names;
});

const create = async (): Promise<void> => {
    const on = pick.value;
    if (creating.value || problem.value !== undefined || (on !== `here` && on !== `hosted`) || host.newSandbox === undefined) {
        return;
    }
    creating.value = true;
    failure.value = undefined;
    try {
        const { sandboxId } = await host.newSandbox.create(name.value.trim(), on);
        await router.replace(processOnThisComputer(`sandbox-setup:${sandboxId}`));
    } catch (err) {
        failure.value = errorMessage(err);
    } finally {
        creating.value = false;
    }
};
</script>

<template>
    <Page>
        <div class="mx-auto flex w-full max-w-lg flex-col gap-6 py-6" data-local-new-sandbox>
            <header class="flex flex-col gap-1">
                <h1 class="text-xl font-semibold text-content">{{ t(`sandbox.words.addSandbox`) }}</h1>
                <p class="text-sm text-muted">{{ t(`home.noSandboxLine`) }}</p>
            </header>
            <form class="flex flex-col gap-4" @submit.prevent="create">
                <label class="ui-field">
                    <span class="ui-field-label">{{ t(`shared.name`) }}</span>
                    <input v-model="name" autofocus :maxlength="80" :class="[ui.input(), problem ? `ui-field-error-box` : ``]" />
                    <span v-if="problem" class="ui-field-error">
                        <Icon name="exclamation-triangle" class="text-2xs" />
                        {{ problem }}
                    </span>
                </label>
                <div class="flex flex-col gap-1.5">
                    <span class="ui-field-label">{{ t(`setup.setupOnMachine.runsOn`) }}</span>
                    <p v-if="offers === undefined" class="flex items-center gap-2 text-xs text-muted">
                        <Icon name="spinner" spin class="text-xs" />
                        {{ t(`setup.addSandbox.lookingForMachines`) }}
                    </p>
                    <p v-else-if="options.length === 0" class="text-xs text-muted">{{ offers.hostedProblem ?? t(`setup.addSandbox.nothingInOnePress`) }}</p>
                    <SegmentedControl
                        v-else
                        :model-value="pick ?? ``"
                        :options="options"
                        :wrap="true"
                        :aria-label="t(`setup.setup.whereSandboxRuns`)"
                        @update:model-value="(value: string) => (picked = value)"
                    />
                </div>
                <Notice v-if="failure" :of="{ tone: `warning`, title: failure }" />
                <Button tier="accent" type="submit" class="w-fit" :label="t(`sandbox.words.addSandbox`)" :loading="creating" :disabled="creating || pick === undefined" />
            </form>
        </div>
    </Page>
</template>
