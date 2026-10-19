<!-- A secret need's own answer: one masked field whose value goes straight to the sandbox's store, never the chat; or,
     where one of the owner's computers has a keyring that answers, to that keyring instead, the sandbox keeping a pointer. -->
<script setup lang="ts">
import type { KeyringShareMode } from "@intentic/sandbox-contract/schemas/keyring";
import type { Need, SecretNeed } from "@intentic/sandbox-contract/schemas/needs";
import { Notice, SegmentedControl, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref, watch } from "vue";
import SecretField from "../../parts/capabilities/SecretField.vue";
import { keyringModeExplained } from "../capabilities/connect/secrets/keyringWords";
import { useKeyrings } from "../capabilities/connect/secrets/useKeyrings";
import ChatDecisionButton from "../../components/ChatDecisionButton.vue";
import { useNotifications } from "../../workbench/notifications/notifications";
import { useNeedAnswer } from "./needAnswer";
import { useNeeds } from "../../models/needs/useNeeds";

const t = useT();

const props = defineProps<{ need: Need; subject: SecretNeed }>();

const needs = useNeeds();
const { say } = useNotifications();
// Held only until the press; cleared whether or not it was taken.
const value = ref(``);
// The need's answer, wherever it is drawn (needAnswer.ts).
const { busy, notice, answer } = useNeedAnswer(() => props.need);

// Where it is kept. Offered only while a computer's keyring answers, since a value sent to a computer that does not is a
// value nobody can take in; and then the computer is the default (2026-10-19, Passwords): a password kept where the
// owner's own vault is, asked for at each use, is the stronger home, and the sandbox stays one press away. Once the
// person picks, a keyring coming or going no longer moves the choice under them.
const { online } = useKeyrings();
const picked = ref<`sandbox` | `computer` | undefined>(undefined);
const where = computed<`sandbox` | `computer`>({
    // A keyring that answers but has no vault yet (`setUp` false) can still be picked, and is no default.
    get: () => (online.value.length === 0 ? `sandbox` : (picked.value ?? (online.value.some((keyring) => keyring.setUp !== false) ? `computer` : `sandbox`))),
    set: (choice) => {
        picked.value = choice;
    },
});
const device = ref<string | undefined>(undefined);
// Asking each time is the default: the strongest of the three, and the one a person can loosen later on that computer.
const mode = ref<KeyringShareMode>(`each-use`);
watch(
    online,
    (keyrings) => {
        if (!keyrings.some((keyring) => keyring.machine === device.value)) {
            device.value = keyrings[0]?.machine;
        }
    },
    { immediate: true },
);
const whereOptions = computed(() => [
    { label: t(`needs.secret.keepInSandbox`), value: `sandbox` as const },
    { label: t(`needs.secret.keepOnComputer`), value: `computer` as const },
]);
const modeOptions = computed(() => [
    { label: t(`needs.secret.modeEachUse`), value: `each-use` as const },
    { label: t(`needs.secret.modeWhileHere`), value: `while-here` as const },
    { label: t(`needs.secret.modeCopy`), value: `copy` as const },
]);
const onComputer = computed(() => where.value === `computer` && device.value !== undefined);
// A locked keyring takes a value in only once it is unlocked: its inbox key is inside the vault.
const lockedThere = computed(() => onComputer.value && online.value.find((keyring) => keyring.machine === device.value)?.locked === true);

const save = async (): Promise<void> => {
    const given = value.value.trim();
    if (given === `` || busy.value) {
        return;
    }
    // Out of the field at the press: the value goes to the store and nowhere else, taken or not.
    value.value = ``;
    const id = props.need.id;
    const machine = device.value;
    const keepOn = onComputer.value && machine !== undefined ? { device: machine, mode: mode.value } : undefined;
    const waits = lockedThere.value;
    const ended = await answer({
        tag: `save`,
        failed: t(`needs.secret.couldNotSave`),
        task: () => needs.provideSecret.mutateAsync({ id, value: given, keepOn }),
    });
    // The card folds once the need is met, so where the value is waiting is said where the reader will still see it.
    if (ended?.state === `done` && keepOn !== undefined && waits) {
        say(t(`needs.secret.waitsForUnlock`, { machine: keepOn.device }));
    }
};

// Stored some other way (the Secrets view, a deploy): the daemon checks the name resolves before it takes the word.
const storedElsewhere = async (): Promise<void> => {
    const id = props.need.id;
    await answer({ tag: `elsewhere`, failed: t(`needs.secret.notStoredYet`), task: () => needs.answer.mutateAsync({ id, answer: { kind: `apply` } }) });
};
</script>

<template>
    <div class="chat-card-body flex flex-col gap-2">
        <span v-if="subject.replace" class="text-xs text-content/85">{{ t(`needs.secret.replace`, { name: subject.name }) }}</span>
        <span v-if="subject.where" class="text-xs text-content/85">{{ t(`needs.secret.where`, { where: subject.where }) }}</span>
        <span v-if="subject.hint" class="text-2xs text-subtle">{{ t(`needs.secret.hint`, { hint: subject.hint }) }}</span>
        <a v-if="subject.link" :href="subject.link" target="_blank" rel="noopener noreferrer" class="inline-flex items-center gap-1 text-2xs text-link">
            <Icon name="external-link" />{{ t(`needs.secret.getOne`) }}
        </a>
        <SecretField v-model="value" :secret-key="subject.name" collect no-hint />

        <!-- Where it is kept, once there is a choice: a keyring on one of the owner's computers answers now. -->
        <div v-if="online.length > 0" class="flex flex-col gap-1.5" data-keep-on>
            <SegmentedControl v-model="where" :options="whereOptions" size="xs" wrap />
            <template v-if="where === `computer`">
                <div v-if="online.length > 1" class="flex flex-wrap gap-1" role="group" :aria-label="t(`needs.secret.whichComputer`)">
                    <button
                        v-for="keyring of online"
                        :key="keyring.machine"
                        type="button"
                        :class="ui.chip({ on: device === keyring.machine }, `gap-1 py-1 px-2 text-2xs`)"
                        :aria-pressed="device === keyring.machine"
                        @click="device = keyring.machine"
                    >
                        <Icon name="desktop" class="text-2xs" />{{ keyring.machine }}
                    </button>
                </div>
                <SegmentedControl v-model="mode" :options="modeOptions" size="xs" wrap />
                <span class="text-2xs text-subtle">{{ keyringModeExplained(mode, device ?? ``) }}</span>
                <span v-if="lockedThere" class="text-2xs text-warning">{{ t(`needs.secret.lockedThere`, { machine: device ?? `` }) }}</span>
            </template>
        </div>

        <span v-if="onComputer" class="text-2xs text-subtle">{{ t(`needs.secret.keptOn`, { name: subject.name, machine: device ?? `` }) }}</span>
        <span v-else class="text-2xs text-subtle">{{ t(`needs.secret.stored`, { name: subject.name }) }}</span>
        <div class="flex flex-wrap items-center gap-2">
            <ChatDecisionButton tone="primary" icon="check" :disabled="busy || value.trim() === ``" @click="save">{{ t(`needs.secret.save`) }}</ChatDecisionButton>
            <ChatDecisionButton tone="secondary" :disabled="busy" @click="storedElsewhere">{{ t(`needs.secret.addedElsewhere`) }}</ChatDecisionButton>
            <slot name="decline" />
        </div>
        <Notice v-if="notice" :of="notice" />
    </div>
</template>
