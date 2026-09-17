<!-- Nudges the user after inactivity on the run step — the only trigger available, since not running the command is silent. -->
<script setup lang="ts">
import { CopyButton, Notice } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";

// Reader this is addressed to:
//   `emailed` : a phone that mailed itself the link, not yet opened on the other computer
//   `terminal` : the command is on screen and was never pasted anywhere
//   `phone` : a phone with the command still folded away
//   `install` : a browser offered the desktop app, not yet installed or opened
//   `downloaded`: the installer was taken from this page
//   `app` : the desktop app was handed the setup and its own window has the log
//   `button` : in the app, with nothing pressed yet
const t = useT();

const {
    variant,
    stalled = false,
    command = ``,
    copyable = false,
} = defineProps<{
    variant: "emailed" | "terminal" | "phone" | "install" | "downloaded" | "app" | "button";
    // Only the `terminal` reader has a terminal to be told about; other variants ignore this.
    stalled?: boolean;
    command?: string;
    // Copying again is the way out only for the reader who has the command.
    copyable?: boolean;
}>();

const emit = defineEmits<{ copied: [] }>();
</script>

<template>
    <Notice tone="warning" icon="clock">
        <span class="flex flex-col gap-2">
            <p>
                <span v-if="variant === `emailed`" class="min-w-0">
                    <span class="font-medium">{{ t(`setup.setupNudge.stillNothing`) }}</span> {{ t(`setup.setupNudge.openLinkWeEmailed`) }}
                </span>
                <span v-else-if="variant === `terminal`" class="min-w-0">
                    <span class="font-medium">{{ t(`setup.setupNudge.stillNothing`) }}</span> {{ t(`setup.setupNudge.toPastedIntoTerminal`) }}
                </span>
                <span v-else-if="variant === `phone`" class="min-w-0">
                    <span class="font-medium">{{ t(`setup.setupNudge.stillNothing`) }}</span> {{ t(`setup.setupNudge.emailYourselfLinkAbove`) }}
                </span>
                <span v-else-if="variant === `install`" class="min-w-0">
                    <span class="font-medium">{{ t(`setup.setupNudge.stillNothing`) }}</span> {{ t(`setup.setupNudge.nothingStartsUntilInstall`) }}
                </span>
                <!-- The one variant that is not a correction: this reader did the right thing and is in Windows' half of the flow. -->
                <span v-else-if="variant === `downloaded`" class="min-w-0">
                    <span class="font-medium">{{ t(`setup.setupNudge.waitingOnInstaller`) }}</span>
                    {{ t(`setup.setupNudge.runFileBrowserDownloaded`) }}
                </span>
                <span v-else-if="variant === `app`" class="min-w-0">
                    <span class="font-medium">{{ t(`setup.setupNudge.stillNothing`) }}</span> {{ t(`setup.setupNudge.checkIntenticWindowShows`) }}
                </span>
                <span v-else class="min-w-0">
                    <span class="font-medium">{{ t(`setup.setupNudge.stillNothing`) }}</span> {{ t(`setup.setupNudge.nothingStartsUntilPress`) }}
                </span>
            </p>
            <p v-if="stalled && variant === `terminal`" class="opacity-90">
                {{ t(`setup.setupNudge.alreadyRanCheckTerminal`) }}
            </p>
            <!-- `cta`: copying again is the way out here. `self-start`, or the column flex stretches it edge to edge. -->
            <CopyButton
                v-if="copyable"
                class="self-start"
                :text="command"
                :label="t(`setup.setupNudge.copyAgain`)"
                :cta="true"
                @copied="emit(`copied`)"
            />
        </span>
    </Notice>
</template>
