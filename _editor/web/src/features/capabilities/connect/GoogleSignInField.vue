<!-- A Google Workspace card's sign-in, in place of a refresh-token box: Google's own consent in a popup, through the
     platform's OAuth client, and the grant lands in the form for the ordinary Save to store. Nobody makes a Cloud
     project or pastes a token. A card with its own client ID (Advanced) gets the plain box back (googleConnect.ts). -->
<script setup lang="ts">
import { GOOGLE_CONNECT_CHANNEL } from "@intentic/api-contract";
import type { CapabilityField } from "@intentic/extension-manifest";
import { BrandMark, Button, ui } from "@intentic/ui";
import { messageOr } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { ORPCError } from "@orpc/client";
import { computed, onBeforeUnmount, ref } from "vue";
import { apiClient } from "../../../lib/useApi";
import {
    accessOf,
    type CallbackAnswer,
    challengeOf,
    GoogleCallbackSchema,
    type GoogleAccess,
    grantCovers,
    grantedAccess,
    makeState,
    makeVerifier,
    readCallback,
} from "../../../models/capabilities/googleConnect";

const t = useT();

const { field, values, stored = false, alarm } = defineProps<{
    field: CapabilityField;
    /** The form's live answers: this row writes its own field (the refresh token) and the card's `email`, and reads `access`. */
    values: Record<string, string>;
    /** The connection being edited already holds a sign-in, which a blank answer keeps. */
    stored?: boolean;
    /** The red treatment, for a submit refused while nobody has signed in. */
    alarm?: string | undefined;
}>();

const emit = defineEmits<{ left: [] }>();

const POPUP = `intentic-google-connect`;
const POPUP_FEATURES = `popup,width=520,height=680`;

type Phase = `idle` | `waiting` | `finishing`;
const phase = ref<Phase>(`idle`);
const problem = ref<string>();
// What the last sign-in here granted, and the token it put in the form: it counts only while the form still holds it.
const grant = ref<{ readonly email: string; readonly access: GoogleAccess; readonly token: string }>();
const fresh = computed(() => (grant.value !== undefined && values[field.key] === grant.value.token ? grant.value : undefined));
// A read-only grant on a card now asking for read & write: Google enforces the grant, so only a new consent fixes it.
const short = computed(() => fresh.value !== undefined && !grantCovers(fresh.value.access, accessOf(values)));

// The consent in flight: the popup, and what stops listening for its answer.
let pending: { readonly popup: Window; readonly stop: () => void } | undefined;
let showing = true;

const settleListening = (): Window | undefined => {
    const popup = pending?.popup;
    pending?.stop();
    pending = undefined;
    return popup;
};

const cancel = (): void => {
    settleListening()?.close();
    phase.value = `idle`;
};

const refusalOf = (error: string): string =>
    error === `access_denied` ? t(`capabilities.googleSignInField.cancelledOnGoogle`) : t(`capabilities.googleSignInField.googleRefused`, { error });

const finish = async (answer: CallbackAnswer, verifier: string): Promise<void> => {
    settleListening()?.close();
    if (`error` in answer) {
        phase.value = `idle`;
        problem.value = refusalOf(answer.error);
        return;
    }
    phase.value = `finishing`;
    try {
        const made = await apiClient.googleConnect.finish({ code: answer.code, codeVerifier: verifier });
        if (!showing) {
            return;
        }
        values[field.key] = made.refreshToken;
        if (made.email !== ``) {
            values[`email`] = made.email;
        }
        grant.value = { email: made.email, access: grantedAccess(made.scopes), token: made.refreshToken };
        emit(`left`);
    } catch (caught) {
        problem.value = messageOr(caught, t(`capabilities.googleSignInField.couldntFinish`));
    } finally {
        phase.value = `idle`;
    }
};

// Google's pages can sever window.opener (their opener policy), so the callback page broadcasts on a channel too; the
// window message is the path when the opener survives. Either way only this consent's state is acted on.
const listen = (popup: Window, state: string, verifier: string): void => {
    const channel = new BroadcastChannel(GOOGLE_CONNECT_CHANNEL);
    const heard = (told: ReturnType<typeof GoogleCallbackSchema.safeParse>): void => {
        const answer = told.success ? readCallback(told.data, state) : undefined;
        if (answer !== undefined) {
            void finish(answer, verifier);
        }
    };
    const onChannel = (event: MessageEvent): void => heard(GoogleCallbackSchema.safeParse(event.data));
    const onWindow = (event: MessageEvent): void => {
        if (event.origin === window.location.origin) {
            heard(GoogleCallbackSchema.safeParse(event.data));
        }
    };
    channel.addEventListener(`message`, onChannel);
    window.addEventListener(`message`, onWindow);
    pending = {
        popup,
        stop: () => {
            channel.close();
            window.removeEventListener(`message`, onWindow);
        },
    };
};

