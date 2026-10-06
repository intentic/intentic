<script setup lang="ts">
import { Button, Code, type CommandOs, commandLang, osOptions, SegmentedControl, useDevice, useOsPreference } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { desktopFixLink, desktopVersion, openDesktopLink } from "../../../app/environments/desktop";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { useServingSlug } from "../environment/servingSlug";
import { phoneBrowser } from "../../../client/endpoint/endpoint";
import { fixCommand, useFixCode } from "./fixCommand";

// THE ONE COMMAND, as the recovery panel offers it: where to run it, what it will do, and the command itself in the
// shell of the machine it is for. In the desktop app it is a button instead, since the app can run it on this computer
// with nothing to paste. On a phone, which can run neither, it folds away for whoever will type it at the machine.

const props = defineProps<{
    // The machine the sandbox runs on, as it names itself; undefined when it never reported.
    readonly machine: string | undefined;
}>();

const t = useT();
const { active, activeSandboxId } = useSandbox();
const slug = useServingSlug();

// Minted only while this is on screen and only for the owner of a sandbox on their own machine: the code lets that
// machine's run report back here.
const wanted = computed(() => active.value?.role === `owner` && active.value.hosted === null);
const code = useFixCode(activeSandboxId, wanted);

// The machine's own OS when it reported one; the shared preference otherwise, and whatever the reader picks after.
const { cmdOs } = useOsPreference();
const reported = computed<CommandOs | undefined>(() => {
    const os = active.value?.hostReport?.os;
    return os === undefined ? undefined : os === `windows` ? `windows` : `unix`;
});
const picked = ref<CommandOs | undefined>(undefined);
const os = computed<CommandOs>({
    get: () => picked.value ?? reported.value ?? cmdOs.value,
    set: (value) => {
        picked.value = value;
        cmdOs.value = value;
    },
});
const command = computed(() => fixCommand(code.value, os.value));

const desktop = desktopVersion() !== undefined;
const { mobile } = useDevice();
const remote = computed(() => mobile.value || phoneBrowser(navigator.userAgent));
const where = computed(() =>
    props.machine === undefined ? t(`sandbox.diagnosis.fixWhereUnknown`) : t(`sandbox.diagnosis.fixWhere`, { machine: props.machine }),
);
</script>

<template>
    <div class="flex min-w-0 flex-col gap-2">
        <p class="text-xs text-muted">{{ where }} {{ t(`sandbox.diagnosis.fixWhat`) }}</p>
        <div v-if="desktop && slug" class="flex flex-wrap items-center gap-2">
            <Button size="small" :label="t(`sandbox.diagnosis.fixInApp`)" @click="openDesktopLink(desktopFixLink(slug, code))">
                <template #icon><Icon name="wrench" /></template>
            </Button>
            <span class="text-xs text-subtle">{{ t(`sandbox.diagnosis.fixInAppNote`) }}</span>
        </div>
        <component :is="remote ? `details` : `div`" class="min-w-0">
            <summary v-if="remote" class="cursor-pointer text-xs text-link">{{ t(`sandbox.diagnosis.showCommand`) }}</summary>
            <div class="flex min-w-0 flex-col gap-2" :class="{ 'mt-2': remote }">
                <SegmentedControl v-model="os" size="sm" class="self-start" :options="osOptions()" />
                <Code :code="command" :lang="commandLang(os)" :label="t(`sandbox.diagnosis.fixCommandLabel`)" :wrap="true" />
            </div>
        </component>
    </div>
</template>
