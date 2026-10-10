<script setup lang="ts">
import { Button, Notice, useNow } from "@intentic/ui";
import { computed } from "vue";
import type { DockerStart } from "../desktop";
import { formatDuration } from "@intentic/ui/format";
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
    /** A start is under way. */
    starting: boolean;
    /** When the running start began, in epoch ms. */
    startedAt?: number;
    /** Seconds the start waits for the engine before it gives up (commands.rs `engine_limit_seconds`). */
    limitSeconds?: number;
    /** How the last start ended. Absent before there has been one. */
    report?: DockerStart;
    /** `windows` changes what a refused engine means: a sign-out, rather than a group on this machine. */
    os?: string;
    /** The engine is Intentic's own (engine.ts `onOurEngine`): ic starts it in seconds, and there is no Docker Desktop
     *  window to open, sign in to or quit. */
    ours?: boolean;
}>();
const emit = defineEmits<{ start: []; open: []; install: [] }>();

// Seconds into a start before the card names what usually holds one up: a first start takes a couple of minutes.
const HINT_AFTER_SECONDS = 75;

// The shared clock, followed only while a start runs: the one thing on screen that moves during the wait.
const now = useNow(() => props.starting);

// Held at the limit: the last `docker info` may still be answering after it, and "5:04 of 5:00" reads as broken.
const waited = computed(() =>
    props.startedAt === undefined ? 0 : Math.min(Math.max(0, (now.value - props.startedAt) / 1000), props.limitSeconds ?? Number.POSITIVE_INFINITY),
);
const progress = computed(() =>
    props.limitSeconds === undefined
        ? formatDuration(waited.value)
        : t(`desktop.docker.waitedOf`, { elapsed: formatDuration(waited.value), limit: formatDuration(props.limitSeconds) }),
);
const hinted = computed(() => props.starting && waited.value >= HINT_AFTER_SECONDS);

const outcome = computed(() => props.report?.outcome);
const windows = computed(() => props.os === `windows`);

const heading = computed(() => {
    if (props.ours) {
        return oursHeading();
    }
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
        // Up, and answering every request with an error: a wait would only have run out the clock on it.
        case `broken`:
            return t(`desktop.docker.engineIsBroken`);
        // Nothing has been tried yet: the engine is down and this screen was reached before a start began.
        default:
            return t(`desktop.docker.dockerIsntRunning`);
    }
});

// Intentic's engine, in its own name: what a start of it waits on is WSL, never a window of Docker Desktop's.
const oursHeading = (): string => {
    if (props.starting) {
        return t(`desktop.docker.oursStarting`);
    }
    switch (outcome.value) {
        case `wouldNotStart`:
            return t(`desktop.docker.oursWouldntStart`);
        case `tookTooLong`:
            return t(`desktop.docker.oursTakingLong`);
        case `broken`:
            return t(`desktop.docker.oursBroken`);
        default:
            return t(`desktop.docker.oursIsntRunning`);
    }
};
const oursBody = (): string => {
    if (hinted.value) {
        return t(`desktop.docker.oursSlowStart`);
    }
    if (props.starting) {
        return t(`desktop.docker.oursStartingBody`);
    }
    return outcome.value === `broken` ? t(`desktop.docker.oursRestartComputer`) : t(`desktop.docker.oursCheckAgain`);
};

const body = computed(() => {
    if (props.ours) {
        return oursBody();
    }
    if (hinted.value) {
        return t(`desktop.docker.mayBeAskingYou`);
    }
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
        case `broken`:
            return t(`desktop.docker.quitAndOpenAgain`);
        default:
            return t(`desktop.docker.tryOpeningItYourself`);
    }
});

// Docker's own last words, kept for after the start.
const detail = computed(() => (props.starting ? undefined : props.report?.detail) || undefined);
// Nothing to open where there is nothing installed, and nothing a second window fixes where the engine is
// already up and refusing this account. Linux has no Docker Desktop to promise either: there the engine is a
// system service, and the sentence hands over the one command that starts it.
const canOpen = computed(
    () => !props.ours && (props.os === `windows` || props.os === `macos`) && outcome.value !== `notInstalled` && outcome.value !== `notAllowed`,
);
</script>

<template>
    <!-- Info while it is happening, warning once it has stopped happening: a start under way is not a problem. -->
    <Notice :tone="starting ? `info` : `warning`" icon="box" class="items-start">
        <span class="block font-medium">{{ heading }}</span>
        <span class="mt-0.5 block text-2xs leading-relaxed">{{ body }}</span>
        <span v-if="starting" class="mt-1.5 block font-mono text-2xs text-subtle tabular-nums" role="timer">{{ progress }}</span>
        <!-- Evidence under the sentence, never instead of it: docker's own words are for whoever wants them. -->
        <span v-else-if="detail" class="mt-1.5 block font-mono text-2xs break-words text-subtle">{{ detail }}</span>

        <span v-if="!starting || canOpen" class="mt-2.5 flex flex-wrap items-center gap-2">
            <Button v-if="!starting" size="small" :label="t(`desktop.docker.checkAgain`)" @click="emit(`start`)" />
            <!-- Offered during the wait too: a welcome or sign-in screen in Docker's own window is what usually holds a start up. -->
            <Button
                v-if="canOpen"
                size="small"
                :tier="hinted ? `accent` : `boring`"
                :label="t(`desktop.docker.openDockerDesktop`)"
                @click="emit(`open`)"
            />
            <Button
                v-if="!starting && outcome === `notInstalled`"
                size="small"
                tier="boring"
                :label="t(`desktop.docker.getDockerDesktop`)"
                @click="emit(`install`)"
            />
            <!-- No button signs anybody out of Windows: that ends every other program on the machine as well, and
                 this card has no way of knowing what is open. The sentence above says it; the person decides. -->
        </span>
    </Notice>
</template>
