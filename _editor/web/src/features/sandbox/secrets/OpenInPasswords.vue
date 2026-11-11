<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { passwordsLink } from "../../capabilities/connect/secrets/keyringWords";

// The quiet way from a keyring row in the Secrets view to Passwords in the Intentic app on the reader's computer, where
// the owner's passwords are kept, shared and answered for. A link the app hears rather than a page here: Passwords is the
// computer's, and the sandbox only lists the pointers it was given (and the wants it waits on) as secrets.

const t = useT();
const { entry } = defineProps<{ entry?: string | undefined }>();
</script>

<template>
    <a
        :href="passwordsLink(entry)"
        class="text-2xs text-link hover:underline"
        data-open-passwords
        >{{ t(`sandbox.sandboxSecrets.openInPasswords`) }}</a
    >
</template>
