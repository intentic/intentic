<!-- THE PHONE'S WAY OFF STEP 3.
     Setup's third step hands over a command for a terminal, and a phone is the one device that cannot finish
     it. Not because the screen is small — the page already reflows for that — but because the goal itself is
     unreachable there: there is no shell to paste into, and the clipboard the Copy button writes to belongs to
     the wrong machine. Every affordance on the step used to point at that dead end, with the correction
     arriving forty seconds later as a warning banner, after the user had already committed to it.
     So on a phone this replaces Copy as the thing to press. It sends the one artefact that travels between
     devices — the address of this very page — and the laptop that opens it resumes the same sandbox at the same
     step with the command already on screen. The mail carries no code and no command (see setup-email.ts); it
     is a bookmark the user posts to themselves.
     The command stays visible underneath. Copying it on a phone is not always a mistake: people drive servers
     from Termius and Blink, and for them the phone IS the terminal. That path just stops being the loud one. -->
<script setup lang="ts">
import { cmp } from "@intentic/ui";
import Button from "primevue/button";
import { ref } from "vue";
import { apiClient } from "../composables/useApi";
import { errorMessage } from "../composables/useAsyncAction";

// `email` is shown, not sent: the server addresses this to the session's own account and takes no recipient,
// so what the caller passes here is only what the confirmation line reads back.
const { sandboxId, email } = defineProps<{ sandboxId: string; email: string }>();

// Not a milestone the page turns on (that is still the command reaching a machine), so the parent only needs
// to know a send landed — for the funnel, and to stop nagging about a terminal.
const emit = defineEmits<{ sent: [] }>();

const sending = ref(false);
const sent = ref(false);
const error = ref<string | undefined>(undefined);

const send = async (): Promise<void> => {
    if (sending.value) {
        return;
    }
    sending.value = true;
    error.value = undefined;
    try {
        await apiClient.sandbox.emailSetupLink({ sandboxId });
        sent.value = true;
        emit(`sent`);
    } catch (err) {
        error.value = errorMessage(err, `Couldn't send that email — try again.`);
    } finally {
        sending.value = false;
    }
};
</script>

<template>
    <div class="flex flex-col gap-2.5 rounded-lg border border-line bg-overlay/40 p-3">
        <!-- The heading a phone needed all along: which device this step belongs to. Stated BEFORE the command
             rather than as a correction after it, because the mistake it prevents is silent — someone who has
             not realised the command runs elsewhere never does anything this page can react to. -->
        <p class="flex items-start gap-2.5 text-xs text-content">
            <Icon name="desktop" class="mt-0.5 shrink-0 text-link" />
            <span class="min-w-0">
                This runs on a <span class="font-medium">computer</span>, not on your phone — it needs a terminal and Docker.
                <template v-if="!sent">Send yourself the link and pick it up there.</template>
            </span>
        </p>

        <template v-if="sent">
            <!-- Green on the two words that are the confirmation, and nowhere else. The instruction after them
                 is the longer half and it is not news — a whole paragraph in the success colour reads as a
                 banner to skip past, which is the opposite of what the only remaining step deserves. -->
            <p class="flex items-start gap-2.5 text-xs text-muted">
                <Icon name="check" class="mt-0.5 shrink-0 text-success" />
                <span class="min-w-0">
                    <span class="font-medium text-success"
                        >Sent to <span class="break-words">{{ email }}</span
                        >.</span
                    >
                    Open it on the computer that will host your sandbox — leave this page open and it'll jump to your workspace the moment that
                    machine connects.
                </span>
            </p>
            <!-- Quiet, because the common reason to press it twice is impatience with a mail that is already on
                 its way. It is here for the real one: a typo'd guess at which inbox is open on the laptop. -->
            <button type="button" :class="cmp.linkButton(`text-muted underline hover:text-content`)" :disabled="sending" @click="send">
                {{ sending ? `Sending…` : `Send it again` }}
            </button>
        </template>
        <Button v-else label="Email me the link" class="w-full justify-center" :loading="sending" :disabled="sending" @click="send">
            <template #icon><Icon name="envelope" /></template>
        </Button>

        <p v-if="error" :class="cmp.alertDanger()">{{ error }}</p>
    </div>
</template>
