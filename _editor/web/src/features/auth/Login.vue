<!-- Sign-in screen; shares its visual material with /setup via @intentic/entry-css so the two stay in one style. -->
<script setup lang="ts">
import { AppBrand, Button, vAction } from "@intentic/ui";
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useAuth } from "../../client/auth/useAuth";
import type { SignInOptions } from "@intentic/api-contract";
import { useBrowserHandoff } from "./browserHandoff";
import EmailCodeSignIn from "./EmailCodeSignIn.vue";
import { hasFedCm, useGooglePress } from "./googlePress";
import { GOOGLE_ONLY, readSignInOptions } from "./signInOptions";
import { useGoogleIdentity } from "../../client/auth/useGoogleIdentity";
import { desktopVersion, openThisComputer } from "../../app/environments/desktop";
import { desktopInstaller } from "../../app/environments/desktopDownloads";
import { inNativeShell } from "../../workbench/window/capacitor";
import { returnPath } from "../../lib/routes/signIn";
import { useT } from "@intentic/ui/i18n";

const t = useT();

const { signInWithGoogle, signInWithGoogleCredential } = useAuth();
const { getIdToken, renderButton, refusedCredentials } = useGoogleIdentity();
const router = useRouter();
const route = useRoute();

// Where the guard sent this visitor; sanitized as both a router push and an OAuth callback (lib/routes/signIn.ts).
const destination = computed(() => returnPath(route.query[`returnTo`]));

// True in the desktop webview, where Google can't run; sign-in there hands off to the real browser instead.
const desktop = computed(() => desktopVersion() !== undefined);
// A window whose mail links open somewhere else (the desktop webview, the iOS shell): the emailed code runs in place,
// typed rather than followed, so it needs no hand-off at all.
const inApp = computed(() => desktop.value || inNativeShell());

// Which ways in this platform offers; Google alone until it says, which is what every platform before email offered.
const options = ref<SignInOptions>(GOOGLE_ONLY);
onMounted(async () => {
    options.value = await readSignInOptions();
});

// Mirrors the site's 'Getting started' band, in order; the current step makes this a rail, not a list.
// The third step must match `desktopInstaller()`, the same call the setup page uses, so the two screens agree.
// Titles only: a station on a rail names where you are, and the sentences under them cost this screen the
// height that put a scrollbar on the desktop window. Inside the installed app the third is behind the reader already,
// so it is not offered as the step still to come.
const install = desktopInstaller();
const steps = computed<readonly string[]>(() => {
    const signIn = options.value.email ? t(`auth.login.stepSignInAnyWay`) : t(`auth.login.stepSignIn`);
    return desktop.value
        ? [signIn, t(`auth.login.stepSandboxWaiting`)]
        : [signIn, t(`auth.login.stepSandboxWaiting`), install === undefined ? t(`auth.login.stepPasteCommand`) : t(`auth.login.stepInstallApp`)];
});

// Mints one Google credential and spends it on both the platform and the sandbox, removing the second ask; the
// credential the sandbox gets is unchanged. The road around it is offered unconditionally because one failure mode (a
// button that renders but can't be clicked) is invisible from here; a press that went nowhere is seen only afterwards.
const googleButton = ref<HTMLElement>();
// Whether Google's button shows; true so the container exists to render into, false once refused or rejected.
const googleReady = ref(true);
const error = ref<string>();

// A press on Google's button that comes back with no answer (googlePress.ts).
const press = useGooglePress(googleButton, `login`);
// No FedCM: Google's button opens a pop-up that can fail without a word, so the road around it is a real button from
// the first frame here, not the small print under it.
const popupOnly = !hasFedCm();
// Google answered and the answer was refused (most often a clock set wrong, which puts a fresh token past its expiry).
// The button still waits for a press, but the reader is told why that one did not sign in, and given the road that does
// not depend on this machine's clock.
const refused = ref(false);
watch(refusedCredentials, () => {
    refused.value = true;
    press.answered();
});
// What the page says once Google's button has failed in front of the reader; undefined while it has not.
const stallNote = computed(() =>
    refused.value ? t(`auth.words.googleAnswerRefused`) : press.stalled.value ? t(`auth.words.googleDidntComeBack`) : undefined,
);

// The desktop window's wait for the browser (browserHandoff.ts), drawn in the button's place.
const handoff = useBrowserHandoff();
const handoffWaiting = handoff.waiting;

const redirectSignIn = async (): Promise<void> => {
    if (desktop.value) {
        handoff.start();
        return;
    }
    await signInWithGoogle(destination.value);
};

