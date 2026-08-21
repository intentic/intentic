<!-- THE CORRECTION, WHEN NOTHING HAS HAPPENED FOR A WHILE. The mistake it exists to catch is SILENT: somebody
     who has not understood that the command runs on ANOTHER machine never does anything this page can react
     to, so elapsed time is the only trigger there is.

     It is a component because it renders in two places and must not be written twice. From `xl` the setup page
     puts it in the reference column, directly under "What this does", where it sits beside the command it is
     about; below `xl` there is no second column and it goes back under the wait line on the run card itself.
     Exactly one is visible at a time (the other is display:none), which is the same arrangement SetupRunDetails
     uses and for the same reason: it appeared at the very bottom of a long card, several screenfuls under the
     command it was correcting, which is the one place a correction cannot do its job.

     `variant` is decided by the page, because the page holds the state that decides it: what kind of handoff
     was made, and on what device. Everything here is prose about one of those states. -->
<script setup lang="ts">
import { CopyButton, Notice } from "@intentic/ui";

/* The reader this is addressed to:
 *   `cloud`   : a machine was created and hasn't claimed; the provider's console holds the boot log
 *   `emailed` : a phone that mailed itself the link and hasn't opened it on the other computer
 *   `terminal`: the command is on screen and was, apparently, never pasted anywhere
 *   `phone`   : a phone with the command still folded away, which has not been told anything wrong yet
 *   `install` : a browser offered the desktop app, which hasn't been installed and opened yet
 *   `app`     : the desktop app was handed the setup and its own window has the log
 *   `button`  : in the app, with nothing pressed yet */
const {
    variant,
    cloudName = ``,
    cloudProvider = ``,
    stalled = false,
    command = ``,
    copyable = false,
} = defineProps<{
    variant: "cloud" | "emailed" | "terminal" | "phone" | "install" | "app" | "button";
    cloudName?: string;
    cloudProvider?: string;
    // Past the long fuse: stop assuming the command was never run and start helping the person whose terminal
    // answered back instead. Only the `terminal` reader has a terminal to be told about.
    stalled?: boolean;
    command?: string;
    // Copying again IS the way out for the reader who has the command, and is no kind of help to the one
    // whose clipboard was never the blocked step.
    copyable?: boolean;
}>();

const emit = defineEmits<{ copied: [] }>();
</script>

<template>
    <Notice tone="warning" icon="clock">
        <span class="flex flex-col gap-2">
            <p>
            <span v-if="variant === `cloud`" class="min-w-0">
                <span class="font-medium">Still building.</span> Check {{ cloudName }} in your {{ cloudProvider }} console. Its boot log is
                <code>/var/log/cloud-init-output.log</code>. Deleting the machine there and creating a fresh sandbox here is always safe.
            </span>
            <span v-else-if="variant === `emailed`" class="min-w-0">
                <span class="font-medium">Still nothing.</span> Open the link we emailed you on the computer that will host your sandbox. The command
                is waiting there.
            </span>
            <span v-else-if="variant === `terminal`" class="min-w-0">
                <span class="font-medium">Still nothing.</span> This has to be pasted into a terminal on the machine that will run your sandbox.
            </span>
            <span v-else-if="variant === `phone`" class="min-w-0">
                <span class="font-medium">Still nothing.</span> Email yourself the link above and open it on the computer that will host your sandbox.
            </span>
            <span v-else-if="variant === `install`" class="min-w-0">
                <span class="font-medium">Still nothing.</span> Nothing starts until you install the app above and open it.
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
            <!-- `cta`, because here copying again IS the way out: the quiet chip that suits a copy-beside-content
                 read as the dimmest thing in the loudest box on the card. `self-start`, or the column flex stretches
                 it edge to edge. -->
            <CopyButton v-if="copyable" class="self-start" :text="command" label="Copy again" :cta="true" @copied="emit(`copied`)" />
        </span>
    </Notice>
</template>
