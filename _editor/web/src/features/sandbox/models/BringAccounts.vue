<!-- Sandbox ▸ Models' "From your other sandboxes": the owner's other sandboxes, each read without being asked, one section apiece. Accounts come only over a link, so a sandbox not linked here says what it holds in one line and offers Link first; a linked one lists its accounts one row per provider, each brought in the way that is safe for it, without signing in again. A side door, not the page's way in: one quiet button on the intro line, the list in a dialog behind it. -->
<script setup lang="ts">
import type { NativeProvider } from "@intentic/sandbox-contract/models/provider-specs";
import { Button, Icon, Modal, RowGroup, RowNote, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import SandboxOutdatedNotice from "../../../parts/sandbox/SandboxOutdatedNotice.vue";
import OtherSandboxSection from "./OtherSandboxSection.vue";
import { broughtIn } from "./shareAccounts";
import { useBringOther, useOtherAccounts } from "./useOtherAccounts";

const t = useT();

const { busy = false } = defineProps<{
    // A sign-in is on its way to the sandbox: no second one from here until it answers.
    busy?: boolean;
}>();
// Signing in here instead is the page's one sign-in (SandboxModels.vue `connect`), not a door of this section's own.
const emit = defineEmits<{ signIn: [provider: NativeProvider] }>();
const open = ref(false);
// Signing in happens on the page's own tile panel, so the dialog steps aside for it.
const signInHere = (provider: NativeProvider): void => {
    open.value = false;
    emit(`signIn`, provider);
};

const { relevant, canBorrowHere, offline, reading, rows, sections: all, missed, outcomes, refresh } = useOtherAccounts();
const { link, bring, bringing, notice, tag, dismiss } = useBringOther();

// A section for every sandbox that answered with something this one lacks; one with nothing to offer is no section.
const sections = computed(() => all.value.filter((section) => section.read.state === `read` && section.rows.length > 0));
// Link lights up while it is the one way forward; beside a second sandbox waiting on it, each is one tool of two.
const linkTier = computed(() => (sections.value.filter((section) => section.link.state !== `linked`).length > 1 ? `boring` : `accent`));
const names = (sandboxes: readonly { readonly name: string }[]): string => sandboxes.map((sandbox) => sandbox.name).join(`, `);
const unreachable = computed(() => names(missed.value.unreachable));
const tooOld = computed(() => names(missed.value.tooOld));
const stopped = computed(() => names(offline.value));
// Every sandbox answered, and none holds anything this one lacks: said once, so the dialog never just stands empty.
const allHere = computed(() => !reading.value && sections.value.length === 0 && unreachable.value === `` && tooOld.value === ``);

// The door shows once there is something behind it: an account listed (what a press this visit did to one stays listed,
// so the dialog keeps its results), or this sandbox needing an update to bring any. A failed read or a stopped sandbox
// alone is no reason to put a button on the page; it is said inside, beside the accounts it hides.
const shown = computed(() => relevant.value && (!canBorrowHere.value || rows.value.length > 0));
// What waits to be brought, named on the door; the door names only the place once nothing more can come.
const waiting = computed(() => rows.value.filter((row) => row.account.mode !== `no` && !broughtIn(outcomes.value.get(row.key))).length);
const doorLabel = computed(() =>
    waiting.value > 0 ? t(`connect.shareAccounts.open`, { count: waiting.value }, waiting.value) : t(`connect.shareAccounts.openNone`),
);
</script>

<template>
    <template v-if="shown">
        <Button tier="quiet" size="small" :label="doorLabel" aria-haspopup="dialog" :aria-expanded="open" @click="open = true">
            <template #icon><Icon name="download" /></template>
        </Button>
        <Modal v-model:open="open" size="md" :header="t(`connect.shareAccounts.title`)" :description="canBorrowHere ? t(`connect.shareAccounts.explain`) : undefined">
            <!-- This sandbox is too old to bring anything in: said, with how to update, rather than an empty box. -->
            <SandboxOutdatedNotice v-if="!canBorrowHere" :missing="t(`connect.shareAccounts.outdatedHere`)" />

            <div v-else class="flex flex-col gap-5">
                <OtherSandboxSection
                    v-for="section in sections"
                    :key="section.source.id"
                    :section
                    :outcomes
                    :bringing
                    :failure="notice"
                    :failure-tag="tag"
                    :busy
                    :link-tier="linkTier"
                    @link="link(section.source)"
                    @bring="(picked, pressed) => bring(picked, pressed)"
                    @sign-in="signInHere"
                    @dismiss="dismiss()"
                />

                <!-- What the sections cannot say: still reading, nothing left to bring, and the sandboxes it could not see
                     into, each said once with what would let it, so nothing is missing unexplained. -->
                <RowGroup v-if="(reading && sections.length === 0) || allHere || unreachable || tooOld || stopped">
                    <RowNote v-if="reading && sections.length === 0" variant="note">{{ t(`connect.shareAccounts.looking`) }}</RowNote>
                    <RowNote v-else-if="allHere" variant="note" icon="check">{{ t(`connect.shareAccounts.allHere`) }}</RowNote>
                    <RowNote v-if="unreachable" variant="note" icon="exclamation-triangle" tone="warning">
                        <span>{{ t(`connect.shareAccounts.unreachable`, { names: unreachable }) }}</span>
                        <button type="button" :class="ui.textButton(`ml-2`)" @click="refresh(true)">{{ t(`ui.action.retry`) }}</button>
                    </RowNote>
                    <RowNote v-if="tooOld" variant="note" icon="info-circle">{{ t(`connect.shareAccounts.tooOldThere`, { names: tooOld }) }}</RowNote>
                    <RowNote v-if="stopped" variant="note" icon="info-circle">{{ t(`connect.shareAccounts.notRunning`, { names: stopped }) }}</RowNote>
                </RowGroup>
            </div>
        </Modal>
    </template>
</template>