// Started on mount so a click has something to resolve, and a returning user needs none at all (Google's silent
// re-auth). Only fires for someone who's signed in this way before; a first-time visitor still sees the visible
// button and consent line.
const signInWithCredential = async (): Promise<void> => {
    // The mechanism refuses this window anyway; skip loading Google's script where it can never be used.
    if (desktop.value) {
        return;
    }
    try {
        // `gate: false`: this page's own button is the gate; the shared overlay would be a second one.
        const idToken = await getIdToken({ gate: false });
        if (idToken === undefined) {
            return; // Dismissed, or Google unavailable; the fallback is already on screen.
        }
        press.answered();
        await signInWithGoogleCredential(idToken);
        await router.push(destination.value);
    } catch {
        // The platform can refuse a token Google actually signed (no endpoint, client-id mismatch); the redirect
        // doesn't
        // depend on it, so offer that instead of a dead end. The credential stays cached, since the sandbox may accept
        // what the platform just refused.
        googleReady.value = false;
        error.value = t(`auth.login.signInDidntFinish`);
    }
};

onMounted(() => void signInWithCredential());

// The emailed code signed this window in: on to where the guard was sending the reader, as Google's road goes.
const arrive = async (): Promise<void> => {
    await router.push(destination.value);
};

// Always rendered in light theme, never following the app's scheme: this screen has one near-black ground, and a
// light button is the only light-on-dark object needing the visitor's attention.
watch(
    googleButton,
    async () => {
        if (googleButton.value === undefined) {
            return;
        }
        googleReady.value = await renderButton(googleButton.value, false);
    },
    { flush: `post` },
);
</script>

