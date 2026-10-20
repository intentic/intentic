<script setup lang="ts">
import type { DaemonSession } from "@intentic/sandbox-contract/schemas/system";
import { Button, Notice, type NoticeModel, ui, useTheme, vAction } from "@intentic/ui";
import { noticeFrom, noticeOf } from "@intentic/ui/async";
import FocusTrap from "primevue/focustrap";
import { computed, ref, useId, watch } from "vue";
import { useRouter } from "vue-router";
import { useAuth } from "../../../client/auth/useAuth";
import { useBrowserHandoff } from "../../auth/browserHandoff";
import { useGoogleIdentity } from "../../../client/auth/useGoogleIdentity";
import { browserSupportsPasskeys, recoverWithCode, registerPasskey, signInWithPasskey } from "../../../client/session/passkeySignIn";
import { useSignInPrompt } from "../../../client/session/signInPrompt";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { desktopVersion } from "../../../app/environments/desktop";
import { useT } from "@intentic/ui/i18n";

// The sign-in overlay, in its three states. CHOOSE: useGoogleIdentity raised `needsSignIn`, so Google's button is
// up, and a passkey is offered beside it when the daemon has one for this origin. An account that signs in by email has
// its own row ("Continue as"), which spends the platform's identity assertion; for one with no Google sign-in at all the
// prompt alone raises this wall and Google is never shown. A daemon too old to take the assertion is said by name, as is
// a refusal the last one met. STEP-UP: a proof was taken but the sandbox requires a passkey: confirm with the one held,
// or add a first one; the owner may spend a recovery code instead. Every ceremony ends in a session handed back through
// the prompt. Two Google surfaces, since Google's button does nothing inside the desktop app's webview: that window
// hands off to the real browser and adopts the credential on return.

const t = useT();

const { needsSignIn, renderButton, cancelSignIn } = useGoogleIdentity();
const { user } = useAuth();
const sandbox = useSandbox();
const router = useRouter();
const { scheme } = useTheme();
const { prompt, completeSignIn, dismissSignIn, escalateSignIn } = useSignInPrompt();

const btn = ref<HTMLElement>();
const desktop = computed(() => desktopVersion() !== undefined);
// Decided once: WebAuthn is a property of the window, and the desktop shells' webviews may lack it.
const passkeysWork = browserSupportsPasskeys();

const stepUp = computed(() => (prompt.value?.kind === `step-up` ? prompt.value : undefined));
const choose = computed(() => (prompt.value?.kind === `choose` ? prompt.value : undefined));
const passkeyOffered = computed(() => choose.value?.passkey === true && passkeysWork);
// The account's email road on this sandbox, when it has one (sandboxSession.ts emailRoadFor).
const emailRoad = computed(() => choose.value?.email);
// An account with no Google sign-in: no Google surface at all, and the prompt alone is what raises this wall.
const withoutGoogle = computed(() => choose.value?.withoutGoogle === true);
const visible = computed(() => needsSignIn.value || stepUp.value !== undefined || withoutGoogle.value);
// Names the dialog by whichever heading the state it is in draws.
const titleId = useId();
// Tab stays inside the gate while it is up, as it does in every <Modal>.
const vFocustrap = FocusTrap;
// Only the owner holds recovery codes; the platform's own roster says who the reader is before any session exists.
const isOwner = computed(() => sandbox.active.value?.role === `owner`);

const busy = ref(false);
const notice = ref<NoticeModel | undefined>(undefined);
const label = ref(``);
const code = ref(``);

// What the email road met last time, said before anything is pressed; a refusal from a press here replaces it.
const roadNotice = computed<NoticeModel | undefined>(() => {
    const road = emailRoad.value;
    if (road?.kind !== `offered` || road.refusal === undefined) {
        return undefined;
    }
    return noticeOf(road.refusal === `email-sign-in-off` ? t(`sandbox.sandboxSession.emailSignInOff`) : t(`sandbox.sandboxSession.platformKeyUnknown`), {
        tone: `warning`,
    });
});
// A refusal from a press here, else what the email road met before the wall went up.
const shownNotice = computed(() => notice.value ?? roadNotice.value);
// A daemon from before email sign-in, for an account with no other way in: the gap, named, with who closes it.
const outdatedNote = computed(() =>
    emailRoad.value?.kind === `outdated` ? (isOwner.value ? t(`sandbox.signInWall.emailNeedsUpdateOwner`) : t(`sandbox.signInWall.emailNeedsUpdate`)) : undefined,
);

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

// One attempt at a time; what it settles is its own business, its refusal is shown here.
const attempt = async (wrote: string, work: () => Promise<void>): Promise<void> => {
    if (busy.value) {
        return;
    }
    busy.value = true;
    notice.value = undefined;
    try {
        await work();
    } catch (error) {
        notice.value = noticeFrom(error, wrote);
    } finally {
        busy.value = false;
    }
};

