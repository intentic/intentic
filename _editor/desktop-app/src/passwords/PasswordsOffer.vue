<script setup lang="ts">
import { Button } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { useRouter } from "vue-router";
import { passwordsOffered } from "./passwordsState";

// PASSWORDS' WAY IN, while this computer has not set it up (2026-10-19): Passwords keeps no rail tile until then, so a
// new owner meets an agent workspace rather than a password manager, and this one quiet line on This device is where it
// is found. It opens the Passwords view, whose first run does the setup; once set up, the rail's tile takes over.

const t = useT();
const router = useRouter();
</script>

<template>
    <section v-if="passwordsOffered" class="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-xl bg-card p-4 shadow-sm" data-passwords-offer>
        <div class="flex min-w-0 flex-1 items-start gap-2.5">
            <Icon name="key" class="mt-0.5 shrink-0 text-subtle" />
            <div class="min-w-0">
                <h2 class="text-sm leading-tight font-semibold">{{ t(`desktop.passwords.title`) }}</h2>
                <p class="mt-1 max-w-read-sm text-xs leading-relaxed text-muted">{{ t(`desktop.passwords.offerLead`) }}</p>
            </div>
        </div>
        <Button size="small" tier="boring" class="shrink-0" :label="t(`desktop.passwords.offerOpen`)" @click="void router.push(`/passwords`)" />
    </section>
</template>
