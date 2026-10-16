<script setup lang="ts">
import { Notice, type NoticeModel, ui, vAction } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { KEYRING_PACKAGE_RE, KEYRING_PROGRAMS_MAX, KeyringProgramSchema } from "@intentic/sandbox-contract/schemas/keyring";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, ref, watch } from "vue";
import type { SecretRow } from "../../../sandbox/secrets/secretRows";
import { useCredentialGates, useSecretPrograms } from "../../../../models/capabilities/useSecrets";

// The program guard, the host guard's counterpart for typing into windows: a sandbox-held secret typed into a window on
// one of the owner's computers goes unasked only into a program listed here (or a phone app, by package) and, unless it
// may go into any field, only into a password field; anywhere else the person at that computer is asked. Nothing listed:
// every typing asks. A keyring's own entries keep their list on their computer, so their rows never draw this. The draft
// stays local until the owner saves, like the host list above it.

const t = useT();

const { row, expanded } = defineProps<{ row: SecretRow; expanded: boolean }>();

// Only the owner widens a list (the daemon's rule); everybody else reads it.
const { isOwner } = useCredentialGates();
const { programsFor, setPrograms } = useSecretPrograms();

const subject = computed(() => row.entry.key);
const stored = computed(() => programsFor(subject.value) ?? row.entry.programs);
const draftPrograms = ref<string[]>([]);
const draftPackages = ref<string[]>([]);
const draftAnyField = ref(false);
const typedProgram = ref(``);
const typedPackage = ref(``);
const typedError = ref<string | undefined>(undefined);
const error = ref<NoticeModel | undefined>(undefined);

// Re-syncs to the server's list whenever the row opens or the list changes, so a stale draft can't overwrite another
// tab's edit.
watch(
    [() => expanded, stored],
    () => {
        draftPrograms.value = [...(stored.value?.programs ?? [])];
        draftPackages.value = [...(stored.value?.packages ?? [])];
        draftAnyField.value = stored.value?.anyField ?? false;
        typedProgram.value = ``;
        typedPackage.value = ``;
        typedError.value = undefined;
        error.value = undefined;
    },
    { immediate: true },
);

// One list's limit covers both: the route refuses a longer one, so a box that took more would be a promise it breaks.
const full = (list: readonly string[]): boolean => list.length >= KEYRING_PROGRAMS_MAX;

const addProgram = (): void => {
    const program = typedProgram.value.trim();
    if (!KeyringProgramSchema.safeParse(program).success || program === ``) {
        typedError.value = t(`capabilities.secretPrograms.notAProgram`);
        return;
    }
    typedError.value = undefined;
    typedProgram.value = ``;
    // Windows matches a program's name without case, so FortiClient.exe and forticlient.exe are one entry.
    if (!draftPrograms.value.some((entry) => entry.toLowerCase() === program.toLowerCase()) && !full(draftPrograms.value)) {
        draftPrograms.value = [...draftPrograms.value, program];
    }
};

const addPackage = (): void => {
    const name = typedPackage.value.trim();
    if (!KEYRING_PACKAGE_RE.test(name) || name.length > 255) {
        typedError.value = t(`capabilities.secretPrograms.notAPackage`);
        return;
    }
    typedError.value = undefined;
    typedPackage.value = ``;
    if (!draftPackages.value.includes(name) && !full(draftPackages.value)) {
        draftPackages.value = [...draftPackages.value, name];
    }
};

const removeProgram = (program: string): void => {
    draftPrograms.value = draftPrograms.value.filter((entry) => entry !== program);
};
const removePackage = (name: string): void => {
    draftPackages.value = draftPackages.value.filter((entry) => entry !== name);
};

const sameList = (left: readonly string[], right: readonly string[]): boolean =>
    left.length === right.length && left.every((entry) => right.includes(entry));
const dirty = computed(
    () =>
        !sameList(stored.value?.programs ?? [], draftPrograms.value) ||
        !sameList(stored.value?.packages ?? [], draftPackages.value) ||
        (stored.value?.anyField ?? false) !== draftAnyField.value,
);

const save = async (): Promise<void> => {
    error.value = undefined;
    try {
        await setPrograms.mutateAsync({
            subject: subject.value,
            programs: [...draftPrograms.value],
            packages: [...draftPackages.value],
            anyField: draftAnyField.value,
        });
    } catch (err) {
        error.value = noticeFrom(err, t(`capabilities.secretPrograms.couldNotSave`));
    }
};

