<script setup lang="ts">
import type { DaemonSession } from "@intentic/sandbox-contract";
import { Button, Notice, type NoticeModel, ui, useTheme, vAction } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useAuth } from "../../auth/useAuth";
import { useGoogleIdentity } from "../../auth/useGoogleIdentity";
import { browserSupportsPasskeys, recoverWithCode, registerPasskey, signInWithPasskey } from "../session/passkeySignIn";
import { useSignInPrompt } from "../session/signInPrompt";
import { useSandbox } from "../client/useSandbox";
import { desktopVersion, signInThroughBrowser } from "../../../app/environments/desktop";
import { useT } from "@intentic/ui/i18n";

// The sign-in overlay, in its three states. CHOOSE: useGoogleIdentity raised `needsSignIn`, so Google's button is
// up, and a passkey is offered beside it when the daemon has one for this origin. STEP-UP: a Google proof was taken
// but the sandbox requires a passkey: confirm with the one held, or add a first one; the owner may spend a recovery
// code instead. Every ceremony ends in a session handed back through the prompt; no token touches the platform here.
// Two Google surfaces, since Google's button does nothing inside the desktop app's webview: that window hands off to
// the real browser and adopts the credential on return.

const t = useT();

const { needsSignIn, renderButton, cancelSignIn } = useGoogleIdentity();
const { user } = useAuth();
const sandbox = useSandbox();
const router = useRouter();
const { scheme } = useTheme();
const { prompt, completeSignIn, dismissSignIn } = useSignInPrompt();

const btn = ref<HTMLElement>();
const desktop = computed(() => desktopVersion() !== undefined);
// Decided once: WebAuthn is a property of the window, and the desktop shells' webviews may lack it.
const passkeysWork = browserSupportsPasskeys();

const stepUp = computed(() => (prompt.value?.kind === `step-up` ? prompt.value : undefined));
const passkeyOffered = computed(() => prompt.value?.kind === `choose` && prompt.value.passkey && passkeysWork);
const visible = computed(() => needsSignIn.value || stepUp.value !== undefined);
// Only the owner holds recovery codes; the platform's own roster says who the reader is before any session exists.
const isOwner = computed(() => sandbox.active.value?.role === `owner`);

const busy = ref(false);
const notice = ref<NoticeModel | undefined>(undefined);
const label = ref(``);
const code = ref(``);

// Watches the container itself, not just the flag: a mint already in flight when mounted never toggles it.
watch(
    [needsSignIn, scheme, btn],
    () => {
        if (needsSignIn.value && btn.value && !desktop.value) {
            void renderButton(btn.value, scheme.value === `dark`);
        }
    },
    { flush: `post` },
);

// A new prompt starts clean: a refusal from the last one is not this one's.
watch(prompt, () => {
    notice.value = undefined;
    code.value = ``;
});

// One ceremony at a time; its session settles the establish waiting behind the prompt, its refusal is shown here.
const ceremony = async (wrote: string, work: () => Promise<DaemonSession>): Promise<void> => {
    if (busy.value) {
        return;
    }
    busy.value = true;
    notice.value = undefined;
    try {
        completeSignIn(await work());
    } catch (error) {
        notice.value = noticeFrom(error, wrote);
    } finally {
        busy.value = false;
    }
};

const usePasskey = (): Promise<void> => {
    const current = prompt.value;
    if (current === undefined) {
        return Promise.resolve();
    }
    return ceremony(`The passkey sign-in didn't complete.`, () => signInWithPasskey(current.target));
};

const addPasskey = (): Promise<void> => {
    const current = stepUp.value;
    if (current === undefined) {
        return Promise.resolve();
    }
    return ceremony(`The passkey wasn't added.`, async () => {
        const trimmed = label.value.trim();
        const registered = await registerPasskey(current.target, current.bearer, trimmed === `` ? undefined : trimmed);
        if (registered.session === undefined) {
            throw new Error(`The sandbox registered the passkey but minted no session; sign in again.`);
        }
        return registered.session;
    });
};

const recover = (): Promise<void> => {
    const current = stepUp.value;
    if (current === undefined || code.value.trim() === ``) {
        return Promise.resolve();
    }
    return ceremony(`That recovery code didn't open the sandbox.`, () => recoverWithCode(current.target, current.bearer, code.value));
};

// Opens the platform's sign-in page in the default browser; the deep-link return reloads this SPA, abandoning the
// mint awaited here, and the adopted credential answers the call that follows instead.
const signInOutside = (): void => signInThroughBrowser();

// Settles the awaiting mint and returns to setup instead of signing in; nothing needs severing.
const backToSetup = async (): Promise<void> => {
    cancelSignIn();
    dismissSignIn();
    const active = sandbox.activeSandboxId.value;
    await router.push(active === undefined ? `/setup` : { path: `/setup`, query: { sandbox: active } });
};
</script>

