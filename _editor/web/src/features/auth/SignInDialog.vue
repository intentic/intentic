<!-- The desktop app's sign-in, over the view the reader is on (signInDialog.ts says when and why): /login's own door, cut
     down to the frame, and drawn in the same entry material, so the two read as one place in either light. -->
<script setup lang="ts">
import type { SignInOptions } from "@intentic/api-contract";
import { AppBrand, Button, Notice } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import FocusTrap from "primevue/focustrap";
import { computed, nextTick, ref, useId, watch } from "vue";
import { useBrowserHandoff } from "./browserHandoff";
import EmailCodeSignIn from "./EmailCodeSignIn.vue";
import { dismissSignIn, signedIn, signInAsk } from "./signInDialog";
import { GOOGLE_ONLY, readSignInOptions } from "./signInOptions";

const t = useT();

const ask = signInAsk;
const arriving = computed(() => ask.value?.stage.kind === `arriving`);
const notice = computed(() => (ask.value?.stage.kind === `choose` ? ask.value.stage.notice : undefined));
const lapsed = computed(() => ask.value?.reason === `lapsed`);

const lede = computed(() => {
    switch (ask.value?.reason) {
        case `lapsed`:
            return t(`auth.signInDialog.ledeLapsed`);
        case `needed`:
            return t(`auth.signInDialog.ledeNeeded`);
        default:
            return t(`auth.signInDialog.ledeAsked`);
    }
});

// Which ways in the platform offers, asked the first time the dialog comes up: Google alone until it says.
const options = ref<SignInOptions>(GOOGLE_ONLY);
let optionsRead = false;

// Google cannot run in the app's webview, so its sign-in goes to the default browser and comes back by itself; until it
// does, the dialog says where it went, and can open it again (browserHandoff.ts).
const handoff = useBrowserHandoff();
const waiting = handoff.waiting;
const continueInBrowser = (): void => {
    const current = ask.value;
    if (current !== undefined) {
        handoff.start(current.returnTo);
    }
};

// The emailed code signed this window in where it stands: on to where the ask was going.
const arrive = async (): Promise<void> => {
    await signedIn(ask.value?.returnTo ?? `/`);
};

const notNow = (): void => {
    if (!arriving.value) {
        dismissSignIn();
    }
};

const titleId = useId();
const ledeId = useId();
// Tab stays inside while it is up, as in every <Modal>.
const vFocustrap = FocusTrap;
const surface = ref<HTMLElement>();

// The keyboard goes to the dialog as it comes up, and back to what had it when it goes.
let returnFocus: HTMLElement | undefined;
watch(
    () => ask.value !== undefined,
    async (open) => {
        if (open) {
            returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
            if (!optionsRead) {
                optionsRead = true;
                options.value = await readSignInOptions();
            }
            await nextTick();
            surface.value?.focus();
            return;
        }
        returnFocus?.focus();
        returnFocus = undefined;
    },
    { immediate: true },
);
</script>

