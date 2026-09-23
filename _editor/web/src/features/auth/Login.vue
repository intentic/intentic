<!-- Sign-in screen; shares its visual material with /setup via @intentic/entry-css so the two stay in one style. -->
<script setup lang="ts">
import { AppBrand, Button, vAction } from "@intentic/ui";
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useAuth } from "./useAuth";
import { useGoogleIdentity } from "./useGoogleIdentity";
import { desktopVersion, signInThroughBrowser } from "../../app/environments/desktop";
import { desktopInstaller } from "../../app/environments/desktopDownloads";
import { returnPath } from "../../router/signIn";
import { useT } from "@intentic/ui/i18n";

const t = useT();

const { signInWithGoogle, signInWithGoogleCredential } = useAuth();
const { getIdToken, renderButton } = useGoogleIdentity();
const router = useRouter();
const route = useRoute();

// Where the guard sent this visitor; sanitized as both a router push and an OAuth callback (router/signIn.ts).
const destination = computed(() => returnPath(route.query[`returnTo`]));

// True in the desktop webview, where Google can't run; sign-in there hands off to the real browser instead.
const desktop = computed(() => desktopVersion() !== undefined);

// Mirrors the site's 'Getting started' band, in order; the current step makes this a rail, not a list.
// The third step must match `desktopInstaller()`, the same call the setup page uses, so the two screens agree.
// Titles only: a station on a rail names where you are, and the sentences under them cost this screen the
// height that put a scrollbar on the desktop window.
const install = desktopInstaller();
const steps: readonly string[] = [`Sign in with Google`, `Your sandbox is waiting`, install === undefined ? `Paste one command` : `Install the app`];

// Mints one Google credential and spends it on both the platform and the sandbox, removing the second ask; the
// credential the sandbox gets is unchanged. The escape link is unconditional because one failure mode (a button
// that renders but can't be clicked) is invisible from here.
const googleButton = ref<HTMLElement>();
// Whether Google's button shows; true so the container exists to render into, false once refused or rejected.
const googleReady = ref(true);
const error = ref<string>();

const redirectSignIn = async (): Promise<void> => {
    if (desktop.value) {
        signInThroughBrowser();
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
        await signInWithGoogleCredential(idToken);
        await router.push(destination.value);
    } catch {
        // The platform can refuse a token Google actually signed (no endpoint, client-id mismatch); the redirect
        // doesn't
        // depend on it, so offer that instead of a dead end. The credential stays cached, since the sandbox may accept
        // what the platform just refused.
        googleReady.value = false;
        error.value = `Couldn't finish that sign-in. Continue with Google below instead.`;
    }
};

onMounted(() => void signInWithCredential());

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
                    ><span class="entry-display">{{ t(`shared.signIn`) }}</span
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

                <p v-if="error" class="gate-error">{{ error }}</p>

                <!-- Google's button also supplies the sandbox credential, one sign-in for both. -->
                <div v-show="googleReady" class="entry-socket">
                    <div ref="googleButton" class="entry-socket-slot"></div>
                </div>

                <!-- The site's primary button style (@intentic/entry-css), shown only when Google's embedded button could not render. -->
                <Button
                    v-if="!googleReady"
                    :label="desktop ? t(`shared.continueGoogleInBrowser`) : t(`shared.continueGoogle`)"
                    class="w-full justify-center"
                    @click="redirectSignIn"
                >
                    <template #icon><Icon name="google" /></template>
                </Button>

                <!-- Embedded-button failures are handled by the direct login path. -->
                <button v-if="googleReady && !desktop" type="button" class="escape" v-action="redirectSignIn">
                    {{ t(`shared.troubleSigningInUse`) }}
                </button>

                <p class="fine">
                    {{ t(`auth.login.weKeepEmailAddress`) }}
                    <!-- Named separately from Terms since breaching it can destroy a hosted machine without notice. -->
                    <a href="https://intentic.dev/terms/" target="_blank" rel="noopener">{{ t(`auth.login.terms`) }}</a
                    >, <a href="https://intentic.dev/acceptable-use/" target="_blank" rel="noopener">{{ t(`auth.login.acceptableUsePolicy`) }}</a>
                    {{ t(`shared.and`) }}
                    <a href="https://intentic.dev/privacy/" target="_blank" rel="noopener">{{ t(`auth.login.privacyPolicy`) }}</a
                    >.
                </p>
            </section>

            <section class="rail">
                <p class="entry-eyebrow eyebrow-bare">{{ t(`auth.login.threeStepsToFirst`) }}</p>
                <ol class="steps">
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

.gate-error {
    margin-bottom: 1.25rem;
    padding: 0.7rem 0.9rem;
    border-left: 2px solid var(--ember);
    background: color-mix(in srgb, var(--ember) 8%, transparent);
    font-size: 0.8125rem;
    line-height: 1.5;
    text-align: left;
    color: var(--ink);
}

.escape {
    display: block;
    width: 100%;
    margin-top: 1rem;
    font-size: 0.75rem;
    color: var(--ink-subtle);
    cursor: pointer;
    transition: color 0.2s ease;
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
    grid-template-columns: repeat(3, minmax(0, 1fr));
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
