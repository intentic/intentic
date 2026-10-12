<script setup lang="ts">
import { Button, toneWash } from "@intentic/ui";
import { onUnmounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useT } from "@intentic/ui/i18n";
import { usePoll } from "@intentic/ui/async";
import { platformRetry } from "../../client/auth/platformRetry";
import DirectSandboxes from "../sandbox/recovery/DirectSandboxes.vue";
import { normalizeDaemonUrl } from "../../lib/daemonUrl";
import { onScreen } from "../../workbench/window/onScreen";

const t = useT();

const route = useRoute();
const router = useRouter();

// Leaves the screen only on an answer; a retry that still can't reach the platform changes nothing on it.
const retry = async (): Promise<void> => {
    const target = await platformRetry(route.query[`returnTo`]);
    if (target !== undefined) {
        await router.replace(target);
    }
};

// The sandbox an /open link named, carried here in `returnTo` when the platform could not be asked about it; offered
// first among the ones this device remembers.
const returnTo = [route.query[`returnTo`]].flat()[0];
const opened = returnTo === null || returnTo === undefined || !returnTo.startsWith(`/open?`) ? null : new URLSearchParams(returnTo.slice(`/open?`.length)).get(`url`);
const focusUrl = opened === null ? undefined : normalizeDaemonUrl(opened);

// Asks again on its own while the screen is up, so a reader who leaves the tab open lands in the app the moment the
// platform answers, without pressing anything. Only while the window is on screen (onScreen, which also counts a window
// hidden in the tray): a backgrounded outage screen is free.
const RETRY_MS = 5000;
const quietly = (): void => void retry().catch(() => undefined);
// One ask at a time: a slow platform answering late is not asked again on top of itself. Leaving the screen unmounts
// it, which ends the wait.
usePoll({ everyMs: RETRY_MS, immediate: false, visible: onScreen, check: retry }).start();
globalThis.addEventListener(`online`, quietly);
onUnmounted(() => {
    globalThis.removeEventListener(`online`, quietly);
});
</script>

<template>
    <main class="flex min-h-dvh items-center justify-center bg-canvas px-4 text-content">
        <section class="flex w-full max-w-sm flex-col items-center gap-4 text-center">
            <span :class="toneWash(`warning`, `flex h-12 w-12 items-center justify-center rounded-full`)">
                <Icon name="cloud" class="text-lg" />
            </span>
            <div>
                <h1 class="text-lg font-semibold">{{ t(`setup.platformUnavailable.intenticIsntReachable`) }}</h1>
                <p class="mt-1 text-xs text-muted">{{ t(`setup.platformUnavailable.signInNotChanged`) }}</p>
            </div>
            <Button :label="t(`ui.action.tryAgain`)" tier="boring" @click="retry" />
            <!-- What still works: the sandboxes themselves, opened without intentic. -->
            <DirectSandboxes :focus-url="focusUrl" />
        </section>
    </main>
</template>
