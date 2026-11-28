<script setup lang="ts">
import type { DaemonSession } from "@intentic/sandbox-contract/schemas/system";
import { Avatar, Button, Notice, type NoticeModel, SandboxLogo, ui, useTheme, vAction } from "@intentic/ui";
import { noticeFrom, noticeOf } from "@intentic/ui/async";
import FocusTrap from "primevue/focustrap";
import { computed, nextTick, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useAuth } from "../../../client/auth/useAuth";
import { useBrowserHandoff } from "../../auth/browserHandoff";
import { useGoogleIdentity } from "../../../client/auth/useGoogleIdentity";
import { browserSupportsPasskeys, recoverWithCode, registerPasskey, signInWithPasskey } from "../../../client/session/passkeySignIn";
import { emailRefusalText } from "../../../client/session/emailRefusal";
import { useSignInPrompt } from "../../../client/session/signInPrompt";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { desktopVersion } from "../../../app/environments/desktop";
import { useT } from "@intentic/ui/i18n";
import { ADD_SANDBOX_HOME_PATH } from "../../../models/sandbox/addSandbox";
import { finishOnHome } from "../../../models/sandbox/finishOnHome";
import { sandboxColor } from "../overview/logo/sandboxColor";

// The sign-in overlay, in its three states. CHOOSE: useGoogleIdentity raised `needsSignIn`, so Google's button is
// up, and a passkey is offered beside it when the daemon has one for this origin. An account that signs in by email has
// its own row ("Continue as"), which spends the platform's identity assertion; for one with no Google sign-in at all the
// prompt alone raises this wall and Google is never shown. A daemon too old to take the assertion is said by name, as is
// a refusal the last one met. STEP-UP: a proof was taken but the sandbox requires a passkey: confirm with the one held,
// or add a first one; the owner may spend a recovery code instead. Every ceremony ends in a session handed back through
// the prompt. Two Google surfaces, since Google's button does nothing inside the desktop app's webview: that window
// hands off to the real browser and adopts the credential on return.
//
// What the card says, in every state (redesigned 2026-11-28, after "a G icon and 'sign in' three times"): who (your
// face and address) is opening what (the sandbox's own face, colour and name, which is the title), with the state as
// the glyph between them (a lock, a key, a browser hand-off). Then one way in, the others as a compact row under "or",
// and the way out. Words only for what a glyph cannot say: why a passkey is asked after Google, a refusal, a gap.

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
// Tab stays inside the gate while it is up, as it does in every <Modal>.
const vFocustrap = FocusTrap;
// Only the owner holds recovery codes; the platform's own roster says who the reader is before any session exists.
const isOwner = computed(() => sandbox.active.value?.tier === `owner`);

// The sandbox being opened, which is the card's title: the one the prompt names, else (Google's gate raised with no
// prompt, as a refused proof's retry or a setup's attach does) the open one. Undefined for an address the platform
// does not list, which the card then calls "your sandbox".
const opening = computed(() => {
    const current = prompt.value;
    if (current === undefined) {
        return sandbox.active.value;
    }
    const id = current.target.sandboxId;
    return id === undefined ? undefined : (sandbox.sandboxes.value.find((row) => row.id === id) ?? (sandbox.active.value?.id === id ? sandbox.active.value : undefined));
});
const heading = computed(() => opening.value?.name ?? t(`sandbox.signInWall.signInToReach`));
// The heading is a name alone; a screen reader hears what the dialog asks.
const dialogName = computed(() => (opening.value === undefined ? heading.value : t(`sandbox.signInWall.signInTo`, { name: opening.value.name })));
// Its own colour (sandboxColor.ts), the one its rail wears once it opens; mixed toward the theme's card and ink, as the
// rail's sandbox circles are, so it reads in light and dark alike. A picture brings its own colour and sits on the card.
const hue = computed(() => (opening.value === undefined ? undefined : sandboxColor(opening.value)));
const tile = computed<Record<string, string> | undefined>(() => {
    const color = hue.value;
    if (color === undefined || (opening.value?.image ?? null) !== null) {
        return undefined;
    }
    return { backgroundColor: `color-mix(in oklab, ${color} 30%, var(--color-card))`, color: `color-mix(in oklab, ${color} 70%, var(--color-content))` };
});
const wash = computed(() =>
    hue.value === undefined ? undefined : { background: `radial-gradient(100% 100% at 50% 0%, color-mix(in oklab, ${hue.value} 26%, transparent), transparent 70%)` },
);

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
    return noticeOf(emailRefusalText(road.refusal), { tone: `warning` });
});
// A refusal from a press here, else what the email road met before the wall went up; the step-up says only its own.
const shownNotice = computed(() => notice.value ?? roadNotice.value);
const cardNotice = computed(() => (stepUp.value ? notice.value : shownNotice.value));
// A daemon from before email sign-in, for an account with no other way in: the gap, named, with who closes it.
// compat(daemon<1.333.0): `email` among /health signIn.proofs
const outdatedNote = computed(() =>
    emailRoad.value?.kind === `outdated` ? (isOwner.value ? t(`sandbox.signInWall.emailNeedsUpdateOwner`) : t(`sandbox.signInWall.emailNeedsUpdate`)) : undefined,
);

