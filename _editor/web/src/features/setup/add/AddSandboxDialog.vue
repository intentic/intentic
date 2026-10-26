<!-- ADD A SANDBOX WHERE THERE IS NO HOME TO DO IT ON: a phone, and a guest's window (models/sandbox/addSandbox.ts says who
     gets this and who gets Home's new sandbox in place). A name, where it runs (its "More ways" included), one press
     (useAddSandbox.ts). Mounted once by the shell, and only while asked for, so the registry watch and the offers it reads
     live no longer than it. Home's address asking for it keeps what it named once the shell took its ask: a row to finish
     (`finish=<id>`), a machine of ours (`machine=hosted`, `tier=`); it is taken from the address here, as the press. Once the new sandbox reports in, the setup row selects it, which re-points the workspace there behind
     the dialog; the dialog stays up through its first start (AddSandboxOpening.vue) and closes onto a workspace ready to
     use. -->
<script setup lang="ts">
import { isHostedTierId } from "@intentic/constants";
import { Button, Modal, useDevice } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { unfinishedSandboxes } from "../../../models/sandbox/live/roster";
import { landOnAfterSwitch } from "../../../models/sandbox/sandboxScreen";
import { masterRail } from "../../../models/home/masterRail";
import AddSandboxForm from "./AddSandboxForm.vue";
import AddSandboxRun from "./AddSandboxRun.vue";
import { ATTACH, HOSTED } from "./useAddSandbox";
import { useAddSandboxHere } from "./useAddSandboxHere";

const emit = defineEmits<{ close: [] }>();

const t = useT();
const { mobile } = useDevice();
// Set once the new sandbox reported in and was selected: the dialog then waits on its first start, not on its setup.
const opening = ref(false);

const route = useRoute();
const router = useRouter();
const { sandboxes } = useSandbox();
const asked = { finish: route.query[`finish`], machine: route.query[`machine`], tier: route.query[`tier`] };
const here = useAddSandboxHere({
    appStays: false,
    tier: isHostedTierId(asked.tier) ? asked.tier : undefined,
    selects: () => true,
    reportedIn: () => {
        opening.value = true;
    },
});
const { blocked, pick, busy, started, created, onMachine } = here.add;
if (asked.machine === `hosted`) {
    pick.value = HOSTED;
}
onMounted(async () => {
    // What the address named is taken from it, so a reload asks nothing again.
    if (asked.finish !== undefined || asked.machine !== undefined || asked.tier !== undefined) {
        const { finish: _finish, machine: _machine, tier: _tier, ...rest } = route.query;
        void router.replace({ query: rest });
    }
    await here.add.read();
    const row = unfinishedSandboxes(sandboxes.value).find((entry) => entry.id === asked.finish);
    if (row !== undefined) {
        await here.add.resume(row);
    }
});
// Added from inside a sandbox, the new one opens on the full-screen chat, where its first session starts, rather than on
// the shell's default (the file tree with the chat docked). Recorded the moment the row exists: the switch lands on it
// once the row is selected. A phone keeps its own landing, a conversation already.
watch(
    () => created.value?.id,
    (id) => {
        if (id !== undefined && !mobile.value && !masterRail.value) {
            landOnAfterSwitch(id, `/chat`);
        }
    },
);

const machineFailed = computed(() => started.value?.kind === `machine` && onMachine.run.failure.value !== undefined);
</script>

<template>
    <Modal
        :open="true"
        size="sm"
        :header="t(`setup.addSandbox.title`)"
        :description="started === undefined ? t(`setup.addSandbox.description`) : undefined"
        @update:open="(open: boolean) => open || emit(`close`)"
    >
        <!-- THE FORM: until the press has gone somewhere. -->
        <AddSandboxForm v-if="started === undefined" :add="here.add" @submit="here.add.create" />
        <!-- THE RUN: what the press started. -->
        <template v-else>
            <AddSandboxRun :here="here" :opening="opening" @shown="emit(`close`)" />
            <p v-if="!opening" class="mt-3 text-2xs text-muted">{{ t(`setup.addSandbox.keepsGoing`, { name: created?.name ?? `` }) }}</p>
        </template>

        <template #footer>
            <div class="flex w-full flex-wrap items-center justify-end gap-2">
                <template v-if="started === undefined">
                    <Button :label="t(`ui.action.cancel`)" tier="quiet" @click="emit(`close`)" />
                    <Button
                        :label="pick === ATTACH ? t(`ui.action.connect`) : t(`ui.action.create`)"
                        tier="accent"
                        :loading="busy"
                        :disabled="blocked"
                        @click="here.add.create"
                    />
                </template>
                <template v-else>
                    <Button v-if="machineFailed" :label="t(`ui.action.tryAgain`)" tier="accent" @click="here.add.retry" />
                    <Button :tier="machineFailed ? `quiet` : `accent`" :label="t(`ui.action.close`)" @click="emit(`close`)" />
                </template>
            </div>
        </template>
    </Modal>
</template>
