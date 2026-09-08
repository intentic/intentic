<!--
    Nudges the user after inactivity on the run step — the only trigger available, since not running the command is silent. Renders in two places
    (the `xl` reference column, or under the wait line below `xl`); exactly one is visible via `display:none`, per the page's own `variant`.
-->
<script setup lang="ts">
import { CopyButton, Notice } from "@intentic/ui";

// Reader this is addressed to:
//   `emailed` : a phone that mailed itself the link, not yet opened on the other computer
//   `terminal` : the command is on screen and was never pasted anywhere
//   `phone` : a phone with the command still folded away
//   `install` : a browser offered the desktop app, not yet installed or opened
//   `downloaded`: the installer was taken from this page
//   `app` : the desktop app was handed the setup and its own window has the log
//   `button` : in the app, with nothing pressed yet
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
                    <span class="font-medium">Still nothing.</span> Open the link we emailed you on the computer that will host your sandbox. The
                    command is waiting there.
                </span>
                <span v-else-if="variant === `terminal`" class="min-w-0">
                    <span class="font-medium">Still nothing.</span> This has to be pasted into a terminal on the machine that will run your sandbox.
                </span>
                <span v-else-if="variant === `phone`" class="min-w-0">
                    <span class="font-medium">Still nothing.</span> Email yourself the link above and open it on the computer that will host your
                    sandbox.
                </span>
                <span v-else-if="variant === `install`" class="min-w-0">
                    <span class="font-medium">Still nothing.</span> Nothing starts until you install the app above and open it.
                </span>
                <!-- The one variant that is not a correction: this reader did the right thing and is in Windows' half of the flow. -->
                <span v-else-if="variant === `downloaded`" class="min-w-0">
                    <span class="font-medium">Waiting on the installer.</span> Run the file your browser downloaded, then open Intentic and press "Set
                    it up now". This page picks it up on its own, so you can leave it.
                </span>
                <span v-else-if="variant === `app`" class="min-w-0">
                    <span class="font-medium">Still nothing.</span> Check the Intentic window. It shows what the setup is doing, and any error it hit.
                </span>
                <span v-else class="min-w-0">
                    <span class="font-medium">Still nothing.</span> Nothing starts until you press "Set it up now" above.
                </span>
            </p>
            <p v-if="stalled && variant === `terminal`" class="opacity-90">
                Already ran it? Check that terminal: an error there stops the sandbox before it can report in. Safe to run again.
            </p>
            <!-- `cta`: copying again is the way out here. `self-start`, or the column flex stretches it edge to edge. -->
            <CopyButton v-if="copyable" class="self-start" :text="command" label="Copy again" :cta="true" @copied="emit(`copied`)" />
        </span>
    </Notice>
</template>