<template>
    <div class="entry door">
        <!-- Pinned to a fixed 16:9 across the full width so the two figures stay whole; the bottom crops instead, into the fade below. -->
        <div class="entry-plate" aria-hidden="true"><div class="entry-plate-img"></div></div>

        <!-- The way back in the desktop app, whose workspace window opens here when it holds no session (the local
             window's "Your workspace"): this screen is outside the shell and its sandbox switcher, and the window has
             no frame of its own, so without this the only way off it is a sign-in. In the band the window's own
             buttons sit in, at the other end. -->
        <div v-if="desktop" class="back-band">
            <Button :label="t(`shared.backToThisComputer`)" tier="quiet" class="back" @click="openThisComputer">
                <template #icon><Icon name="arrow-left" /></template>
            </Button>
        </div>

        <main class="shell">
            <header class="mark"><AppBrand /></header>

            <!-- Flanked, not underlined: a trailing hairline would tip sideways on this centred axis. -->
            <p class="entry-eyebrow">
                <span class="entry-lozenge"></span>
                <span>{{ t(`auth.login.welcomeToIntentic`) }}</span>
                <span class="entry-lozenge"></span>
            </p>

            <h1 class="headline">
                <span class="beat"
                    ><span class="entry-display">{{ t(`ui.action.signIn`) }}</span
                    ><span class="entry-stop">.</span></span
                >
                <span class="beat"
                    ><span class="entry-display">{{ t(`auth.login.buildAgents`) }}</span
                    ><span class="entry-stop">.</span></span
                >
            </h1>

            <p class="hero-sub">{{ t(`auth.login.workspaceCodingAgents`) }}</p>

            <!-- The one framed object here; the turned corner and lotus finial only appear on a panel big enough to carry them. -->
            <section class="entry-frame gate">
                <span class="entry-corner entry-corner-tl"></span>
                <span class="entry-corner entry-corner-tr"></span>
                <span class="entry-corner entry-corner-bl"></span>
                <span class="entry-corner entry-corner-br"></span>
                <span class="entry-finial" aria-hidden="true"><AppBrand shape="mark" /></span>

                <!-- A live region standing from the first frame, so a note that appears in it is read out, not just drawn. -->
                <div role="status">
                    <p v-if="error" class="gate-error">{{ error }}</p>
                    <p v-else-if="stallNote" class="gate-error">{{ stallNote }}</p>
                </div>

                <!-- Google's button also supplies the sandbox credential, one sign-in for both. Left out only on a platform
                     that says it offers no Google sign-in at all. -->
                <template v-if="options.google">
                    <div v-show="googleReady" class="entry-socket">
                        <div ref="googleButton" class="entry-socket-slot"></div>
                    </div>

                    <!-- The desktop app after the press: the sign-in is in the browser now, and this window says so until it returns. -->
                    <div v-if="desktop && handoffWaiting" class="handoff" role="status">
                        <p class="handoff-title">{{ t(`auth.words.finishInBrowser`) }}</p>
                        <p class="handoff-detail">{{ t(`auth.words.finishInBrowserDetail`) }}</p>
                        <Button :label="t(`auth.words.openBrowserAgain`)" tier="boring" class="w-full justify-center" @click="handoff.start">
                            <template #icon><Icon name="google" /></template>
                        </Button>
                        <button type="button" class="escape" @click="handoff.cancel">{{ t(`ui.action.cancel`) }}</button>
                    </div>

                    <!-- The site's primary button style (@intentic/entry-css), shown only when Google's embedded button could not render. -->
                    <Button
                        v-else-if="!googleReady"
                        :label="desktop ? t(`auth.words.continueGoogleInBrowser`) : t(`auth.words.continueGoogle`)"
                        class="w-full justify-center"
                        @click="redirectSignIn"
                    >
                        <template #icon><Icon name="google" /></template>
                    </Button>

                    <!-- The road around Google's button as a real button: the page's primary action once that button has failed
                         in front of the reader, and a secondary one from the start where it can only open a pop-up. -->
                    <Button
                        v-else-if="!desktop && (stallNote || popupOnly)"
                        :label="t(`auth.words.continueOnGooglesPage`)"
                        :tier="stallNote ? `accent` : `boring`"
                        class="mt-4 w-full justify-center"
                        @click="redirectSignIn"
                    >
                        <template #icon><Icon name="google" /></template>
                    </Button>

                    <!-- Embedded-button failures are handled by the direct login path. -->
                    <button v-else-if="googleReady && !desktop" type="button" class="escape" v-action="redirectSignIn">
                        {{ t(`auth.words.troubleSigningInUse`) }}
                    </button>
                </template>

                <!-- The second way in, under Google's: a code mailed to any address. Inside the app it runs in place (the
                     code is typed), so it stays while Google's sign-in waits in the browser. -->
                <template v-if="options.email">
                    <p v-if="options.google" class="or" aria-hidden="true">
                        <span>{{ t(`auth.login.or`) }}</span>
                    </p>
                    <EmailCodeSignIn :in-app="inApp" :google-offered="options.google" @signed-in="arrive" />
                </template>

                <p class="fine">
                    {{ t(`auth.login.weKeepEmailAddress`) }}
                    <!-- Named separately from Terms since breaching it can destroy a hosted machine without notice. -->
                    <a href="https://intentic.dev/terms/" target="_blank" rel="noopener">{{ t(`auth.login.terms`) }}</a
                    >, <a href="https://intentic.dev/acceptable-use/" target="_blank" rel="noopener">{{ t(`auth.login.acceptableUsePolicy`) }}</a>
                    {{ t(`auth.login.and`) }}
                    <a href="https://intentic.dev/privacy/" target="_blank" rel="noopener">{{ t(`auth.login.privacyPolicy`) }}</a
                    >.
                </p>
            </section>

            <section class="rail">
                <p class="entry-eyebrow eyebrow-bare">{{ desktop ? t(`auth.login.twoStepsToFirst`) : t(`auth.login.threeStepsToFirst`) }}</p>
                <ol class="steps" :style="{ '--steps': steps.length }">
                    <li v-for="(step, index) in steps" :key="step" class="step" :aria-current="index === 0 ? `step` : undefined">
                        <span class="entry-lozenge"></span>
                        <h2>{{ step }}</h2>
                    </li>
                </ol>
            </section>
        </main>
    </div>
</template>

<style scoped>
/* This file contains only login layout; shared materials live in @intentic/entry-css — the desktop window's title strip
   included, which both entry screens clear there rather than each for itself. */
.door {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: clamp(1rem, 2.5vw, 2rem) 1.5rem;
}

/* Out of the flow, so it costs the door none of the height a short window has to spare, and centred on the title band's
   height, level with the window's own buttons in the opposite corner. */
.back-band {
    position: absolute;
    top: 0;
    left: 0.5rem;
    display: flex;
    align-items: center;
    height: var(--bar-height);
}
.back {
    font-size: 0.8125rem;
}

/* The empty axis in the art. */
.shell {
    display: flex;
    flex-direction: column;
    align-items: center;
    width: 100%;
    max-width: 46rem;
    margin: auto;
    text-align: center;
}

.mark {
    font-size: 1.375rem;
    margin-bottom: clamp(1rem, 3vh, 1.75rem);
}

/* Two one-sentence beats; capped well below the site's own display size, since this screen has a door to fit under
   it, not a whole screen. The `vh` arm only binds on a SHORT window — 6.4vh passes 3.4rem at 850px of height — so a
   desktop window the user has dragged flat shrinks the display instead of growing a scrollbar. */