<template>
    <div v-if="visible" class="fixed inset-0 z-50 flex items-center justify-center bg-canvas/70 p-6 backdrop-blur-sm">
        <div class="w-full max-w-sm rounded-2xl border border-line bg-card p-6 shadow-xl">
            <div class="flex flex-col items-center gap-3 text-center">
                <span class="flex h-11 w-11 items-center justify-center rounded-xl bg-overlay text-link">
                    <Icon :name="stepUp ? `key` : `google`" class="text-lg" />
                </span>

                <!-- STEP-UP: the proof was taken, the sandbox wants its passkey. -->
                <template v-if="stepUp">
                    <h2 class="text-lg font-semibold text-content">
                        {{ stepUp.enrolled ? t(`sandbox.signInWall.confirm`) : t(`sandbox.signInWall.addPasskeyToContinue`) }}
                    </h2>
                    <p class="text-sm text-muted">
                        <template v-if="stepUp.enrolled">{{ t(`sandbox.signInWall.sandboxOnlyOpensPasskey`) }}</template>
                        <template v-else>
                            {{ t(`sandbox.signInWall.ownerSandboxRequiresPasskey`) }}
                        </template>
                    </p>
                    <Notice v-if="notice" :of="notice" class="w-full text-left" />
                    <template v-if="passkeysWork">
                        <Button
                            v-if="stepUp.enrolled"
                            :label="t(`sandbox.signInWall.usePasskey`)"
                            class="mt-2 w-full justify-center"
                            :loading="busy"
                            @click="usePasskey"
                        >
                            <template #icon><Icon name="key" /></template>
                        </Button>
                        <form v-else class="mt-2 flex w-full flex-col gap-2" @submit.prevent="addPasskey">
                            <input
                                v-model="label"
                                type="text"
                                autocomplete="off"
                                :placeholder="t(`sandbox.words.nameEGWork`)"
                                :class="ui.inputSm(`w-full`)"
                            />
                            <Button type="submit" :label="t(`sandbox.words.addPasskey`)" class="w-full justify-center" :loading="busy">
                                <template #icon><Icon name="key" /></template>
                            </Button>
                        </form>
                    </template>
                    <p v-else class="text-sm text-muted">{{ t(`sandbox.signInWall.windowCantUsePasskeys`) }}</p>
                    <!-- The owner's way back in from a browser with no passkey: one of the codes shown when the rule went on. -->
                    <form v-if="isOwner" class="mt-3 flex w-full flex-col gap-2 border-t border-line pt-3" @submit.prevent="recover">
                        <span class="text-2xs text-subtle">{{ t(`sandbox.signInWall.lostPasskeysUseOne`) }}</span>
                        <div class="flex gap-2">
                            <input
                                v-model="code"
                                type="text"
                                autocomplete="off"
                                spellcheck="false"
                                placeholder="xxxxx-xxxxx-xxxxx-xxxxx"
                                :class="ui.inputSm(`min-w-0 flex-1 font-mono`)"
                            />
                            <Button
                                type="submit"
                                :label="t(`sandbox.signInWall.useCode`)"
                                size="small"
                                severity="secondary"
                                :disabled="busy || code.trim() === ``"
                            />
                        </div>
                    </form>
                </template>

                <!-- CHOOSE: nothing in hand yet. -->
                <template v-else>
                    <h2 class="text-lg font-semibold text-content">{{ t(`sandbox.signInWall.signInToReach`) }}</h2>
                    <p class="text-sm text-muted">
                        <template v-if="desktop">{{ t(`sandbox.signInWall.intenticSignsInThrough`) }}</template>
                        <template v-else>{{ t(`sandbox.signInWall.continueGoogleToSecurely`) }}</template>
                        <template v-if="user?.email">
                            {{ t(`sandbox.signInWall.useIntenticAccount`) }} <span class="font-medium text-content">{{ user.email }}</span
                            >.
                        </template>
                    </p>
                    <Notice v-if="notice" :of="notice" class="w-full text-left" />
                    <!-- Google's own button does nothing when clicked here, so the desktop app hands off to the real browser instead. -->
                    <Button
                        v-if="desktop"
                        :label="t(`auth.words.continueGoogleInBrowser`)"
                        severity="secondary"
                        class="mt-2 w-full justify-center"
                        @click="signInOutside"
                    >
                        <template #icon><Icon name="google" /></template>
                    </Button>
                    <!-- `color-scheme: light` matches Google's button iframe so the browser paints no opaque canvas behind it. -->
                    <div v-else ref="btn" class="mt-2 flex justify-center" style="color-scheme: light"></div>
                    <template v-if="passkeyOffered">
                        <span class="text-2xs uppercase tracking-wide text-subtle">{{ t(`sandbox.signInWall.or`) }}</span>
                        <Button
                            :label="t(`sandbox.signInWall.usePasskey2`)"
                            severity="secondary"
                            class="w-full justify-center"
                            :loading="busy"
                            @click="usePasskey"
                        >
                            <template #icon><Icon name="key" /></template>
                        </Button>
                    </template>
                </template>

                <button type="button" :class="ui.textAction(`mt-1 text-subtle`)" v-action="backToSetup">
                    {{ t(`sandbox.signInWall.backToSetup`) }}
                </button>
            </div>
        </div>
    </div>
</template>
