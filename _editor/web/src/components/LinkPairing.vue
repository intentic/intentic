<!-- Pairs this sandbox with another of the reader's: where both speak s2s/1, a contact holding the terms they choose here as its grants (no link is minted toward such a sandbox, docs/architecture/messages.md "Across versions"); otherwise mints the link over there, under their session there, and fills the Linked sandbox form with what it answered. -->
<script setup lang="ts">
import { type NoticeModel, Button, Picker, type PickerOption, RowGroup, RowNote, ui } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import type { LinkTerms } from "@intentic/sandbox-contract/schemas/links";
import type { S2sContact } from "@intentic/sandbox-contract/schemas/s2s";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, ref, watch } from "vue";
import { useSandbox } from "../client/sandbox/useSandbox";
import { supportsRoute } from "../client/sandbox/useDaemonRoutes";
import { LINK_ASKER_GRANTS, linkContactGrants, pairContact, pairPreferringContact, useContactPairingApi } from "./contactPairing";
import {
    DEFAULT_TERMS,
    type FarRole,
    farSandboxNote,
    type PairedLink,
    pairableSandboxes,
    pairWith,
    rolesAt,
    preferredSandbox,
} from "./linkPairing";

const t = useT();

const props = defineProps<{
    /** The sandbox to start on: an agent's ask names it by its name, its card id or its address. */
    prefer?: string;
}>();

const emit = defineEmits<{
    /** What the form is filled with: the card's id, the far address, its token and its name. */
    pick: [paired: PairedLink];
    /** Paired as a contact instead: no card to fill, the contact is on the Messages tab. */
    contact: [contact: S2sContact];
    /** What went wrong over there, on the page's own notice, or null to clear it. */
    notice: [notice: NoticeModel | null];
}>();

const { sandboxes, active, activeSandboxId, daemonUrl } = useSandbox();

// The reader's other sandboxes they may mint a link on: one they operate, with an address to reach it at.
const others = computed(() => pairableSandboxes(sandboxes.value, activeSandboxId.value));
// Each by its name, with the machine it runs on and whether it answers now (farSandboxNote).
const farOptions = computed<readonly PickerOption<string>[]>(() =>
    others.value.map((sandbox) => ({ value: sandbox.id, label: sandbox.name, description: farSandboxNote(sandbox) })),
);

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
const roles = ref<readonly FarRole[]>([]);
const loadingRoles = ref(false);
const NO_ROLE = ``;
const actsAs = ref<string | undefined>(NO_ROLE);
const approve = ref(DEFAULT_TERMS.approve);
const turnsPerHour = ref(DEFAULT_TERMS.turnsPerHour);
// Whether this sandbox may read the far one's records (its conversations, logs and diagnostics) over the link.
const records = ref(DEFAULT_TERMS.records);
// Whether this sandbox may operate the far one: run commands and read and write files there, as its owner's terminal would.
const operate = ref(DEFAULT_TERMS.operate);
const pairing = ref(false);
const paired = ref<PairedLink>();
// The contact made instead of a link, where both sandboxes speak s2s/1.
const contact = ref<S2sContact>();
const contacts = useContactPairingApi();

const roleOptions = computed<readonly PickerOption<string>[]>(() => [
    { value: NO_ROLE, label: t(`capabilities.linkPairing.noRole`), hint: t(`capabilities.linkPairing.noRoleHint`) },
    ...roles.value.map((role) => ({ value: role.id, label: role.label ?? role.id })),
]);

// The far sandbox's roles, read as the reader there; a sandbox that will not say leaves the choice at none.
watch(farId, async (id) => {
    roles.value = [];
    actsAs.value = NO_ROLE;
    paired.value = undefined;
    contact.value = undefined;
    if (id === undefined) {
        return;
    }
    loadingRoles.value = true;
    emit(`notice`, null);
    try {
        roles.value = await rolesAt(id);
    } catch (error) {
        emit(`notice`, noticeFrom(error, t(`capabilities.linkPairing.couldntReadRoles`)));
    } finally {
        loadingRoles.value = false;
    }
});

