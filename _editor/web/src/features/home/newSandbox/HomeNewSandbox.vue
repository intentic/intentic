<!-- THE NEW SANDBOX'S PAGE, in the chat's place on Home while its tile is selected (newSandbox.ts says why it is here and
     not a dialog). First a name and where it runs; from Create, the same page is the run: the app's install, a machine's
     steps or a machine of ours starting, then the sandbox's first start, after which its home conversation takes the page.
     The run is the host's (NewSandboxHost.vue), so another tile pressed meanwhile leaves it going. -->
<script setup lang="ts">
import { Button, Page, SandboxLogo, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { RouterLink, useRouter } from "vue-router";
import { HOME_PATH } from "../../../lib/routes/firstScreens";
import AddSandboxForm from "../../setup/add/AddSandboxForm.vue";
import AddSandboxRun from "../../setup/add/AddSandboxRun.vue";
import { newSandbox, readNewSandbox } from "./newSandbox";

const t = useT();
const router = useRouter();
const run = computed(() => newSandbox.value);
const reading = computed(() => readNewSandbox(run.value));
const phase = computed(() => reading.value?.phase);
// Named as the sandbox it will be, as the tile is, once there is a name to say.
const named = computed(() => (reading.value?.name === `` || reading.value === undefined ? t(`home.newSandbox.title`) : reading.value.name));
const started = computed(() => run.value?.here.add.started.value);
// The form, a draft or one the platform refused, is a sandbox still to make; from the press on it is one being set up.
const title = computed(() => (started.value === undefined ? t(`home.newSandbox.title`) : t(`home.newSandbox.settingUp`, { name: named.value })));
const line = computed((): string => {
    if (started.value === undefined) {
        return t(`setup.addSandbox.description`);
    }
    return phase.value === `failed` ? t(`home.newSandbox.failedLine`) : t(`home.newSandbox.meanwhile`, { name: named.value });
});
const machineFailed = computed(() => started.value?.kind === `machine` && run.value?.here.add.onMachine.run.failure.value !== undefined);

// Called off before Create: back where the press came from (the chat, or a sandbox the reader was in), else Home's chat.
const cancel = (): void => {
    if (router.options.history.state[`back`] !== null && router.options.history.state[`back`] !== undefined) {
        router.back();
        return;
    }
    void router.replace(HOME_PATH);
};

// Esc puts away a form never pressed, unless it was meant for something the form itself closed with it.
const onEscape = (event: KeyboardEvent): void => {
    if (!event.defaultPrevented && phase.value === `draft`) {
        cancel();
    }
};
</script>

<template>
    <section class="flex min-h-0 min-w-0 flex-1 flex-col" :aria-label="title" data-home-new-sandbox @keydown.esc="onEscape">
        <div class="min-h-0 flex-1 overflow-y-auto">
            <Page v-if="run && reading">
                <div class="mx-auto flex w-full max-w-lg flex-col gap-6 py-6">
                    <header class="flex items-start gap-4">
                        <SandboxLogo :image="null" :name="named" :size="48" class="shrink-0 rounded-xl" />
                        <div class="flex min-w-0 flex-col gap-1">
                            <h1 class="truncate text-xl font-semibold text-content">{{ title }}</h1>
                            <p class="text-sm text-muted">{{ line }}</p>
                        </div>
                    </header>

                    <!-- THE FORM: until the press has gone somewhere, and again after one the platform refused. -->
                    <AddSandboxForm v-if="started === undefined" :add="run.here.add" @submit="run.create">
                        <div class="flex flex-wrap items-center gap-2">
                            <Button
                                :label="t(`home.newSandbox.create`)"
                                tier="accent"
                                :loading="run.here.add.creating.value"
                                :disabled="run.here.add.problem.value !== undefined || run.here.add.pick.value === undefined"
                                data-new-sandbox-create
                                @click="run.create"
                            />
                            <Button v-if="phase === `draft`" :label="t(`ui.action.cancel`)" tier="quiet" @click="cancel" />
                            <Button v-else :label="t(`home.newSandbox.dismiss`)" tier="quiet" @click="run.dismiss" />
                            <!-- Every other way (the command, the installer, an own domain) is /setup's, with its picker open. -->
                            <RouterLink :to="{ path: `/setup`, query: { elsewhere: `1` } }" :class="ui.textButton({ size: `xs` }, `ml-auto`)">{{
                                t(`setup.addSandbox.moreWays`)
                            }}</RouterLink>
                        </div>
                    </AddSandboxForm>

                    <!-- THE RUN: what the press started, then its first start. -->
                    <template v-else>
                        <AddSandboxRun :here="run.here" :opening="run.opening.value" in-place @shown="run.opened" />
                        <div v-if="phase === `failed`" class="flex flex-wrap items-center gap-2">
                            <Button v-if="machineFailed" :label="t(`ui.action.tryAgain`)" @click="run.here.add.retry" />
                            <Button :label="t(`home.newSandbox.dismiss`)" tier="quiet" @click="run.dismiss" />
                        </div>
                    </template>
                </div>
            </Page>
        </div>
    </section>
</template>
