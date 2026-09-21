<script setup lang="ts">
import { Button } from "@intentic/ui";
import { onUnmounted } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useT } from "@intentic/ui/i18n";
import { platformRetry } from "../../router/platformRetry";

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

// Asks again on its own while the screen is up, so a reader who leaves the tab open lands in the app the moment the
// platform answers, without pressing anything. Only while the tab is visible: a backgrounded outage screen is free.
const RETRY_MS = 5000;
const quietly = (): void => void retry().catch(() => undefined);
const tick = (): void => {
    if (document.visibilityState === `visible`) {
        quietly();
    }
};
const ticker = setInterval(tick, RETRY_MS);
globalThis.addEventListener(`online`, quietly);
document.addEventListener(`visibilitychange`, tick);
onUnmounted(() => {
    clearInterval(ticker);
    globalThis.removeEventListener(`online`, quietly);
    document.removeEventListener(`visibilitychange`, tick);
});
</script>

<template>
    <main class="flex min-h-dvh items-center justify-center bg-canvas px-4 text-content">
        <section class="flex w-full max-w-sm flex-col items-center gap-4 text-center">
            <span class="flex h-12 w-12 items-center justify-center rounded-full bg-warning/10 text-warning">
                <Icon name="cloud" class="text-lg" />
            </span>
            <div>
                <h1 class="text-lg font-semibold">{{ t(`setup.platformUnavailable.intenticIsntReachable`) }}</h1>
                <p class="mt-1 text-xs text-muted">{{ t(`setup.platformUnavailable.signInNotChanged`) }}</p>
            </div>
            <Button :label="t(`ui.action.tryAgain`)" severity="secondary" @click="retry" />
        </section>
    </main>
</template>
