<!-- Which windows and phone apps a secret may be typed into before anybody is asked: read as its answer, changed in a panel hanging off it. -->
<script setup lang="ts">
import { Button, type NoticeModel, ui } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { KEYRING_PACKAGE_RE, KEYRING_PROGRAMS_MAX, KeyringProgramSchema } from "@intentic/sandbox-contract/schemas/keyring";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, ref } from "vue";
import type { SecretRow } from "../../../sandbox/secrets/secretRows";
import { useCredentialGates, useSecretPrograms } from "../../../../models/capabilities/useSecrets";
import SecretFact from "./SecretFact.vue";
import SecretPopover from "./SecretPopover.vue";
import { EDITABLE_VALUE, FIXED_VALUE, VALUE_NOTE, VALUE_TEXT } from "./secretLook";

// The program guard, the host guard's counterpart for typing: a sandbox-held secret typed into a window on one of the
// owner's computers goes unasked only into a program listed here (or a phone app, by package) and, unless it may go into
// any field, only into a password field; anywhere else the person at that computer is asked. Nothing listed: every
// typing asks. A keyring's own entries keep their list on their computer, so their rows never draw this.

const t = useT();

const { row } = defineProps<{ row: SecretRow }>();

// Only the owner widens a list (the daemon's rule); everybody else reads it.
const { isOwner } = useCredentialGates();
const { programsFor, setPrograms } = useSecretPrograms();

const subject = computed(() => row.entry.key);
const stored = computed(() => programsFor(subject.value) ?? row.entry.programs);
const listed = computed(() => [...(stored.value?.programs ?? []), ...(stored.value?.packages ?? [])]);

const said = computed(() => (listed.value.length > 0 ? listed.value.join(`, `) : t(`capabilities.secretPrograms.asksEachTime`)));
const note = computed<string | undefined>(() => {
    if (listed.value.length === 0) {
        return undefined;
    }
    return stored.value?.anyField === true ? t(`capabilities.secretPrograms.anyFieldElsewhereAsks`) : t(`capabilities.secretPrograms.passwordOnlyElsewhereAsks`);
});

const anchor = ref<HTMLElement>();
const open = ref(false);
const draftPrograms = ref<string[]>([]);
const draftPackages = ref<string[]>([]);
const draftAnyField = ref(false);
const typedProgram = ref(``);
const typedPackage = ref(``);
const typedError = ref<string | undefined>(undefined);
const saving = ref(false);
const error = ref<NoticeModel | undefined>(undefined);

const begin = (): void => {
    draftPrograms.value = [...(stored.value?.programs ?? [])];
    draftPackages.value = [...(stored.value?.packages ?? [])];
    draftAnyField.value = stored.value?.anyField ?? false;
    typedProgram.value = ``;
    typedPackage.value = ``;
    typedError.value = undefined;
    error.value = undefined;
    open.value = true;
};

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
const changed = computed(
    () =>
        !sameList(stored.value?.programs ?? [], draftPrograms.value) ||
        !sameList(stored.value?.packages ?? [], draftPackages.value) ||
        (stored.value?.anyField ?? false) !== draftAnyField.value,
);

const save = async (): Promise<void> => {
    // A name still in a box counts as meant: Save adds it rather than dropping what was typed.
    if (typedProgram.value.trim() !== ``) {
        addProgram();
    }
    if (typedPackage.value.trim() !== `` && typedError.value === undefined) {
        addPackage();
    }
    if (typedError.value !== undefined) {
        return;
    }
    if (!changed.value) {
        open.value = false;
        return;
    }
    saving.value = true;
    error.value = undefined;
    try {
        await setPrograms.mutateAsync({
            subject: subject.value,
            programs: [...draftPrograms.value],
            packages: [...draftPackages.value],
            anyField: draftAnyField.value,
        });
        open.value = false;
    } catch (err) {
        error.value = noticeFrom(err, t(`capabilities.secretPrograms.couldNotSave`));
    } finally {
        saving.value = false;
    }
};
</script>

