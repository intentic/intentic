<script setup lang="ts">
import { Button, Notice, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import type { LocalPcCheck } from "@intentic/web/local-host";
import { computed } from "vue";
import type { OnboardingSetup } from "../../desktop";

// THIS PC COMES FIRST: a setup handed over while this PC still needs Docker and WSL waits for this PC's own setup
// (onboarding.rs, the Agents page's "Set up this PC"), and this is where that setup is started and followed. The setup
// handed over carries on by itself once the PC is ready (setup.ts `pcParked`): nothing here has to be pressed twice.

const t = useT();
const props = defineProps<{ check: LocalPcCheck | undefined; setup: OnboardingSetup | undefined; error: string | undefined }>();
const emit = defineEmits<{ setUp: []; recheck: []; restart: [] }>();

// The one thing to say: this PC's setup as it stands, else what the check found.
const phase = computed(() => {
    const setup = props.setup;
    if (setup?.state === `running` || setup?.state === `failed`) {
        return setup.state;
    }
    if (setup?.state === `waiting`) {
        return setup.for;
    }
    if (props.check === undefined || props.check.state === `checking`) {
        return `checking`;
    }
    return `offer`;
});
const percent = computed(() => (props.setup?.state === `running` ? Math.round(props.setup.percent) : 0));
// Windows' own prompt, when that is what it waits on, said as the Agents page says it.
const step = computed(() => {
    const setup = props.setup;
    if (setup?.state !== `running`) {
        return undefined;
    }
    return setup.needsYou === true ? t(`desktop.onboarding.needsYou`) : setup.step;
});
const reason = computed(() => (props.setup?.state === `failed` ? props.setup.reason : undefined));
</script>

<template>
    <div class="flex flex-col gap-3">
        <p v-if="phase === `checking`" class="flex items-center gap-2.5 text-xs text-subtle">
            <Icon name="spinner" spin class="shrink-0 text-link" />
            <span>{{ t(`desktop.app.pcSetupChecking`) }}</span>
        </p>

        <template v-else-if="phase === `offer`">
            <!-- What pressing it does, before it is pressed: Docker and WSL, Windows' permission, a restart. -->
            <p class="max-w-read-sm text-xs leading-relaxed text-muted">
                {{ t(`desktop.app.pcSetupWhat`) }}
                <template v-if="check?.admin">{{ ` ${t(`desktop.app.pcSetupAdmin`)}` }}</template>
                <template v-if="check?.restart">{{ ` ${t(`desktop.app.pcSetupRestart`)}` }}</template>
            </p>
            <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
                <Button :label="t(`desktop.app.setUpThisPc`)" @click="emit(`setUp`)">
                    <template #icon><Icon name="bolt" /></template>
                </Button>
                <!-- For the reader who installed Docker by hand meanwhile: the check, asked again. -->
                <button type="button" :class="ui.textButton({ tone: `quiet` })" @click="emit(`recheck`)">
                    {{ t(`desktop.app.pcSetupInstalledDocker`) }}
                </button>
            </div>
        </template>

        <div v-else-if="phase === `running`" class="flex items-start gap-2.5 text-xs">
            <Icon name="spinner" spin class="mt-0.5 shrink-0 text-link" />
            <div class="min-w-0 flex-1">
                <p class="text-content">{{ t(`desktop.app.pcSetupRunning`, { percent }) }}</p>
                <p v-if="step" class="mt-0.5 truncate text-muted">{{ step }}</p>
            </div>
        </div>

        <Notice v-else-if="phase === `admin`" tone="warning" class="items-center text-xs">
            <span class="min-w-0 flex-1">{{ t(`desktop.app.pcSetupAdminDeclined`) }}</span>
            <Button class="ml-2 shrink-0" size="small" tier="boring" :label="t(`desktop.app.setUpThisPc`)" @click="emit(`setUp`)" />
        </Notice>

        <Notice v-else-if="phase === `restart`" tone="warning" icon="refresh" class="items-center text-xs">
            <span class="min-w-0 flex-1">{{ t(`desktop.app.pcSetupNeedsRestart`) }}</span>
            <Button class="ml-2 shrink-0" size="small" :label="t(`desktop.requirements.restartNow`)" @click="emit(`restart`)" />
        </Notice>

        <Notice v-else-if="phase === `signOut`" tone="warning" class="text-xs">{{ t(`desktop.app.pcSetupNeedsSignOut`) }}</Notice>

        <Notice v-else-if="phase === `failed`" tone="danger" class="items-start text-xs">
            <span class="block font-medium">{{ t(`desktop.app.pcSetupFailed`) }}</span>
            <span v-if="reason" class="mt-0.5 block font-mono break-words text-subtle">{{ reason }}</span>
            <Button class="mt-2" size="small" tier="boring" :label="t(`ui.action.tryAgain`)" @click="emit(`setUp`)" />
        </Notice>

        <Notice v-if="error" tone="danger" class="text-xs">{{ error }}</Notice>
    </div>
</template>