// A ceremony's session settles the establish waiting behind the prompt.
const ceremony = (wrote: string, work: () => Promise<DaemonSession>): Promise<void> =>
    attempt(wrote, async () => {
        completeSignIn(await work());
    });

// "Continue as": a fresh assertion from the platform, spent on this daemon. A sandbox that also wants a passkey turns
// this same prompt into the step-up, whose ceremony then settles it.
const useEmail = (): Promise<void> => {
    const current = choose.value;
    const road = current?.email;
    if (current === undefined || road?.kind !== `offered`) {
        return Promise.resolve();
    }
    return attempt(t(`sandbox.signInWall.emailSignInIncomplete`), async () => {
        const answered = await road.spend();
        if (`session` in answered) {
            completeSignIn(answered.session);
            return;
        }
        escalateSignIn(current.target, answered.stepUp, answered.bearer);
    });
};

const usePasskey = (): Promise<void> => {
    const current = prompt.value;
    if (current === undefined) {
        return Promise.resolve();
    }
    return ceremony(t(`sandbox.signInWall.passkeySignInIncomplete`), () => signInWithPasskey(current.target));
};

const addPasskey = (): Promise<void> => {
    const current = stepUp.value;
    if (current === undefined) {
        return Promise.resolve();
    }
    return ceremony(t(`sandbox.signInWall.passkeyNotAdded`), async () => {
        const trimmed = label.value.trim();
        const registered = await registerPasskey(current.target, current.bearer, trimmed === `` ? undefined : trimmed);
        if (registered.session === undefined) {
            throw new Error(t(`sandbox.signInWall.registeredNoSession`));
        }
        return registered.session;
    });
};

const recover = (): Promise<void> => {
    const current = stepUp.value;
    if (current === undefined || code.value.trim() === ``) {
        return Promise.resolve();
    }
    return ceremony(t(`sandbox.signInWall.recoveryCodeRefused`), () => recoverWithCode(current.target, current.bearer, code.value));
};

// Opens the platform's sign-in page in the default browser; the deep-link return reloads this SPA, abandoning the
// mint awaited here, and the adopted credential answers the call that follows instead. Until then the wall says the
// sign-in is waiting in the browser (browserHandoff.ts).
const handoff = useBrowserHandoff();
const waitingInBrowser = computed(() => desktop.value && handoff.waiting.value);
const signInOutside = (): void => handoff.start();

// A sandbox that has answered before and was not removed: its reader is at work, not in a setup. "Back to setup" sent
// them to /setup, where the same wall came up again over a line saying the container was cleaned up.
const working = computed(() => {
    const active = sandbox.active.value;
    return active !== undefined && (active.lastSeenAt ?? null) !== null && (active.removedAt ?? null) === null;
});

// Settles the awaiting mint and stays where the reader is: the sandbox's own gate still offers to sign in.
const notNow = (): void => {
    handoff.cancel();
    cancelSignIn();
    dismissSignIn();
};

// Settles the awaiting mint and returns to setup instead of signing in; nothing needs severing.
const backToSetup = async (): Promise<void> => {
    handoff.cancel();
    cancelSignIn();
    dismissSignIn();
    const active = sandbox.activeSandboxId.value;
    await router.push(active === undefined ? `/setup` : { path: `/setup`, query: { sandbox: active } });
};
</script>