<template>
    <SecretFact :label="t(`capabilities.secretPrograms.label`)">
        <button
            v-if="isOwner"
            ref="anchor"
            type="button"
            :class="EDITABLE_VALUE"
            :aria-label="t(`capabilities.secretPrograms.change`, { now: said })"
            @click="begin"
        >
            <span :class="[VALUE_TEXT, listed.length > 0 ? `[overflow-wrap:anywhere] font-mono` : ``]">{{ said }}</span>
            <span v-if="note" :class="VALUE_NOTE">{{ note }}</span>
        </button>
        <span v-else :class="FIXED_VALUE">
            <span :class="[VALUE_TEXT, listed.length > 0 ? `[overflow-wrap:anywhere] font-mono` : ``]">{{ said }}</span>
            <span v-if="note" :class="VALUE_NOTE">{{ note }}</span>
        </span>

        <SecretPopover
            v-model="open"
            :anchor="anchor"
            :header="t(`capabilities.secretPrograms.label`)"
            :saving="saving"
            :error="error"
            wide
            @save="save"
        >
            <p class="text-xs text-muted">{{ t(`capabilities.secretPrograms.explain`) }}</p>

            <div v-if="draftPrograms.length + draftPackages.length > 0" class="flex flex-wrap gap-1">
                <span v-for="program of draftPrograms" :key="`program:${program}`" :class="ui.chip({ on: true, trail: true }, `font-mono`)">
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
                <!-- A phone app wears the phone: the one mark that tells it from a program whose name has dots in it too. -->
                <span v-for="name of draftPackages" :key="`package:${name}`" :class="ui.chip({ on: true, trail: true }, `font-mono`)">
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
            <p v-else class="text-xs text-subtle">{{ t(`capabilities.secretPrograms.emptyList`) }}</p>

            <form class="flex items-center gap-2" data-programs="window" @submit.prevent="addProgram">
                <input
                    v-model="typedProgram"
                    type="text"
                    autocomplete="off"
                    spellcheck="false"
                    :placeholder="t(`capabilities.secretPrograms.programPlaceholder`)"
                    :aria-label="t(`capabilities.secretPrograms.addProgram`)"
                    :class="ui.input({ size: `sm` }, `min-w-0 flex-1 font-mono`)"
                />
                <Button type="submit" size="small" tier="boring" :label="t(`capabilities.secretPrograms.addProgram`)" :disabled="typedProgram.trim() === ``">
                    <template #icon><Icon name="plus" /></template>
                </Button>
            </form>
            <form class="flex items-center gap-2" data-programs="android" @submit.prevent="addPackage">
                <input
                    v-model="typedPackage"
                    type="text"
                    autocomplete="off"
                    spellcheck="false"
                    :placeholder="t(`capabilities.secretPrograms.packagePlaceholder`)"
                    :aria-label="t(`capabilities.secretPrograms.addPackage`)"
                    :class="ui.input({ size: `sm` }, `min-w-0 flex-1 font-mono`)"
                />
                <Button type="submit" size="small" tier="boring" :label="t(`capabilities.secretPrograms.addPackage`)" :disabled="typedPackage.trim() === ``">
                    <template #icon><Icon name="plus" /></template>
                </Button>
            </form>
            <p v-if="typedError" class="text-xs text-warning">{{ typedError }}</p>

            <label class="flex items-center justify-between gap-3">
                <span class="flex min-w-0 flex-col">
                    <span class="text-sm text-content">{{ t(`capabilities.secretPrograms.anyField`) }}</span>
                    <span class="text-xs text-subtle">{{ t(`capabilities.secretPrograms.anyFieldNote`) }}</span>
                </span>
                <ToggleSwitch v-model="draftAnyField" :aria-label="t(`capabilities.secretPrograms.anyField`)" />
            </label>
        </SecretPopover>
    </SecretFact>
</template>
