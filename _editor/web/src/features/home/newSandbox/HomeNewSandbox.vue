<!-- THE NEW SANDBOX'S PAGE, in the chat's place on Home while its tile is selected (newSandbox.ts says why the run is
     here and its form is a dialog): the app's install, a machine's steps or a machine of ours starting, then the sandbox's
     first start, after which its home conversation takes the page. Shown only once the press went somewhere; a press
     refused after that (a machine of ours that would not start) is the dialog's again, with the reason. A setup left
     unfinished, being finished, has no dialog to go back to: its page stands from the press, saying why a code was
     refused when one was. The run is the host's (NewSandboxHost.vue), so another tile pressed meanwhile leaves it going. -->
<script setup lang="ts">
import { Button, Notice, Page, SandboxLogo } from "@intentic/ui";
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
const resumed = computed(() => run.value?.resumed.value === true);
const refusal = computed(() => (started.value === undefined ? (run.value?.here.add.error.value ?? null) : null));
const title = computed(() => t(`home.newSandbox.settingUp`, { name: named.value }));
const line = computed(() => (phase.value === `failed` ? t(`home.newSandbox.failedLine`) : t(`home.newSandbox.meanwhile`, { name: named.value })));
const machineFailed = computed(() => started.value?.kind === `machine` && run.value?.here.add.onMachine.run.failure.value !== undefined);
// Pressed again where it can be: a machine that stopped, or a setup left unfinished whose code was refused.
const retried = computed(() => machineFailed.value || (resumed.value && refusal.value !== null));
</script>

<template>
    <section class="flex min-h-0 min-w-0 flex-1 flex-col" :aria-label="title" data-home-new-sandbox>
        <div class="min-h-0 flex-1 overflow-y-auto">
            <Page v-if="run && reading && (started || resumed)">
                <div class="mx-auto flex w-full max-w-lg flex-col gap-6 py-6">
                    <header class="flex items-start gap-4">
                        <SandboxLogo :image="null" :name="named" :size="48" class="shrink-0 rounded-xl" />
                        <div class="flex min-w-0 flex-col gap-1">
                            <h1 class="truncate text-xl font-semibold text-content">{{ title }}</h1>
                            <p class="text-sm text-muted">{{ line }}</p>
                        </div>
                    </header>

                    <!-- THE RUN: what the press started, then its first start; before it, the code being asked for, or why not. -->
                    <AddSandboxRun v-if="started" :here="run.here" :opening="run.opening.value" in-place @shown="run.opened" />
                    <Notice v-else-if="refusal" :of="refusal" />
                    <p v-else class="flex items-center gap-2 text-xs text-muted">
                        <Icon name="spinner" spin class="text-xs" />
                        {{ t(`setup.setup.appSettingUp`) }}
                    </p>
                    <div v-if="phase === `failed`" class="flex flex-wrap items-center gap-2">
                        <Button v-if="retried" :label="t(`ui.action.tryAgain`)" @click="run.retry" />
                        <Button :label="t(`home.newSandbox.dismiss`)" tier="quiet" @click="run.dismiss" />
                    </div>
                </div>
            </Page>
        </div>
    </section>
</template>
