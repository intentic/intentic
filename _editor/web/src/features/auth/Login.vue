<!--
    Sign-in screen; shares its visual material with /setup via styles/entry.css so the two stay in one style. Centred layout, unlike the app's other
    entry screens, which split. Always renders dark, regardless of the app's theme.
-->
<script setup lang="ts">
import { Button, vAction } from "@intentic/ui";
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import AppBrand from "../../components/AppBrand.vue";
import { useAuth } from "./useAuth";
import { useGoogleIdentity } from "./useGoogleIdentity";
import { useSiteFaces } from "../../shell/useSiteFaces";
import { desktopInstaller, desktopVersion, signInThroughBrowser } from "../../app/environments/desktop";
import { returnPath } from "../../router/signIn";

const { signInWithGoogle, signInWithGoogleCredential } = useAuth();
const { getIdToken, renderButton } = useGoogleIdentity();
const router = useRouter();
const route = useRoute();

// Where the guard sent this visitor; sanitized as both a router push and an OAuth callback (router/signIn.ts).
const destination = computed(() => returnPath(route.query[`returnTo`]));

// The site's faces, only on this route and /setup; see composables/useSiteFaces.ts.
useSiteFaces();

// True in the desktop webview, where Google can't run; sign-in there hands off to the real browser instead.
const desktop = computed(() => desktopVersion() !== undefined);

const year = new Date().getFullYear();

// Mirrors the site's 'Getting started' band, in order; the current step makes this a rail, not a list.
// The third step must match `desktopInstaller()`, the same call the setup page uses, so the two screens agree.
const install = desktopInstaller();
const steps: readonly { title: string; body: string }[] = [
    { title: `Sign in with Google`, body: `No forms and no card.` },
    { title: `Your sandbox is waiting`, body: `The private room your agents live and work in, with a web address of its own.` },
    install === undefined
        ? { title: `Paste one command`, body: `One line starts it on your own machine.` }
        : { title: `Install the app`, body: `One click starts it on your own machine. No terminal.` },
];

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
        <!--
            Pinned to a fixed 16:9 across the full width so the two figures stay whole; the bottom crops instead, into
            the
            fade below.
        -->
        <div class="entry-plate" aria-hidden="true"><div class="entry-plate-img"></div></div>

        <main class="shell">
            <header class="mark"><AppBrand /></header>

            <!-- Flanked, not underlined: a trailing hairline would tip sideways on this centred axis. -->
            <p class="entry-eyebrow">
                <span class="entry-lozenge"></span>
                <span>Welcome to intentic</span>
                <span class="entry-lozenge"></span>
            </p>

            <h1 class="headline">
                <span class="beat"><span class="entry-display">Sign in</span><span class="entry-stop">.</span></span>
                <span class="beat"><span class="entry-display">Build with agents</span><span class="entry-stop">.</span></span>
            </h1>

            <p class="hero-sub">A workspace for coding agents.</p>

            <!--
                The one framed object here; the turned corner and lotus finial only appear on a panel big enough to
                carry them.
            -->
            <section class="entry-frame gate">
                <span class="entry-corner entry-corner-tl"></span>
                <span class="entry-corner entry-corner-tr"></span>
                <span class="entry-corner entry-corner-bl"></span>
                <span class="entry-corner entry-corner-br"></span>
                <span class="entry-finial" aria-hidden="true"><AppBrand shape="mark" /></span>

                <p v-if="error" class="gate-error">{{ error }}</p>

                <!--
                    Google's button also supplies the sandbox credential, one sign-in for both. Kept mounted (hidden)
                    rather than
                    removed on failure, so nothing races the container out from under it.
                -->
                <div v-show="googleReady" class="socket">
                    <div ref="googleButton" class="socket-slot"></div>
                </div>

                <!--
                    The site's primary button style (styles/entry.css), shown only when Google's embedded button could
                    not render.
                -->
                <Button
                    v-if="!googleReady"
                    :label="desktop ? `Continue with Google in your browser` : `Continue with Google`"
                    class="w-full justify-center"
                    @click="redirectSignIn"
                >
                    <template #icon><Icon name="google" /></template>
                </Button>

                <!--
                    Some failures of the embedded button (blocked frame, restrictive policy) are invisible here and
                    look like a dead
                    page; this path needs none of that machinery.
                -->
                <button v-if="googleReady && !desktop" type="button" class="escape" v-action="redirectSignIn">
                    Trouble signing in? Use Google's own page.
                </button>

                <p class="fine">
                    We keep your email address and your workspace's address, and nothing else. By continuing you agree to our
                    <!-- Named separately from Terms since breaching it can destroy a hosted machine without notice. -->
                    <a href="https://intentic.dev/terms/" target="_blank" rel="noopener">Terms</a>,
                    <a href="https://intentic.dev/acceptable-use/" target="_blank" rel="noopener">Acceptable Use Policy</a> and
                    <a href="https://intentic.dev/privacy/" target="_blank" rel="noopener">Privacy Policy</a>.
                </p>
            </section>

            <section class="rail">
                <p class="entry-eyebrow eyebrow-bare">Three steps to your first agent</p>
                <ol class="steps">
                    <li v-for="(step, index) in steps" :key="step.title" class="step" :aria-current="index === 0 ? `step` : undefined">
                        <span class="entry-lozenge"></span>
                        <h2>{{ step.title }}</h2>
                        <p>{{ step.body }}</p>
                    </li>
                </ol>
            </section>
        </main>

        <footer class="foot">© {{ year }} intentic. Engine MIT licensed.</footer>
    </div>
