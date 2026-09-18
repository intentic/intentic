<script setup lang="ts">
import { Button, Notice } from "@intentic/ui";
import { computed } from "vue";
import type { DockerStart } from "../desktop";
import { useT } from "@intentic/ui/i18n";

// THE ENGINE THIS MACHINE'S SANDBOX RUNS IN, while it is being started and after a start that did not work out.
//
// Docker Desktop does not start itself — its own "start when you sign in" is off by default on every platform
// (scripts.rs carries the reference) — so the morning after a restart this window opens onto a machine with no
// engine. Starting it is this app's job; saying so, and saying what is left for a person to do when it cannot,
// is this card's. Every ending has its own sentence and its own button, because "Docker isn't reachable" with
// nothing to press is where a non-technical owner stops.

const t = useT();

const props = defineProps<{
    /** A start is under way; `line` is where it has got to. */
    starting: boolean;
    /** How the last start ended. Absent before there has been one. */
    report?: DockerStart;
    /** The latest line of the start's own narration — one line, because a card is not a log. */
    line?: string;
    /** `windows` changes what a refused engine means: a sign-out, rather than a group on this machine. */
    os?: string;
}>();
const emit = defineEmits<{ start: []; open: []; install: [] }>();

const outcome = computed(() => props.report?.outcome);
const windows = computed(() => props.os === `windows`);

const heading = computed(() => {
    if (props.starting) {
        return t(`desktop.docker.startingDockerDesktop`);
    }
    switch (outcome.value) {
        case `notInstalled`:
            return t(`desktop.docker.dockerIsntOnThisComputer`);
        case `wouldNotStart`:
            return t(`desktop.docker.dockerWouldntStart`);
        case `notAllowed`:
            return windows.value ? t(`desktop.docker.accountNotAllowedWindows`) : t(`desktop.docker.accountNotAllowed`);
        case `tookTooLong`:
            return t(`desktop.docker.dockerHasntFinishedStarting`);
        // Nothing has been tried yet: the engine is down and this screen was reached before a start began.
        default:
            return t(`desktop.docker.dockerIsntRunning`);
    }
});

const body = computed(() => {
    if (props.starting) {
        return t(`desktop.docker.sandboxRunsInDockerStarting`);
    }
    switch (outcome.value) {
        case `notInstalled`:
            return t(`desktop.docker.nothingToStartUntilInstalled`);
        case `notAllowed`:
            return windows.value ? t(`desktop.docker.signOutAndBackIn`) : t(`desktop.docker.addToDockerGroup`);
        case `tookTooLong`:
            return t(`desktop.docker.mayBeWaitingForYou`);
        default:
            return t(`desktop.docker.tryOpeningItYourself`);
    }
});

// Docker's own last words, kept for after the start: while one is running the narration says something newer.
const detail = computed(() => (props.starting ? undefined : props.report?.detail) || undefined);
// Nothing to open where there is nothing installed, and nothing a second window fixes where the engine is
// already up and refusing this account. Linux has no Docker Desktop to promise either: there the engine is a
// system service, and the sentence hands over the one command that starts it.
const canOpen = computed(
    () => (props.os === `windows` || props.os === `macos`) && outcome.value !== `notInstalled` && outcome.value !== `notAllowed`,
);
</script>

<template>
    <!-- Info while it is happening, warning once it has stopped happening: a start under way is not a problem. -->
    <Notice :tone="starting ? `info` : `warning`" icon="box" class="items-start">
        <span class="block font-medium">{{ heading }}</span>
        <span class="mt-0.5 block text-2xs leading-relaxed">{{ body }}</span>
        <!-- Where the start has got to, replaced as it moves — this is the only thing on screen that is alive. -->
        <span v-if="starting && line" class="mt-1.5 block text-2xs text-subtle">{{ line }}</span>
        <!-- Evidence under the sentence, never instead of it: docker's own words are for whoever wants them. -->
        <span v-else-if="detail" class="mt-1.5 block font-mono text-2xs break-words text-subtle">{{ detail }}</span>

        <span v-if="!starting" class="mt-2.5 flex flex-wrap items-center gap-2">
            <Button size="small" :label="t(`desktop.docker.checkAgain`)" @click="emit(`start`)" />
            <Button v-if="canOpen" size="small" severity="secondary" :label="t(`desktop.docker.openDockerDesktop`)" @click="emit(`open`)" />
            <Button
                v-if="outcome === `notInstalled`"
                size="small"
                severity="secondary"
                :label="t(`desktop.docker.getDockerDesktop`)"
                @click="emit(`install`)"
            />
            <!-- No button signs anybody out of Windows: that ends every other program on the machine as well, and
                 this card has no way of knowing what is open. The sentence above says it; the person decides. -->
        </span>
    </Notice>
</template>