<template>
    <!-- A dialog drawn by hand, because it owns a centred sign-in layout and its tests read it where it mounts: the
         same scrim and box as every <Modal> (dialog.css), the same semantics, a trapped Tab, and Esc for "Not now"
         wherever that is the way out (never for Back to setup, which leaves the page). -->
    <div
        v-if="visible"
        class="ui-scrim fixed inset-0 z-50 flex items-center justify-center p-6"
        @keydown.esc="working || !isOwner ? notNow() : undefined"
    >
        <div v-focustrap class="ui-dialog-surface w-full max-w-sm p-6" role="dialog" aria-modal="true" :aria-labelledby="titleId">
            <div class="flex flex-col items-center gap-3 text-center">
                <span class="flex h-11 w-11 items-center justify-center rounded-xl bg-overlay text-link">
                    <Icon :name="stepUp ? `key` : waitingInBrowser ? `external-link` : withoutGoogle ? `envelope` : `google`" class="text-lg" />
                </span>

                <!-- STEP-UP: the proof was taken, the sandbox wants its passkey. -->
                <template v-if="stepUp">
                    <h2 :id="titleId" class="text-lg font-semibold text-content">
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
                                :class="ui.input({ size: `sm` }, `w-full`)"
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
                                :class="ui.input({ size: `sm` }, `min-w-0 flex-1 font-mono`)"
                            />
                            <Button
                                type="submit"
                                :label="t(`sandbox.signInWall.useCode`)"
                                size="small"
                                tier="boring"
                                :disabled="busy || code.trim() === ``"
                            />
                        </div>
                    </form>
                </template>

                <!-- CHOOSE: nothing in hand yet. -->
                <template v-else>
                    <div class="space-y-2" role="status">
                        <h2 :id="titleId" class="text-lg font-semibold text-content">
                            {{ waitingInBrowser ? t(`sandbox.signInWall.continueInBrowser`) : t(`sandbox.signInWall.signInToReach`) }}
                        </h2>
                        <p class="text-sm text-muted">
                            <template v-if="waitingInBrowser">{{ t(`sandbox.signInWall.browserReturnsAutomatically`) }}</template>
                            <template v-else-if="withoutGoogle">{{ t(`sandbox.signInWall.intenticConfirmsAddress`) }}</template>
                            <template v-else-if="desktop">{{ t(`sandbox.signInWall.intenticSignsInThrough`) }}</template>
                            <template v-else>{{ t(`sandbox.signInWall.continueGoogleToSecurely`) }}</template>
                        </p>
                    </div>
                    <p v-if="user?.email" class="text-xs text-muted">
                        {{ t(`sandbox.signInWall.useIntenticAccount`) }} <span class="break-all font-medium text-content">{{ user.email }}</span>
                    </p>
                    <Notice v-if="shownNotice" :of="shownNotice" class="w-full text-left" />
                    <!-- Google's surfaces, for an account that has a Google sign-in. Google's own button does nothing when
                         clicked inside the desktop app, so that window hands off to the real browser instead. -->
                    <template v-if="!withoutGoogle">
                        <Button
                            v-if="desktop && !waitingInBrowser"
                            :label="t(`auth.words.continueGoogle`)"
                            tier="boring"
                            class="mt-2 w-full justify-center"
                            @click="signInOutside"
                        >
                            <template #icon><Icon name="google" /></template>
                        </Button>
                        <!-- `color-scheme: light` matches Google's button iframe so the browser paints no opaque canvas behind it. -->
                        <div v-else-if="!desktop" ref="btn" class="mt-2 flex justify-center" style="color-scheme: light"></div>
                    </template>
                    <!-- The email road: the platform vouches for the address, so it works the same in every window. -->
                    <template v-if="emailRoad?.kind === `offered` && !waitingInBrowser">
                        <span v-if="!withoutGoogle" class="text-2xs text-subtle">{{ t(`sandbox.signInWall.or`) }}</span>
                        <Button
                            :label="t(`sandbox.signInWall.continueAsEmail`, { email: emailRoad.address })"
                            :tier="withoutGoogle ? `accent` : `boring`"
                            class="w-full justify-center"
                            :class="withoutGoogle ? `mt-2` : ``"
                            :loading="busy"
                            @click="useEmail"
                        >
                            <template #icon><Icon name="envelope" /></template>
                        </Button>
                    </template>
                    <p v-else-if="outdatedNote" class="w-full rounded-md bg-overlay px-3 py-2 text-left text-xs leading-snug text-muted" role="note">
                        {{ outdatedNote }}
                    </p>
                    <template v-if="passkeyOffered && !waitingInBrowser">
                        <span class="text-2xs text-subtle">{{ t(`sandbox.signInWall.or`) }}</span>
                        <Button
                            :label="t(`sandbox.signInWall.usePasskey2`)"
                            tier="boring"
                            class="w-full justify-center"
                            :loading="busy"
                            @click="usePasskey"
                        >
                            <template #icon><Icon name="key" /></template>
                        </Button>
                    </template>
                </template>

                <!-- A working sandbox's reader stays where they are; only a setup has a setup to go back to, and only the
                     owner's: /setup on a sandbox a member doesn't own starts a new one on their account instead. -->
                <div class="mt-2 flex w-full items-center justify-center gap-6">
                    <button v-if="waitingInBrowser && !stepUp" type="button" :class="ui.textButton()" @click="handoff.start">
                        {{ t(`sandbox.signInWall.openBrowser`) }}
                        <Icon name="external-link" class="text-2xs" />
                    </button>
                    <button v-if="working || !isOwner" type="button" :class="ui.textButton({ tone: `subtle` })" @click="notNow">
                        {{ t(`sandbox.signInWall.notNow`) }}
                    </button>
                    <button v-else type="button" :class="ui.textButton({ tone: `subtle` })" v-action="backToSetup">
                        {{ t(`sandbox.signInWall.backToSetup`) }}
                    </button>
                </div>
            </div>
        </div>
    </div>
</template>