// Whether Google's button failed to draw (its script blocked or unreachable): an empty slot where the only way in was
// meant to be, so the wall says why instead.
const googleDidntLoad = ref(false);

// Watches the container itself, not just the flag: a mint already in flight when mounted never toggles it.
watch(
    [needsSignIn, scheme, btn],
    async () => {
        if (needsSignIn.value && btn.value && !desktop.value) {
            googleDidntLoad.value = !(await renderButton(btn.value, scheme.value === `dark`));
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

// Opens the platform's sign-in page in the default browser; the hand-off comes back to this same view and is taken in
// place (features/auth/signInDialog.ts `arriveInPlace`), whose adopted credential answers the mint awaited here. Until
// then the wall says the sign-in is waiting in the browser (browserHandoff.ts).
const handoff = useBrowserHandoff();
const waitingInBrowser = computed(() => desktop.value && handoff.waiting.value);
const signInOutside = (): void => handoff.start(router.currentRoute.value.fullPath);

// The state, as the glyph between the reader and the sandbox: locked, a passkey asked, or waiting on the browser.
const glyph = computed(() => (stepUp.value ? `key` : waitingInBrowser.value ? `external-link` : `lock`));

// The one line of words under the title, only where a glyph cannot say it: why a passkey is asked after a proof was
// taken, why this window cannot give one, or that the sign-in carries on in the browser.
const stateLine = computed(() => {
    const current = stepUp.value;
    if (current !== undefined) {
        if (!passkeysWork) {
            return t(`sandbox.signInWall.windowCantUsePasskeys`);
        }
        return current.enrolled ? t(`sandbox.signInWall.passkeyAsked`) : t(`sandbox.signInWall.passkeyRequired`);
    }
    return waitingInBrowser.value ? t(`sandbox.signInWall.finishInBrowser`) : undefined;
});

// The way in the card leads with; the others sit under it as a compact row. Google, for an account that has it (its own
// button in a browser, a hand-off from the desktop app); else the email road; else none, and the row stands alone.
const primary = computed<`google` | `email` | undefined>(() => {
    if (waitingInBrowser.value) {
        return undefined;
    }
    if (!withoutGoogle.value) {
        return `google`;
    }
    return emailRoad.value?.kind === `offered` ? `email` : undefined;
});
const emailAlternative = computed(() => primary.value === `google` && emailRoad.value?.kind === `offered`);
const passkeyAlternative = computed(() => passkeyOffered.value && !waitingInBrowser.value);

// The owner's recovery code stays folded behind a quiet link until it is wanted: it is the way back from a lost passkey,
// not a second road beside it.
const recovering = ref(false);
const codeField = ref<HTMLInputElement>();
const startRecovery = async (): Promise<void> => {
    recovering.value = true;
    await nextTick();
    codeField.value?.focus();
};
watch(stepUp, () => {
    recovering.value = false;
});

// A sandbox that has answered before and was not removed: its reader is at work, not in a setup. "Back to setup" sent
// them to the setup page, where the same wall came up again over a line saying the container was cleaned up.
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

// Settles the awaiting mint and returns to its setup, finished on Home, instead of signing in; nothing needs severing.
const backToSetup = async (): Promise<void> => {
    handoff.cancel();
    cancelSignIn();
    dismissSignIn();
    const active = sandbox.activeSandboxId.value;
    await router.push(active === undefined ? ADD_SANDBOX_HOME_PATH : finishOnHome(active));
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
        <div
            v-focustrap
            class="ui-dialog-surface relative w-full max-w-sm overflow-hidden px-6 pb-5 pt-8"
            role="dialog"
            aria-modal="true"
            :aria-label="dialogName"
        >
            <!-- The sandbox's own colour, washed down from the top edge: this card is its door. -->
            <div v-if="wash" class="pointer-events-none absolute inset-x-0 top-0 h-36" :style="wash" aria-hidden="true"></div>

            <div class="relative flex flex-col items-center text-center">
                <!-- Who is opening what, and the state between them: you, a lock (or a key, or the browser), the sandbox. -->
                <div class="flex items-center" aria-hidden="true" data-testid="sign-in-emblem">
                    <template v-if="user">
                        <Avatar :size="44" :src="user.image" :name="user.name" />
                        <span class="w-5 border-t-2 border-dotted border-line-strong"></span>
                    </template>
                    <span
                        class="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line bg-card text-muted shadow-sm"
                        :class="waitingInBrowser ? `motion-safe:animate-pulse` : ``"
                    >
                        <Icon :name="glyph" class="text-sm" />
                    </span>
                    <span class="w-5 border-t-2 border-dotted border-line-strong"></span>
                    <span
                        class="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-xl"
                        :class="opening?.image ? `border border-line bg-card` : opening ? `` : `bg-overlay`"
                        :style="tile"
                    >
                        <!-- `color: inherit` inline, over the logo's own muted ink, so a monogram wears the tile's tint. -->
                        <SandboxLogo
                            :size="44"
                            :image="opening?.image ?? null"
                            :name="opening?.name"
                            class="[&_span]:text-inherit"
                            :style="opening && !opening.image ? { color: `inherit` } : undefined"
                        />
                    </span>
                </div>

                <h2 class="mt-5 break-words text-lg font-semibold leading-snug text-content">{{ heading }}</h2>
                <p v-if="user?.email" class="break-all text-sm text-muted">{{ user.email }}</p>
                <p v-if="stateLine" class="mt-3 text-sm leading-snug text-muted" :role="waitingInBrowser ? `status` : undefined">{{ stateLine }}</p>

                <!-- Nothing to press while the browser has the sign-in: only a refusal would stand here then. -->
                <div v-if="stepUp || !waitingInBrowser || cardNotice" class="mt-6 flex w-full flex-col items-stretch gap-3">
                    <Notice v-if="cardNotice" :of="cardNotice" class="text-left" />

                    <!-- STEP-UP: the proof was taken, the sandbox wants its passkey (or a first one added). -->
                    <template v-if="stepUp">
                        <template v-if="passkeysWork">
                            <Button
                                v-if="stepUp.enrolled"
                                tier="accent"
                                :label="t(`sandbox.signInWall.usePasskey`)"
                                class="w-full justify-center"
                                :loading="busy"
                                @click="usePasskey"
                            >
                                <template #icon><Icon name="key" /></template>
                            </Button>
                            <form v-else class="flex w-full flex-col gap-2" @submit.prevent="addPasskey">
                                <input
                                    v-model="label"
                                    type="text"
                                    autocomplete="off"
                                    :aria-label="t(`sandbox.words.nameEGWork`)"
                                    :placeholder="t(`sandbox.words.nameEGWork`)"
                                    :class="ui.input({ size: `sm` }, `w-full`)"
                                />
                                <Button tier="accent" type="submit" :label="t(`sandbox.words.addPasskey`)" class="w-full justify-center" :loading="busy">
                                    <template #icon><Icon name="key" /></template>
                                </Button>
                            </form>
                        </template>
                        <!-- The owner's way back in from a lost passkey: one of the codes shown when the rule went on. -->
                        <form v-if="isOwner && recovering" class="flex w-full gap-2" @submit.prevent="recover">
                            <input
                                ref="codeField"
                                v-model="code"
                                type="text"
                                autocomplete="off"
                                spellcheck="false"
                                :aria-label="t(`sandbox.signInWall.useRecoveryCode`)"
                                placeholder="xxxxx-xxxxx-xxxxx-xxxxx"
                                :class="ui.input({ size: `sm` }, `min-w-0 flex-1 font-mono`)"
                            />
                            <Button type="submit" :label="t(`sandbox.signInWall.useCode`)" size="small" tier="boring" :disabled="busy || code.trim() === ``" />
                        </form>
                    </template>

                    <!-- CHOOSE: nothing in hand yet. One way in leads; the others sit under it. -->
                    <template v-else>
                        <!-- Google's own button does nothing when clicked inside the desktop app, so that window hands off to
                             the real browser instead, and its button says so with the glyph that leaves the window. -->
                        <template v-if="primary === `google`">
                            <Button v-if="desktop" tier="accent" class="w-full justify-center" @click="signInOutside">
                                <Icon name="google" />
                                <span>{{ t(`auth.words.continueGoogle`) }}</span>
                                <Icon name="external-link" class="text-2xs opacity-70" />
                            </Button>
                            <!-- `color-scheme: light` matches Google's button iframe so the browser paints no opaque canvas behind it. -->
                            <div v-else ref="btn" class="flex justify-center" style="color-scheme: light"></div>
                            <p
                                v-if="!desktop && googleDidntLoad"
                                class="rounded-md bg-overlay px-3 py-2 text-left text-xs leading-snug text-muted"
                                role="note"
                                data-testid="google-didnt-load"
                            >
                                {{ t(`sandbox.signInWall.googleDidntLoad`) }}
                            </p>
                        </template>
                        <!-- The email road leading: the platform vouches for the address above, so nothing else is asked. -->
                        <Button
                            v-else-if="primary === `email`"
                            tier="accent"
                            class="w-full justify-center"
                            :loading="busy"
                            @click="useEmail"
                        >
                            <span>{{ t(`sandbox.signInWall.continue`) }}</span>
                            <Icon name="arrow-right" />
                        </Button>
                        <p v-if="outdatedNote" class="rounded-md bg-overlay px-3 py-2 text-left text-xs leading-snug text-muted" role="note">
                            {{ outdatedNote }}
                        </p>

                        <template v-if="emailAlternative || passkeyAlternative">
                            <div v-if="primary" class="flex items-center gap-3 text-2xs text-subtle" aria-hidden="true">
                                <span class="h-px flex-1 bg-line"></span>{{ t(`sandbox.signInWall.or`) }}<span class="h-px flex-1 bg-line"></span>
                            </div>
                            <div class="flex gap-2">
                                <Button
                                    v-if="passkeyAlternative"
                                    tier="boring"
                                    :label="t(`sandbox.signInWall.passkey`)"
                                    :aria-label="t(`sandbox.signInWall.usePasskey2`)"
                                    class="flex-1 justify-center"
                                    :loading="busy"
                                    @click="usePasskey"
                                >
                                    <template #icon><Icon name="key" /></template>
                                </Button>
                                <Button
                                    v-if="emailAlternative"
                                    tier="boring"
                                    :label="t(`sandbox.signInWall.email`)"
                                    :aria-label="t(`sandbox.signInWall.continueWithEmail`)"
                                    class="flex-1 justify-center"
                                    :loading="busy"
                                    @click="useEmail"
                                >
                                    <template #icon><Icon name="envelope" /></template>
                                </Button>
                            </div>
                        </template>
                    </template>
                </div>

                <!-- The way out. A working sandbox's reader stays where they are; only a setup has a setup to go back to,
                     and only the owner's: finishing a sandbox a member doesn't own would start a new one on their account. -->
                <div class="mt-5 flex w-full flex-wrap items-center justify-center gap-x-6 gap-y-2">
                    <button v-if="waitingInBrowser && !stepUp" type="button" :class="ui.textButton()" @click="signInOutside">
                        {{ t(`sandbox.signInWall.openBrowser`) }}
                        <Icon name="external-link" class="text-2xs" />
                    </button>
                    <button v-if="stepUp && isOwner && !recovering" type="button" :class="ui.textButton({ tone: `subtle` })" @click="startRecovery">
                        {{ t(`sandbox.signInWall.useRecoveryCode`) }}
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
