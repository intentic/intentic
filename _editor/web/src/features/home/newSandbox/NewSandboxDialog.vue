<!-- THE NEW SANDBOX'S DIALOG, over Home while it asks for one and nothing has started yet (newSandbox.ts says why it is a
     dialog): a name, where it runs, Create. The press goes to the host's run (NewSandboxHost.vue), which takes the ask out
     of Home's address once the press went somewhere, and that closes this. A press the platform refused stays here with
     the reason; one still in flight cannot be put away, since what it makes would be left running with no tile. -->
<script setup lang="ts">
import { Button, Modal, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { RouterLink, useRouter } from "vue-router";
import { HOME_PATH } from "../../../lib/routes/firstScreens";
import AddSandboxForm from "../../setup/add/AddSandboxForm.vue";
import type { NewSandboxRun } from "./newSandbox";

const { run } = defineProps<{ run: NewSandboxRun }>();

const t = useT();
const router = useRouter();
const { problem, pick, creating } = run.here.add;
const blocked = computed(() => problem.value !== undefined || pick.value === undefined);

// Put away. Never pressed: back where the press came from (the chat, or a sandbox the reader was in), else Home's chat.
// Pressed and refused: the run is let go, which takes the reader to Home's chat as well.
const close = (): void => {
    if (creating.value) {
        return;
    }
    if (run.pressed.value) {
        run.dismiss();
        return;
    }
    const back = router.options.history.state[`back`];
    if (back !== null && back !== undefined) {
        router.back();
        return;
    }
    void router.replace(HOME_PATH);
};
</script>

<template>
    <Modal
        :open="true"
        size="sm"
        :header="t(`home.newSandbox.title`)"
        :description="t(`setup.addSandbox.description`)"
        :dismissable="!creating"
        data-new-sandbox-dialog
        @update:open="(open: boolean) => open || close()"
    >
        <AddSandboxForm :add="run.here.add" @submit="run.create" />

        <template #footer>
            <div class="flex w-full flex-wrap items-center justify-end gap-2">
                <!-- Every other way (the command, the installer, an own domain) is /setup's, with its picker open; offered only
                     before a press, since a refused one is put away with Cancel rather than left behind as a tile. -->
                <RouterLink v-if="!run.pressed.value" :to="{ path: `/setup`, query: { elsewhere: `1` } }" :class="ui.textButton({ size: `xs` }, `mr-auto`)">{{
                    t(`setup.addSandbox.moreWays`)
                }}</RouterLink>
                <Button :label="t(`ui.action.cancel`)" tier="quiet" :disabled="creating" @click="close" />
                <Button
                    :label="t(`home.newSandbox.create`)"
                    tier="accent"
                    :loading="creating"
                    :disabled="blocked"
                    data-new-sandbox-create
                    @click="run.create"
                />
            </div>
        </template>
    </Modal>
</template>