<template>
    <Teleport to="body">
        <Transition name="sign-in-dialog">
            <!-- Over everything the page has, the app's own dialogs included: a sign-in that stood behind one would wait unseen. -->
            <div
                v-if="ask"
                class="sign-in-scrim ui-scrim fixed inset-0 z-[1150] flex overflow-y-auto p-4 sm:p-6"
                data-testid="sign-in-dialog"
                @keydown.esc.stop="notNow"
            >
                <section
                    ref="surface"
                    v-focustrap
                    class="entry sign-in entry-frame"
                    :class="{ 'sign-in-arriving': arriving }"
                    role="dialog"
                    aria-modal="true"
                    :aria-labelledby="titleId"
                    :aria-describedby="arriving ? undefined : ledeId"
                    tabindex="-1"
                >
                    <span class="entry-corner entry-corner-tl"></span>
                    <span class="entry-corner entry-corner-tr"></span>
                    <span class="entry-corner entry-corner-bl"></span>
                    <span class="entry-corner entry-corner-br"></span>
                    <span class="entry-finial" aria-hidden="true"><AppBrand shape="mark" /></span>

                    <!-- THE HAND-OFF COMING BACK: one wait, with nothing to press. -->
                    <div v-if="arriving" class="arrival" role="status">
                        <div class="entry-seal entry-seal-turning" aria-hidden="true">
                            <span class="entry-seal-ring"></span>
                            <span class="entry-seal-sweep"></span>
                            <AppBrand shape="mark" class="entry-seal-mark" />
                        </div>
                        <h2 :id="titleId" class="arrival-say">{{ t(`auth.desktopAuthComplete.signingIn`) }}</h2>
                    </div>

                    <template v-else>
                        <!-- Flanked, not underlined, as on /login. -->
                        <p class="entry-eyebrow eyebrow">
                            <span class="entry-lozenge"></span>
                            <span>{{ lapsed ? t(`auth.signInDialog.sessionEnded`) : t(`auth.login.welcomeToIntentic`) }}</span>
                            <span class="entry-lozenge"></span>
                        </p>
                        <h2 :id="titleId" class="headline">
                            <span class="entry-display">{{ lapsed ? t(`auth.signInDialog.signInAgain`) : t(`ui.action.signIn`) }}</span
                            ><span class="entry-stop">.</span>
                        </h2>
                        <p :id="ledeId" class="lede">{{ lede }}</p>

                        <!-- A live region from the first frame, so a refusal that appears in it is read out. -->
                        <div role="status" class="w-full">
                            <Notice v-if="notice" :of="notice" class="mb-4 rounded-none text-left" />
                        </div>

                        <template v-if="options.google">
                            <!-- After the press: the sign-in is in the browser now, and this says so until it returns. -->
                            <div v-if="waiting" class="handoff" role="status">
                                <p class="handoff-title">{{ t(`auth.words.finishInBrowser`) }}</p>
                                <p class="handoff-detail">{{ t(`auth.words.finishInBrowserDetail`) }}</p>
                                <div class="handoff-actions">
                                    <Button :label="t(`auth.words.openBrowserAgain`)" tier="boring" @click="continueInBrowser">
                                        <template #icon><Icon name="external-link" /></template>
                                    </Button>
                                    <Button :label="t(`ui.action.cancel`)" tier="quiet" @click="handoff.cancel" />
                                </div>
                            </div>
                            <Button tier="accent" v-else :label="t(`auth.words.continueGoogleInBrowser`)" class="w-full justify-center" @click="continueInBrowser">
                                <template #icon><Icon name="google" /></template>
                            </Button>
                        </template>

                        <!-- The second way in: a code mailed to any address, typed here, so it stays while Google waits in the browser. -->
                        <template v-if="options.email">
                            <p v-if="options.google" class="or" aria-hidden="true">
                                <span>{{ t(`auth.login.or`) }}</span>
                            </p>
                            <EmailCodeSignIn in-app :google-offered="options.google" @signed-in="arrive" />
                        </template>

                        <p class="fine">
                            {{ t(`auth.login.weKeepEmailAddress`) }}
                            <a href="https://intentic.dev/terms/" target="_blank" rel="noopener">{{ t(`auth.login.terms`) }}</a
                            >, <a href="https://intentic.dev/acceptable-use/" target="_blank" rel="noopener">{{ t(`auth.login.acceptableUsePolicy`) }}</a>
                            {{ t(`auth.login.and`) }}
                            <a href="https://intentic.dev/privacy/" target="_blank" rel="noopener">{{ t(`auth.login.privacyPolicy`) }}</a
                            >.
                        </p>

                        <!-- The way out, always there: the reader stays on the view behind (Home's first run, after a lapse). -->
                        <Button :label="t(`auth.signInDialog.notNow`)" tier="quiet" class="not-now" @click="notNow" />
                    </template>
                </section>
            </div>
        </Transition>
    </Teleport>
</template>

<style scoped>
/* Layout only: the frame, its corners and finial, the seal and every colour are the entry material (@intentic/entry-css).
   What this undoes is the part of `.entry` that is about being a whole screen: its height, its ground, and the title
   band a frameless window keeps clear at the top of one. */
.entry.sign-in {
    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    width: 100%;
    max-width: 27rem;
    min-height: 0;
    margin: auto;
    padding: 2.25rem 2rem 1rem;
    background: var(--plate);
    text-align: center;
    outline: none;
}
/* The wait is one object, not a form: the frame closes in round it. */
.entry.sign-in.sign-in-arriving {
    max-width: 20rem;
    padding: 2.5rem 2rem 2rem;
}

/* The scrim scrolls a short window rather than cropping the frame: `margin: auto` above centres it while there is room. */
.sign-in-scrim {
    align-items: flex-start;
}

.eyebrow {
    color: var(--gold);
}

/* /login's display line at a dialog's size. */
.headline {
    margin: 0.85rem 0 0;
    font-family: var(--face-display);
    font-size: clamp(1.75rem, 5.5vh, 2.25rem);
    line-height: 1.2;
    font-weight: var(--font-weight-semibold);
}

.lede {
    margin: 0.6rem auto 1.5rem;
    max-width: 36ch;
    font-size: 0.9375rem;
    line-height: 1.55;
    color: var(--ink-lede);
    text-wrap: balance;
}

/* The wait for the browser: the frame's own words, then the two ways on. */
.handoff {
    display: flex;
    width: 100%;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.9rem 1rem;
    border: 1px solid var(--rule);
    background: color-mix(in oklab, var(--rule) 30%, transparent);
    text-align: left;
}
.handoff-title {
    font-size: 0.9375rem;
    font-weight: var(--font-weight-semibold);
    color: var(--ink);
}
.handoff-detail {
    font-size: 0.8125rem;
    line-height: 1.5;
    color: var(--ink-subtle);
}
.handoff-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-top: 0.25rem;
}