</template>

<style scoped>
/*
 * Shared material (metals, faces, plate, type, frame kit, buttons) lives in styles/entry.css; below is only this
 * screen's own layout: column position, gate width, and its three unique parts (socket, escape line, rail).
 */
.door {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: clamp(1.5rem, 4vw, 3rem) 1.5rem;
}

/*
 * The empty axis in the art. `margin: auto` instead of `justify-content`, so a short window scrolls rather than
 * clipping the gate.
 */
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
    margin-bottom: clamp(2rem, 7vh, 4rem);
}

/*
 * Two one-sentence beats; capped well below the site's own display size, since this screen has a door to fit
 * under it, not a whole screen.
 */
.headline {
    margin: 1.5rem 0 0;
    font-family: var(--face-display);
    font-size: clamp(1.75rem, 7.2vw, 3.4rem);
    line-height: 1.24;
    font-weight: 600;
}
/* Splits on the sentence, not just wraps, so each ember stop lands at the end of a thought. */
.beat {
    display: block;
    text-wrap: balance;
}

/* Ported verbatim from `.home .hero-sub` in home.css. */
.hero-sub {
    margin: 1.4rem auto 0;
    max-width: 36ch;
    font-size: 1.15rem;
    line-height: 1.6;
    color: #c2a077;
    text-wrap: balance;
}

/* The frame kit's box at this screen's size; the double rule, plate, and drop belong to `.entry-frame`. */
.gate {
    width: 100%;
    max-width: 27rem;
    margin-top: clamp(2.25rem, 6vh, 3.25rem);
    padding: 2.5rem 2rem 1.5rem;
}

.gate-error {
    margin-bottom: 1.25rem;
    padding: 0.7rem 0.9rem;
    border-left: 2px solid var(--ember);
    background: rgba(224, 123, 39, 0.08);
    font-size: 0.8125rem;
    line-height: 1.5;
    text-align: left;
    color: var(--ink);
}

/*
 * A cut slot, not a box: the hairline is its lit edge, the inset shadow its depth. color-scheme: light matches
 * Google's iframe so the browser paints no second canvas behind it.
 */
.socket {
    padding: 0.85rem;
    border: 1px solid var(--rule);
    background: #0b0805;
    box-shadow:
        inset 0 2px 7px rgba(0, 0, 0, 0.66),
        0 1px 0 rgba(201, 160, 92, 0.1);
    color-scheme: light;
}
/* A block, not a flex item: a shrink-to-fit item is 0px wide until Google renders something inside it. */
.socket-slot {
    display: flex;
    justify-content: center;
    width: 100%;
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
    margin-top: 1.5rem;
    padding-top: 1.25rem;
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
    margin-top: clamp(2.75rem, 8vh, 4.5rem);
}
.eyebrow-bare {
    color: var(--ink-subtle);
}
.steps {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 1.75rem;
    margin-top: 1.5rem;
    padding-top: 1.5rem;
    border-top: 1px solid var(--rule-strong);
    text-align: left;
}
.step {
    position: relative;
}
/* The mark sits on the rail, not under it, so the row reads as one line with three stops rather than separate cards. */
.step .entry-lozenge {
    position: absolute;
    top: calc(-1.5rem - 0.325rem);
    left: 0;
    width: 0.65rem;
    height: 0.65rem;
    color: var(--ink-subtle);
}
.step[aria-current="step"] .entry-lozenge {
    color: var(--ember);
    filter: drop-shadow(0 0 5px rgba(224, 123, 39, 0.9)) drop-shadow(0 0 12px rgba(224, 123, 39, 0.55));
}
.step h2 {
    font-family: var(--face-mark);
    font-size: 0.9375rem;
    font-weight: 600;
    color: var(--ink);
}
.step[aria-current="step"] h2 {
    color: var(--gold-bright);
}
.step p {
    margin-top: 0.35rem;
    font-size: 0.8125rem;
    line-height: 1.6;
    color: var(--ink-subtle);
    text-wrap: pretty;
}

.foot {
    margin-top: clamp(2.5rem, 7vh, 4rem);
    font-size: 0.6875rem;
    letter-spacing: 0.04em;
    color: #7c6d59;
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
    /*
     * Google's own button sizes itself and is the widest fixed element; narrowing the slot keeps it a comfortable width
     * on a phone.
     */
    .door {
        padding-left: 1rem;
        padding-right: 1rem;
    }
    .gate {
        padding-left: 1.25rem;
        padding-right: 1.25rem;
    }
    .socket {
        padding-left: 0.5rem;
        padding-right: 0.5rem;
    }
}
</style>