.headline {
    margin: 1.25rem 0 0;
    font-family: var(--face-display);
    font-size: clamp(1.75rem, min(7.2vw, 6.4vh), 3.4rem);
    line-height: 1.24;
    font-weight: var(--font-weight-semibold);
}
/* Splits on the sentence, not just wraps, so each ember stop lands at the end of a thought. */
.beat {
    display: block;
    text-wrap: balance;
}

/* Ported verbatim from `.home .hero-sub` in home.css. */
.hero-sub {
    margin: 0.9rem auto 0;
    max-width: 36ch;
    font-size: 1.15rem;
    line-height: 1.6;
    color: var(--ink-lede);
    text-wrap: balance;
}

/* The frame kit's box at this screen's size; the double rule, plate, and drop belong to `.entry-frame`. */
.gate {
    width: 100%;
    max-width: 27rem;
    margin-top: clamp(1.25rem, 3.5vh, 2rem);
    padding: 1.75rem 2rem 1.25rem;
}

/* The desktop window's wait for the browser: the gate's own words, then the two ways on. */
.handoff {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
}
.handoff-title {
    font-size: 1rem;
    font-weight: var(--font-weight-semibold);
    color: var(--ink);
}
.handoff-detail {
    font-size: 0.8125rem;
    line-height: 1.5;
    color: var(--ink-subtle);
}

/* The ember wash alone marks it, a shade deeper for having no edge stripe to lean on. */
.gate-error {
    margin-bottom: 1.25rem;
    padding: 0.7rem 0.9rem;
    background: color-mix(in srgb, var(--ember) 12%, transparent);
    font-size: 0.8125rem;
    line-height: 1.5;
    text-align: left;
    color: var(--ink);
}

/* A hairline either side of the word, as the eyebrow's lozenges flank theirs: the two ways in are peers, not a list. */
.or {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin: 1.25rem 0 1rem;
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

.escape {
    display: block;
    width: 100%;
    margin-top: 1rem;
    font-size: 0.75rem;
    color: var(--ink-subtle);
    cursor: pointer;
    transition: color var(--motion-hover);
}
.escape:hover {
    color: var(--ink);
}

.fine {
    margin-top: 1.1rem;
    padding-top: 1rem;
    border-top: 1px solid var(--rule);
    font-size: 0.75rem;
    line-height: 1.7;
    color: var(--ink-subtle);
    text-wrap: pretty;
}
.fine a {
    color: var(--gold-bright);
}
.fine a:hover {
    text-decoration: underline;
}

/* Three stations on one hairline; ember marks the current step, quiet gold marks the ones ahead. */
.rail {
    width: 100%;
    margin-top: clamp(1.5rem, 4vh, 2.25rem);
}
.eyebrow-bare {
    color: var(--ink-subtle);
}
.steps {
    display: grid;
    grid-template-columns: repeat(var(--steps, 3), minmax(0, 1fr));
    gap: 1.75rem;
    margin-top: 1.25rem;
    padding-top: 1.25rem;
    border-top: 1px solid var(--rule-strong);
    text-align: left;
}
.step {
    position: relative;
}
/* The mark sits on the rail, not under it, so the row reads as one line with three stops rather than separate cards. */
.step .entry-lozenge {
    position: absolute;
    top: calc(-1.25rem - 0.325rem);
    left: 0;
    width: 0.65rem;
    height: 0.65rem;
    color: var(--ink-subtle);
}
.step[aria-current="step"] .entry-lozenge {
    color: var(--ember);
    filter: var(--house-ember-mark-glow);
}
.step h2 {
    font-family: var(--face-mark);
    font-size: 0.9375rem;
    font-weight: var(--font-weight-semibold);
    color: var(--ink);
}
.step[aria-current="step"] h2 {
    color: var(--gold-bright);
}

@media (max-width: 40rem) {
    .steps {
        grid-template-columns: minmax(0, 1fr);
        gap: 1.5rem;
        padding-top: 0;
        border-top: 0;
        /* No rail to hang marks off in one column, so each station gets its own left-hand rule instead. */
        border-left: 1px solid var(--rule);
        padding-left: 1.5rem;
    }
    .step .entry-lozenge {
        position: absolute;
        top: 0.3rem;
        left: calc(-1.5rem - 0.275rem);
    }
    /* Google's own button sizes itself and is the widest fixed element; narrowing the slot keeps it a comfortable width on a phone. */
    .door {
        padding-left: 1rem;
        padding-right: 1rem;
    }
    .gate {
        padding-left: 1.25rem;
        padding-right: 1.25rem;
    }
    .entry-socket {
        padding-left: 0.5rem;
        padding-right: 0.5rem;
    }
}
</style>
