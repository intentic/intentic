<script setup lang="ts">
import Button from "primevue/button";
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";

const route = useRoute();
const router = useRouter();
const returnTo = computed(() => (typeof route.query[`returnTo`] === `string` ? route.query[`returnTo`] : `/`));
</script>

<template>
    <main class="flex min-h-dvh items-center justify-center bg-canvas px-4 text-content">
        <section class="flex w-full max-w-sm flex-col items-center gap-4 text-center">
            <span class="flex h-12 w-12 items-center justify-center rounded-full bg-warning/10 text-warning">
                <Icon name="cloud" class="text-lg" />
            </span>
            <div>
                <h1 class="text-lg font-semibold">Intentic isn't reachable</h1>
                <p class="mt-1 text-xs text-muted">Your sign-in has not been changed. Check your connection and try again.</p>
            </div>
            <Button label="Try again" severity="secondary" @click="void router.replace(returnTo)" />
        </section>
    </main>
</template>