/* A hairline either side of the word, as on /login: the two ways in are peers, not a list. */
.or {
    display: flex;
    width: 100%;
    align-items: center;
    gap: 0.75rem;
    margin: 1.1rem 0 0.9rem;
    font-size: 0.6875rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--ink-subtle);
}
.or::before,
.or::after {
    content: "";
    flex: 1;
    border-top: 1px solid var(--rule);
}

.fine {
    margin-top: 1.1rem;
    padding-top: 0.9rem;
    border-top: 1px solid var(--rule);
    font-size: 0.75rem;
    line-height: 1.65;
    color: var(--ink-subtle);
    text-wrap: pretty;
}
.fine a {
    color: var(--gold-bright);
    text-decoration: underline;
}

.not-now {
    margin-top: 0.5rem;
}

.arrival {
    display: flex;
    flex-direction: column;
    align-items: center;
}
.arrival-say {
    font-family: var(--face-read);
    font-size: 0.9375rem;
    font-weight: var(--font-weight-medium);
    color: var(--ink-muted);
}

/* In and out: the scrim fades, the frame rises a little into place. */
.sign-in-dialog-enter-active,
.sign-in-dialog-leave-active {
    transition: opacity var(--motion-base, 200ms) var(--ease-smooth, ease);
}
.sign-in-dialog-enter-active .sign-in,
.sign-in-dialog-leave-active .sign-in {
    transition:
        transform var(--motion-base, 200ms) var(--ease-smooth, ease),
        opacity var(--motion-base, 200ms) var(--ease-smooth, ease);
}
.sign-in-dialog-enter-from,
.sign-in-dialog-leave-to {
    opacity: 0;
}
.sign-in-dialog-enter-from .sign-in,
.sign-in-dialog-leave-to .sign-in {
    opacity: 0;
    transform: translateY(0.5rem) scale(0.985);
}
/* Still, under the Appearance setting's reduced motion (ui/motion, which answers for the OS too): only the fade. */
:root[data-motion="reduced"] .sign-in-dialog-enter-from .sign-in,
:root[data-motion="reduced"] .sign-in-dialog-leave-to .sign-in {
    transform: none;
}
</style>