const begin = async (popup: Window): Promise<void> => {
    const state = makeState();
    const verifier = makeVerifier();
    listen(popup, state, verifier);
    phase.value = `waiting`;
    try {
        const email = (values[`email`] ?? ``).trim();
        const { url } = await apiClient.googleConnect.begin({
            access: accessOf(values),
            loginHint: email === `` ? undefined : email,
            state,
            codeChallenge: await challengeOf(verifier),
        });
        popup.location.href = url;
    } catch (caught) {
        cancel();
        problem.value =
            caught instanceof ORPCError && caught.code === `NOT_FOUND`
                ? t(`capabilities.googleSignInField.noPlatformClient`)
                : messageOr(caught, t(`capabilities.googleSignInField.couldntStart`));
    }
};

// The popup opens in the click itself, blank, so no blocker sees a window opened after an await; Google's page is
// loaded into it once the platform has built the consent URL.
const connect = (): void => {
    cancel();
    problem.value = undefined;
    const popup = window.open(`about:blank`, POPUP, POPUP_FEATURES);
    if (popup === null) {
        problem.value = t(`capabilities.googleSignInField.popupBlocked`);
        return;
    }
    void begin(popup);
};

onBeforeUnmount(() => {
    showing = false;
    cancel();
});

const status = computed(() => {
    if (phase.value === `waiting`) {
        return t(`capabilities.googleSignInField.waitingForGoogle`);
    }
    if (phase.value === `finishing`) {
        return t(`capabilities.googleSignInField.finishing`);
    }
    return stored ? t(`capabilities.googleSignInField.signedIn`) : t(`capabilities.googleSignInField.opensGoogle`);
});
</script>

<template>
    <!-- A div, not a label: a label forwards every click inside it to its first control, which here opens a popup. -->
    <div class="ui-field">
        <span class="ui-field-label">
            {{ field.label }}
            <Icon v-if="fresh || stored" name="check-circle" class="ml-1 text-2xs text-success" />
        </span>
        <div v-if="fresh" class="flex items-center gap-3 rounded-lg bg-card px-3 py-2 shadow-sm">
            <BrandMark :size="24" name="Google" logo="google" />
            <span class="min-w-0 flex-1">
                <span class="block truncate text-xs text-content">
                    {{
                        fresh.email === ``
                            ? t(`capabilities.googleSignInField.connected`)
                            : t(`capabilities.googleSignInField.connectedAs`, { email: fresh.email })
                    }}
                </span>
                <span class="block text-2xs text-muted">
                    {{
                        fresh.access === `write`
                            ? t(`capabilities.googleSignInField.grantedReadWrite`)
                            : t(`capabilities.googleSignInField.grantedReadOnly`)
                    }}
                </span>
            </span>
            <button type="button" :class="ui.textButton({ size: `xs`, tone: `quiet` })" @click="connect">
                {{ t(`capabilities.googleSignInField.reconnect`) }}
            </button>
        </div>
        <div v-else class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <Button
                :label="stored ? t(`capabilities.googleSignInField.reconnect`) : t(`capabilities.googleSignInField.connectGoogle`)"
                size="small"
                tier="boring"
                :loading="phase !== `idle`"
                @click="connect"
            >
                <template #icon><BrandMark :size="14" name="Google" logo="google" plain /></template>
            </Button>
            <span class="min-w-0 flex-1 text-2xs text-muted">{{ status }}</span>
            <button v-if="phase === `waiting`" type="button" :class="ui.textButton({ size: `xs` })" @click="cancel">
                {{ t(`capabilities.googleSignInField.stopWaiting`) }}
            </button>
        </div>
        <!-- One severity-ordered line below the control, like every other field on this form. -->
        <span v-if="problem" class="ui-field-error">
            <Icon name="exclamation-triangle" class="text-2xs" />
            {{ problem }}
        </span>
        <span v-else-if="short" class="flex items-center gap-1 text-2xs text-warning">
            <Icon name="exclamation-triangle" class="text-2xs" />
            {{ t(`capabilities.googleSignInField.reconnectForWrite`) }}
        </span>
        <span v-else-if="alarm && !fresh && !stored" class="ui-field-error">
            <Icon name="exclamation-triangle" class="text-2xs" />
            {{ t(`capabilities.googleSignInField.connectFirst`) }}
        </span>
    </div>
</template>
