<!-- ADD A SANDBOX WHERE THERE IS NO HOME TO DO IT ON: a phone, and a guest's window (models/sandbox/addSandbox.ts says who
     gets this and who gets Home's new sandbox in place). A name, where it runs, one press (useAddSandbox.ts says why it is
     not /setup). Mounted once by the shell, and only while asked for, so the registry watch and the offers it reads live no
     longer than it. Once the new sandbox reports in, the setup row selects it, which re-points the workspace there behind
     the dialog; the dialog stays up through its first start (AddSandboxOpening.vue) and closes onto a workspace ready to
     use. -->
<script setup lang="ts">
import { Button, Modal, useDevice } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, onMounted, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { landOnAfterSwitch } from "../../../models/sandbox/sandboxScreen";
import { masterRail } from "../../../models/home/masterRail";
import AddSandboxForm from "./AddSandboxForm.vue";
import AddSandboxRun from "./AddSandboxRun.vue";
import { useAddSandboxHere } from "./useAddSandboxHere";

const emit = defineEmits<{ close: [] }>();

const t = useT();
const { mobile } = useDevice();
// Set once the new sandbox reported in and was selected: the dialog then waits on its first start, not on its setup.
const opening = ref(false);

const here = useAddSandboxHere({
    appStays: false,
    selects: () => true,
    reportedIn: () => {
        opening.value = true;
    },
});
const { problem, pick, creating, started, created, onMachine } = here.add;
onMounted(() => void here.add.read());
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
                <!-- Every other way (the command, the installer, an own domain) is /setup's, with its picker open. -->
                <RouterLink
                    v-if="started === undefined"
                    :to="{ path: `/setup`, query: { elsewhere: `1` } }"
                    class="mr-auto text-xs text-link hover:underline"
                    @click="emit(`close`)"
                    >{{ t(`setup.addSandbox.moreWays`) }}</RouterLink
                >
                <template v-if="started === undefined">
                    <Button :label="t(`ui.action.cancel`)" tier="quiet" @click="emit(`close`)" />
                    <Button
                        :label="t(`ui.action.create`)"
                        tier="accent"
                        :loading="creating"
                        :disabled="problem !== undefined || pick === undefined"
                        @click="here.add.create"
                    />
                </template>
                <template v-else>
                    <Button v-if="machineFailed" :label="t(`ui.action.tryAgain`)" tier="quiet" @click="here.add.retry" />
                    <Button :label="t(`ui.action.close`)" @click="emit(`close`)" />
                </template>
            </div>
        </template>
    </Modal>
</template>
