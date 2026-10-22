<script setup lang="ts">
import { Button } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { useRouter } from "vue-router";
import { openThisComputer } from "../../app/environments/desktop";
import SetupAccount from "./SetupAccount.vue";

// THE DESKTOP APP'S WORKSPACE FOR AN ACCOUNT WITH NO SANDBOX (router/thisComputerFirst.ts). The reader was put on This
// computer; this is what waits behind it, seen only when they bring the workspace up themselves. It asks nothing and
// makes nothing: This computer, or setup, both one press away.

const t = useT();
const router = useRouter();

const setUp = (): void => {
    void router.push(`/setup`);
};
// Nothing to discard before signing out: this page made nothing.
const nothingToDiscard = async (): Promise<void> => {};
</script>

<template>
    <main class="flex min-h-dvh items-center justify-center bg-canvas px-4 text-content">
        <section class="flex w-full max-w-sm flex-col items-center gap-4 text-center">
            <span class="flex h-12 w-12 items-center justify-center rounded-full bg-content/5 text-muted">
                <Icon name="desktop" class="text-lg" />
            </span>
            <div>
                <h1 class="text-lg font-semibold">{{ t(`setup.noSandbox.headline`) }}</h1>
                <p class="mt-1 text-sm text-muted">{{ t(`setup.noSandbox.lede`) }}</p>
            </div>
            <Button :label="t(`setup.noSandbox.openThisComputer`)" @click="openThisComputer" />
            <div class="flex flex-col items-center gap-2 border-t border-content/10 pt-4">
                <p class="text-xs text-muted">{{ t(`setup.noSandbox.sandboxLater`) }}</p>
                <Button :label="t(`setup.noSandbox.setUpSandbox`)" tier="boring" @click="setUp" />
            </div>
            <SetupAccount :before-sign-out="nothingToDiscard" />
        </section>
    </main>
</template>
