<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { useExtensions } from "../../../models/extensions/useExtensions";

// The quiet way from the Secrets view's keyring rows to Passwords, the app where the owner's passwords are listed by
// place, the requests this sandbox waits on are, and the computer's vault is one press away. Drawn only while the
// Passwords extension is on: a link to a view that is switched off leads nowhere.

const t = useT();
const { enabled } = useExtensions();
const on = computed(() => enabled.value.some((extension) => extension.id === `intentic.passwords`));
</script>

<template>
    <RouterLink v-if="on" to="/ext/passwords" class="text-2xs text-link hover:underline" data-open-passwords>{{ t(`sandbox.sandboxSecrets.openInPasswords`) }}</RouterLink>
</template>
