<!-- THE NEW SANDBOX'S PAGE, in the chat's place on Home while its tile is selected (newSandbox.ts says why the run is
     here and its form is a dialog): the app's install, a machine's steps or a machine of ours starting, then the sandbox's
     first start, after which its home conversation takes the page. Shown only once the press went somewhere; a press
     refused after that (a machine of ours that would not start) is the dialog's again, with the reason. The run is the
     host's (NewSandboxHost.vue), so another tile pressed meanwhile leaves it going. -->
<script setup lang="ts">
import { Button, Page, SandboxLogo } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import AddSandboxRun from "../../setup/add/AddSandboxRun.vue";
import { newSandbox, readNewSandbox } from "./newSandbox";

const t = useT();
const run = computed(() => newSandbox.value);
const reading = computed(() => readNewSandbox(run.value));
const phase = computed(() => reading.value?.phase);
// Named as the sandbox it will be, as the tile is.
const named = computed(() => (reading.value?.name === `` || reading.value === undefined ? t(`home.newSandbox.title`) : reading.value.name));
const started = computed(() => run.value?.here.add.started.value);
const title = computed(() => t(`home.newSandbox.settingUp`, { name: named.value }));
const line = computed(() => (phase.value === `failed` ? t(`home.newSandbox.failedLine`) : t(`home.newSandbox.meanwhile`, { name: named.value })));
const machineFailed = computed(() => started.value?.kind === `machine` && run.value?.here.add.onMachine.run.failure.value !== undefined);
</script>

<template>
    <section class="flex min-h-0 min-w-0 flex-1 flex-col" :aria-label="title" data-home-new-sandbox>
        <div class="min-h-0 flex-1 overflow-y-auto">
            <Page v-if="run && reading && started">
                <div class="mx-auto flex w-full max-w-lg flex-col gap-6 py-6">
                    <header class="flex items-start gap-4">
                        <SandboxLogo :image="null" :name="named" :size="48" class="shrink-0 rounded-xl" />
                        <div class="flex min-w-0 flex-col gap-1">
                            <h1 class="truncate text-xl font-semibold text-content">{{ title }}</h1>
                            <p class="text-sm text-muted">{{ line }}</p>
                        </div>
                    </header>

                    <!-- THE RUN: what the press started, then its first start. -->
                    <AddSandboxRun :here="run.here" :opening="run.opening.value" in-place @shown="run.opened" />
                    <div v-if="phase === `failed`" class="flex flex-wrap items-center gap-2">
                        <Button v-if="machineFailed" :label="t(`ui.action.tryAgain`)" @click="run.here.add.retry" />
                        <Button :label="t(`home.newSandbox.dismiss`)" tier="quiet" @click="run.dismiss" />
                    </div>
                </div>
            </Page>
        </div>
    </section>
</template>