const pair = async (): Promise<void> => {
    const far = others.value.find((sandbox) => sandbox.id === farId.value);
    if (far === undefined || pairing.value) {
        return;
    }
    pairing.value = true;
    emit(`notice`, null);
    try {
        const terms: LinkTerms = {
            approve: approve.value,
            turnsPerHour: turnsPerHour.value,
            tasks: true,
            records: records.value,
            operate: operate.value,
        };
        if (actsAs.value !== undefined && actsAs.value !== NO_ROLE) {
            terms.actsAs = actsAs.value;
        }
        const tooOld = t(`capabilities.linkPairing.tooOld`, { name: far.name });
        const made = await pairPreferringContact(
            supportsRoute(`POST /s2s/contacts/paired`),
            () =>
                pairContact(
                    contacts,
                    { far: { id: far.id, name: far.name }, scope: `sandbox`, here: LINK_ASKER_GRANTS, there: linkContactGrants(terms) },
                    true,
                    { tooOld },
                ),
            () =>
                pairWith(
                    {
                        far: { id: far.id, name: far.name, daemonUrl: far.daemonUrl },
                        here: { id: activeSandboxId.value, name: active.value?.name ?? t(`capabilities.linkPairing.thisSandbox`), url: daemonUrl.value },
                        terms,
                    },
                    tooOld,
                ),
        );
        if (made.kind === `contact`) {
            contact.value = made.contact;
            emit(`contact`, made.contact);
        } else {
            paired.value = made.value;
            emit(`pick`, made.value);
        }
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
                <!-- Stopped here: on the Capabilities page this sits inside the card's own form, and a submit bubbles, so one
                     press of Link also pressed that form's Add with nothing in it yet (refused, its fold flung open in red). -->
                <form v-else class="flex flex-col gap-3" @submit.prevent.stop="pair">
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
                            :options="roleOptions"
                            :disabled="loadingRoles"
                            variant="input"
                            :aria-label="t(`capabilities.linkPairing.role`)"
                            :header="t(`capabilities.linkPairing.role`)"
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
                    </div>
                    <!-- Not task terms: what this sandbox may read and do over there without asking for a turn, each said in full under its switch. -->
                    <div v-if="farId !== undefined" class="flex flex-wrap items-end gap-4">
                        <div class="flex min-w-60 flex-1 flex-col gap-2">
                            <label class="flex flex-col gap-0.5">
                                <span class="flex items-center gap-2 text-xs text-content">
                                    <ToggleSwitch v-model="records" />
                                    {{ t(`capabilities.linkPairing.shareRecords`) }}
                                </span>
                                <span class="text-2xs text-subtle">{{ t(`capabilities.linkPairing.shareRecordsHint`) }}</span>
                            </label>
                            <label class="flex flex-col gap-0.5">
                                <span class="flex items-center gap-2 text-xs text-content">
                                    <ToggleSwitch v-model="operate" />
                                    {{ t(`capabilities.linkPairing.operate`) }}
                                </span>
                                <span class="text-2xs text-subtle">{{ t(`capabilities.linkPairing.operateHint`) }}</span>
                            </label>
                        </div>
                        <Button tier="accent" type="submit" :label="t(`capabilities.linkPairing.pair`)" size="small" :loading="pairing" :disabled="pairing || loadingRoles">
                            <template #icon><Icon name="link" /></template>
                        </Button>
                    </div>
                    <p v-if="paired" class="text-xs text-success">{{ t(`capabilities.linkPairing.paired`, { name: paired.name }) }}</p>
                    <p v-if="contact" class="text-xs text-success" data-paired-contact>{{ t(`capabilities.linkPairing.pairedContact`, { name: contact.name }) }}</p>
                </form>
            </div>
        </RowNote>
    </RowGroup>
</template>
