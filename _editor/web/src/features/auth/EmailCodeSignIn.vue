<!-- The emailed-code sign-in (useEmailCode.ts) as one block, for every screen that offers it beside Google. -->
<script setup lang="ts">
import { Button, Notice, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, nextTick, ref, toRef, useId, watch } from "vue";
import { CODE_LENGTH } from "../../client/auth/emailCode";
import { googleMailbox } from "../../client/auth/signInMethods";
import { useEmailCode } from "./useEmailCode";

const props = defineProps<{
    // The invite's address: shown, never editable, since the platform accepts the invite for no other.
    readonly lockedEmail?: string | undefined;
    // The desktop app's webview or the iOS shell, where the mail's link opens the system browser rather than this
    // window: the code is typed here, and the copy says so.
    readonly inApp?: boolean;
    // Whether Google's sign-in is on this screen too, so a Google address is pointed at it (a hint, never a block).
    readonly googleOffered?: boolean;
}>();

const emit = defineEmits<{ signedIn: [] }>();

const t = useT();

const {
    typed,
    address,
    step,
    sentTo,
    code,
    sending,
    verifying,
    notice,
    needsNewCode,
    resendInSeconds,
    canSend,
    canResend,
    canVerify,
    send,
    resend,
    verify,
    typeCode,
    changeAddress,
} = useEmailCode({ lockedEmail: toRef(props, `lockedEmail`), onSignedIn: () => emit(`signedIn`) });

const addressId = useId();
const codeId = useId();
const codeInput = ref<HTMLInputElement>();

const googleHint = computed(() => props.googleOffered === true && props.lockedEmail === undefined && googleMailbox(address.value));

// The code field takes the keyboard the moment it appears: the reader's next act is to type what just arrived.
watch(step, async (now) => {
    if (now === `code`) {
        await nextTick();
        codeInput.value?.focus();
    }
});

const onCode = (event: Event): void => typeCode(event.target instanceof HTMLInputElement ? event.target.value : ``);
</script>

<template>
    <div class="flex w-full flex-col gap-2 text-left">
        <!-- ADDRESS: where the code goes. -->
        <form v-if="step === `address`" class="flex flex-col gap-2" @submit.prevent="send">
            <template v-if="lockedEmail === undefined">
                <label :for="addressId" class="sr-only">{{ t(`auth.emailSignIn.addressLabel`) }}</label>
                <input
                    :id="addressId"
                    v-model="typed"
                    type="email"
                    autocomplete="email"
                    inputmode="email"
                    autocapitalize="off"
                    spellcheck="false"
                    :placeholder="t(`auth.emailSignIn.addressPlaceholder`)"
                    :class="ui.input(`w-full`)"
                />
                <p v-if="googleHint" class="text-xs leading-snug text-subtle">{{ t(`auth.emailSignIn.googleFaster`) }}</p>
            </template>
            <Button
                type="submit"
                :label="lockedEmail === undefined ? t(`auth.emailSignIn.continueWithEmail`) : t(`auth.emailSignIn.emailMeCode`)"
                tier="boring"
                class="w-full justify-center"
                :loading="sending"
                :disabled="!canSend"
            >
                <template #icon><Icon name="envelope" /></template>
            </Button>
        </form>

        <!-- CODE: the six digits the platform mailed. -->
        <form v-else class="flex flex-col gap-2" @submit.prevent="verify">
            <i18n-t keypath="auth.emailSignIn.sentTo" tag="p" class="text-sm leading-snug" scope="global">
                <template #email
                    ><span class="break-all font-medium">{{ sentTo }}</span></template
                >
            </i18n-t>
            <p class="text-xs leading-snug text-subtle">
                {{ inApp ? t(`auth.emailSignIn.typeItHereInApp`) : t(`auth.emailSignIn.typeItOrOpenLink`) }}
            </p>
            <label :for="codeId" class="sr-only">{{ t(`auth.emailSignIn.codeLabel`) }}</label>
            <input
                :id="codeId"
                ref="codeInput"
                :value="code"
                type="text"
                inputmode="numeric"
                autocomplete="one-time-code"
                pattern="[0-9]*"
                :maxlength="CODE_LENGTH + 2"
                placeholder="000000"
                :disabled="verifying"
                :class="ui.input(`w-full text-center font-mono tracking-[0.5em]`)"
                @input="onCode"
            />
            <Button
                type="submit"
                :label="t(`ui.action.signIn`)"
                class="w-full justify-center"
                :loading="verifying"
                :disabled="!canVerify"
            />
            <div class="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
                <button v-if="lockedEmail === undefined" type="button" :class="ui.textButton({ tone: `subtle` })" @click="changeAddress">
                    {{ t(`auth.emailSignIn.useDifferentAddress`) }}
                </button>
                <button type="button" :class="ui.textButton()" :disabled="!canResend" @click="resend">
                    {{ resendInSeconds > 0 ? t(`auth.emailSignIn.sendAgainIn`, { seconds: resendInSeconds }) : t(`auth.emailSignIn.sendAgain`) }}
                </button>
            </div>
            <!-- The mail's link spends the same code: opened on a phone, or in the browser the app's own window cannot be, it
                 signed that in and left this screen's code used. -->
            <p class="text-2xs leading-snug text-subtle">
                {{ t(`auth.emailSignIn.usedLinkElsewhere`) }}
                <button type="button" :class="ui.textButton()" :disabled="!canResend" @click="resend">{{ t(`auth.emailSignIn.sendNewCode`) }}</button>
            </p>
        </form>

        <!-- A live region from the first frame, so a refusal that appears in it is read out. -->
        <div role="status">
            <Notice v-if="notice" :of="notice" />
            <Button
                v-if="notice && needsNewCode"
                :label="t(`auth.emailSignIn.sendNewCode`)"
                tier="accent"
                size="small"
                class="mt-2"
                :disabled="!canResend"
                @click="resend"
            />
        </div>
    </div>
</template>