// The list as it stands, in one paragraph for a reader who cannot change it; joined here, where its space cannot be lost.
const readOnly = computed(() => {
    const listed = [...(stored.value?.programs ?? []), ...(stored.value?.packages ?? [])];
    const where =
        listed.length > 0
            ? t(`capabilities.secretPrograms.onlyIntoReadOnly`, { programs: listed.join(`, `) })
            : t(`capabilities.secretPrograms.everyTypingAsksReadOnly`);
    return stored.value?.anyField === true ? `${where} ${t(`capabilities.secretPrograms.anyFieldReadOnly`)}` : where;
});
</script>

<template>
    <div class="pt-3">
        <span class="text-xs text-content">{{ t(`capabilities.secretPrograms.title`) }}</span>

        <!-- Not the owner: the list as it stands, and whose it is to change, rather than controls that would be refused. -->
        <p v-if="!isOwner" class="pt-0.5 text-2xs text-muted">{{ readOnly }}</p>

        <template v-else>
            <p class="pt-0.5 text-2xs text-muted">{{ t(`capabilities.secretPrograms.explain`) }}</p>
            <div v-if="draftPrograms.length + draftPackages.length > 0" class="flex flex-wrap gap-1 pt-1">
                <span
                    v-for="program of draftPrograms"
                    :key="`program:${program}`"
                    :class="ui.chip({ on: true }, `gap-1 py-1 pl-2 pr-1 font-mono text-2xs`)"
                >
                    {{ program }}
                    <button
                        type="button"
                        :class="ui.iconButton({ size: `xs`, tone: `subtle` }, `-my-0.5`)"
                        :aria-label="t(`capabilities.secretPrograms.remove`, { program })"
                        @click="removeProgram(program)"
                    >
                        <Icon name="times" class="text-2xs" />
                    </button>
                </span>
                <span
                    v-for="name of draftPackages"
                    :key="`package:${name}`"
                    :class="ui.chip({ on: true }, `gap-1 py-1 pl-2 pr-1 font-mono text-2xs`)"
                >
                    <Icon name="mobile" class="text-2xs text-subtle" />
                    {{ name }}
                    <button
                        type="button"
                        :class="ui.iconButton({ size: `xs`, tone: `subtle` }, `-my-0.5`)"
                        :aria-label="t(`capabilities.secretPrograms.remove`, { program: name })"
                        @click="removePackage(name)"
                    >
                        <Icon name="times" class="text-2xs" />
                    </button>
                </span>
            </div>
            <p v-else class="pt-1 text-2xs text-subtle">{{ t(`capabilities.secretPrograms.everyTypingAsks`) }}</p>

            <form class="flex flex-wrap items-center gap-2 pt-1.5" data-programs="window" @submit.prevent="addProgram">
                <input
                    v-model="typedProgram"
                    type="text"
                    autocomplete="off"
                    spellcheck="false"
                    :placeholder="t(`capabilities.secretPrograms.programPlaceholder`)"
                    :aria-label="t(`capabilities.secretPrograms.addProgram`)"
                    :class="ui.input({ size: `sm` }, `min-w-40 flex-1 font-mono`)"
                />
                <button type="submit" :class="ui.textButton({ size: `xs` })" :disabled="typedProgram.trim() === ``">
                    {{ t(`capabilities.secretPrograms.addProgram`) }}
                </button>
            </form>
            <form class="flex flex-wrap items-center gap-2 pt-1" data-programs="android" @submit.prevent="addPackage">
                <input
                    v-model="typedPackage"
                    type="text"
                    autocomplete="off"
                    spellcheck="false"
                    :placeholder="t(`capabilities.secretPrograms.packagePlaceholder`)"
                    :aria-label="t(`capabilities.secretPrograms.addPackage`)"
                    :class="ui.input({ size: `sm` }, `min-w-40 flex-1 font-mono`)"
                />
                <button type="submit" :class="ui.textButton({ size: `xs` })" :disabled="typedPackage.trim() === ``">
                    {{ t(`capabilities.secretPrograms.addPackage`) }}
                </button>
            </form>
            <p v-if="typedError" class="pt-1 text-2xs text-warning">{{ typedError }}</p>

            <div class="flex items-center justify-between gap-2 pt-2">
                <span class="flex min-w-0 flex-col">
                    <span class="text-2xs text-content">{{ t(`capabilities.secretPrograms.anyField`) }}</span>
                    <span class="text-2xs text-subtle">{{ t(`capabilities.secretPrograms.anyFieldNote`) }}</span>
                </span>
                <ToggleSwitch v-model="draftAnyField" :aria-label="t(`capabilities.secretPrograms.anyField`)" />
            </div>
            <div class="flex items-center gap-2 pt-2">
                <button type="button" :class="ui.textButton({ size: `xs` })" :disabled="!dirty" v-action="save">
                    {{ t(`ui.action.save`) }}
                </button>
            </div>
        </template>
        <Notice v-if="error" :of="error" class="mt-2" />
    </div>
</template>
