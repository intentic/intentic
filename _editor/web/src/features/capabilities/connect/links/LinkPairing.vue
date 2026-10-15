<!-- Pairs this sandbox with another of the reader's: mints the link over there, under their session there, with the terms they choose here, and fills the Linked sandbox form with what it answered. -->
<script setup lang="ts">
import { type NoticeModel, Button, Picker, type PickerOption, RowGroup, RowNote, ui } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import type { LinkTerms } from "@intentic/sandbox-contract";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, ref, watch } from "vue";
import { useSandbox } from "../../../../client/sandbox/useSandbox";
import { DEFAULT_TERMS, type FarPersona, type PairedLink, pairWith, personasAt, preferredSandbox } from "./linkPairing";

const t = useT();

const props = defineProps<{
    /** The sandbox to start on: an agent's ask names it by its name, its card id or its address. */
    prefer?: string;
}>();

const emit = defineEmits<{
    /** What the form is filled with: the card's id, the far address, its token and its name. */
    pick: [paired: PairedLink];
    /** What went wrong over there, on the page's own notice, or null to clear it. */
    notice: [notice: NoticeModel | null];
}>();

const { sandboxes, active, activeSandboxId, daemonUrl } = useSandbox();

// The reader's other sandboxes they may mint a link on: one they operate, with an address to reach it at.
const others = computed(() =>
    sandboxes.value.filter(
        (sandbox) =>
            sandbox.id !== activeSandboxId.value &&
            sandbox.daemonUrl !== null &&
            sandbox.daemonUrl !== `` &&
            (sandbox.role === `owner` || sandbox.role === `maintainer`),
    ),
);
const farOptions = computed<readonly PickerOption<string>[]>(() => others.value.map((sandbox) => ({ value: sandbox.id, label: sandbox.name })));

const farId = ref<string | undefined>();
// The named sandbox chosen up front, once the list holds it; the reader may still pick another.
watch(
    others,
    (candidates) => {
        if (farId.value === undefined) {
            farId.value = preferredSandbox(candidates, props.prefer)?.id;
        }
    },
    { immediate: true },
);
const personas = ref<readonly FarPersona[]>([]);
const loadingPersonas = ref(false);
const NO_PERSONA = ``;
const actsAs = ref<string | undefined>(NO_PERSONA);
const approve = ref(DEFAULT_TERMS.approve);
const turnsPerHour = ref(DEFAULT_TERMS.turnsPerHour);
const pairing = ref(false);
const paired = ref<PairedLink>();

const personaOptions = computed<readonly PickerOption<string>[]>(() => [
    { value: NO_PERSONA, label: t(`capabilities.linkPairing.noPersona`), hint: t(`capabilities.linkPairing.noPersonaHint`) },
    ...personas.value.map((persona) => ({ value: persona.id, label: persona.label ?? persona.id })),
]);

// The far sandbox's personas, read as the reader there; a sandbox that will not say leaves the choice at none.
watch(farId, async (id) => {
    personas.value = [];
    actsAs.value = NO_PERSONA;
    paired.value = undefined;
    if (id === undefined) {
        return;
    }
    loadingPersonas.value = true;
    emit(`notice`, null);
    try {
        personas.value = await personasAt(id);
    } catch (error) {
        emit(`notice`, noticeFrom(error, t(`capabilities.linkPairing.couldntReadPersonas`)));
    } finally {
        loadingPersonas.value = false;
    }
});

const pair = async (): Promise<void> => {
    const far = others.value.find((sandbox) => sandbox.id === farId.value);
    if (far === undefined || far.daemonUrl === null || pairing.value) {
        return;
    }
    pairing.value = true;
    emit(`notice`, null);
    try {
        const terms: LinkTerms = { approve: approve.value, turnsPerHour: turnsPerHour.value };
        if (actsAs.value !== undefined && actsAs.value !== NO_PERSONA) {
            terms.actsAs = actsAs.value;
        }
        paired.value = await pairWith(
            {
                far: { id: far.id, name: far.name, daemonUrl: far.daemonUrl },
                here: { id: activeSandboxId.value, name: active.value?.name ?? t(`capabilities.linkPairing.thisSandbox`), url: daemonUrl.value },
                terms,
            },
            t(`capabilities.linkPairing.tooOld`, { name: far.name }),
        );
        emit(`pick`, paired.value);
    } catch (error) {
        emit(`notice`, noticeFrom(error, t(`capabilities.linkPairing.couldntPair`, { name: far.name })));
    } finally {
        pairing.value = false;
    }
};
</script>

<template>
    <RowGroup :label="t(`capabilities.linkPairing.title`)">
        <RowNote variant="block">
            <div class="flex flex-col gap-3">
                <p class="text-2xs text-subtle">{{ t(`capabilities.linkPairing.explain`) }}</p>
                <p v-if="others.length === 0" class="text-xs text-muted">{{ t(`capabilities.linkPairing.noOthers`) }}</p>
                <form v-else class="flex flex-col gap-3" @submit.prevent="pair">
                    <div class="flex flex-wrap items-center gap-2">
                        <Picker
                            v-model="farId"
                            :options="farOptions"
                            variant="input"
                            :aria-label="t(`capabilities.linkPairing.which`)"
                            :header="t(`capabilities.linkPairing.which`)"
                            :placeholder="t(`capabilities.linkPairing.pickOne`)"
                            class="ui-field-sm w-56"
                        />
                        <Picker
                            v-if="farId !== undefined"
                            v-model="actsAs"
                            :options="personaOptions"
                            :disabled="loadingPersonas"
                            variant="input"
                            :aria-label="t(`capabilities.linkPairing.persona`)"
                            :header="t(`capabilities.linkPairing.persona`)"
                            class="ui-field-sm w-48"
                        />
                    </div>
                    <div v-if="farId !== undefined" class="flex flex-wrap items-center gap-4">
                        <label class="flex items-center gap-2 text-xs text-content">
                            <ToggleSwitch v-model="approve" />
                            {{ t(`capabilities.linkPairing.askFirst`) }}
                        </label>
                        <label class="flex items-center gap-2 text-xs text-content">
                            <input v-model.number="turnsPerHour" type="number" min="1" max="120" :class="ui.input({ size: `sm` }, `w-20`)" />
                            {{ t(`capabilities.linkPairing.turnsAnHour`) }}
                        </label>
                        <Button type="submit" :label="t(`capabilities.linkPairing.pair`)" size="small" :loading="pairing" :disabled="pairing || loadingPersonas">
                            <template #icon><Icon name="link" /></template>
                        </Button>
                    </div>
                    <p v-if="paired" class="text-xs text-success">{{ t(`capabilities.linkPairing.paired`, { name: paired.name }) }}</p>
                </form>
            </div>
        </RowNote>
    </RowGroup>
</template>
