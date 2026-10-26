<!-- Where the browser's handoff lands, inside the app: the same entry material, at the size of a two-second wait. -->
<script setup lang="ts">
import { AppBrand, Button, Notice, type NoticeModel } from "@intentic/ui";
import { onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { tellSignedInOnThisComputer } from "../../app/environments/desktop";
import { useT } from "@intentic/ui/i18n";
import { takeBrowserHandoffDestination } from "./browserHandoff";
import { readDesktopHandoff, redeemDesktopHandoff } from "./redeemHandoff";

// The hand-off's landing in a workspace page that had nothing on screen yet: a sign-in begun on This computer before the
// workspace was ever opened, which the app loads out of sight to redeem it (auth.rs), so the reader stays on This
// computer. A page already showing a view takes it there instead, in the sign-in dialog (signInDialog.ts
// `arriveInPlace`); the redemption is the same (redeemHandoff.ts). Done, the page tells the app (a folder waiting on the
// account carries on) and goes to its own first screen, Home, where it waits until the reader opens it.
// This link cannot be retried after failure: sign in again rather than reload.

const t = useT();

const route = useRoute();
const router = useRouter();

const error = ref<NoticeModel | undefined>(undefined);

const complete = async (): Promise<void> => {
    const taken = readDesktopHandoff(route.query);
    error.value = await redeemDesktopHandoff(taken);
    if (error.value !== undefined || taken === undefined) {
        return;
    }
    const destination = takeBrowserHandoffDestination();
    if (taken.backToFolder) {
        tellSignedInOnThisComputer();
    }
    await router.replace(taken.backToFolder ? `/` : destination);
};

onMounted(() => void complete());
</script>

<template>
    <div class="entry arrival">
        <div class="entry-plate" aria-hidden="true"><div class="entry-plate-img"></div></div>

        <main class="shell">
            <header class="mark"><AppBrand /></header>

            <!-- No frame and no rail while it works: nothing is being asked, so there is nothing to put a frame round. -->
            <template v-if="error === undefined">
                <div class="entry-seal entry-seal-turning" aria-hidden="true">
                    <span class="entry-seal-ring"></span>
                    <span class="entry-seal-sweep"></span>
                    <AppBrand shape="mark" class="entry-seal-mark" />
                </div>
                <p class="say" role="status">{{ t(`auth.desktopAuthComplete.signingIn`) }}</p>
            </template>

            <!-- A failure is terminal for this link, so the frame comes up around the one thing left to do. -->
            <section v-else class="entry-frame gate">
                <span class="entry-corner entry-corner-tl"></span>
                <span class="entry-corner entry-corner-tr"></span>
                <span class="entry-corner entry-corner-bl"></span>
                <span class="entry-corner entry-corner-br"></span>
                <Notice :of="error" class="rounded-none text-left" />
                <Button
                    :label="t(`auth.desktopAuthComplete.backToSignIn`)"
                    tier="boring"
                    class="mt-4 self-center"
                    @click="void router.replace(`/login`)"
                />
            </section>
        </main>
    </div>
</template>

<style scoped>
/* Layout only; the plate, metals and seal are shared material in styles/entry.css. */
.arrival {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: clamp(1rem, 2.5vw, 2rem) 1.5rem;
}
.shell {
    display: flex;
    flex-direction: column;
    align-items: center;
    width: 100%;
    max-width: 30rem;
    margin: auto;
    text-align: center;
}
.mark {
    font-size: 1.375rem;
    margin-bottom: clamp(1.5rem, 5vh, 2.75rem);
}
.say {
    font-size: 0.9375rem;
    color: var(--ink-muted);
}
.gate {
    display: flex;
    flex-direction: column;
    width: 100%;
    padding: 1.75rem 1.75rem 1.5rem;
}
</style>
