<!-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
     THE DOOR, BUILT OUT OF THE SAME STONE AS THE PAGE IT IS REACHED FROM.

     A visitor arrives here by pressing "Create your workspace" on intentic.dev, and the two screens used to
     share nothing but an orange: the marketing page is a photographed temple wall with engraved display type
     and gold rules, this one was a dark gradient, a dot grid and a bulleted feature list. So the whole
     vocabulary comes across — the plate behind the first screen, the carved headline with an ember full stop
     on each beat, the gold hairlines, the turned corners, the lotus finial and the cast-bronze cartouche.

     THE MATERIAL IS NO LONGER THIS FILE'S. It lives in `styles/entry.css`, because `/setup` — the screen
     immediately behind this one — is built out of the same stone and cannot be built out of a copy of it.
     What stays here is this screen's COMPOSITION, which is the thing the two legitimately differ on.

     IT IS CENTRED, WHERE THE APP'S OTHER ENTRY SCREENS ARE SPLIT. The art behind it is a framed plaque with a
     figure standing in each outer third and a deliberately empty middle, and the site composes its own first
     screen on that axis. A two-column layout would put the copy over one of the figures, and the second
     column existed to hold a feature list nobody reads with a sign-in in front of them.

     IT IS ALWAYS DARK, whatever scheme the app is in. Everything the visitor has seen up to this point is,
     the materials are built for a near-black ground, and this is the last stretch before the app's own look
     takes over. Having one ground rather than two is also what decides the sign-in button's theme; the note
     over the render call has that argument.
     ═══════════════════════════════════════════════════════════════════════════════════════════════════ -->
<script setup lang="ts">
import { Button, vAction } from "@intentic/ui";
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import AppBrand from "../components/AppBrand.vue";
import { useAuth } from "../composables/useAuth";
import { useGoogleIdentity } from "../composables/useGoogleIdentity";
import { useSiteFaces } from "../composables/useSiteFaces";
import { desktopInstaller, desktopVersion, signInThroughBrowser } from "../environments/desktop";
import { returnPath } from "../router/signIn";

const { signInWithGoogle, signInWithGoogleCredential } = useAuth();
const { getIdToken, renderButton } = useGoogleIdentity();
const router = useRouter();
const route = useRoute();

/* THE PAGE THAT SENT THEM HERE, which this screen used to forget. Both ways out of it hardcoded `/`, so a
 * guard that turned somebody away from a deep link signed them in and then dropped them in the workspace,
 * with the address they had asked for gone. Sanitised on the way in: it is spent both as a router navigation
 * and as an OAuth callback on this origin (router/signIn.ts holds that, and why it is narrow). */
const destination = computed(() => returnPath(route.query[`returnTo`]));

// The site's faces, on this route and the setup route only — see composables/useSiteFaces.ts.
useSiteFaces();

/* Inside the desktop app, the button below CANNOT work: Google refuses OAuth from an embedded webview, and
 * the redirect would dead-end on a `disallowed_useragent` page with no way back. So the app gets a different
 * button that hands the whole sign-in to the user's real browser and receives the result over a deep link
 * (see environments/desktop.ts). Same account, same session: just not in this window. */
const desktop = computed(() => desktopVersion() !== undefined);

const year = new Date().getFullYear();

/* WHAT HAPPENS AFTER THE PRESS, WHICH IS THE QUESTION A SIGN-IN SCREEN LEAVES UNANSWERED. The same three
 * beats the site's "Getting started" band walks through, in its words, so a reader who scrolled that far
 * meets them again rather than something new. The first is what the button above does, and it is marked as
 * the one happening now: this is a progress rail, not a feature list, and the order carries the meaning.
 * The second beat's title is repeated verbatim as the setup page's own eyebrow, so the next screen a visitor
 * sees announces itself as the station they were just shown rather than as a new subject. */
/* …AND THE THIRD BEAT HAS TO BE THE ONE THIS VISITOR WILL ACTUALLY GET. It read "Paste one command / One line
 * starts it on your own machine" for everybody, which is the promise the setup page then breaks for the two
 * platforms we ship a build for: they are handed a Download button and never see a command at all. It is the
 * product's first description of itself, so the version a Windows or Linux visitor read was "there will be a
 * terminal" — the single thing this flow spent a release removing, advertised on the way in, to the exact
 * reader most likely to be put off by it. Same `desktopInstaller()` the setup page decides with, so the two
 * screens cannot promise different things. */
const install = desktopInstaller();
const steps: readonly { title: string; body: string }[] = [
    { title: `Sign in with Google`, body: `No forms and no card.` },
    { title: `Your sandbox is waiting`, body: `The private room your agents live and work in, with a web address of its own.` },
    install === undefined
        ? { title: `Paste one command`, body: `One line starts it on your own machine.` }
        : { title: `Install the app`, body: `One click starts it on your own machine. No terminal.` },
];

/* ONE GOOGLE SIGN-IN, NOT TWO.
 *
 * The redirect below proves the user to the platform and leaves this window holding nothing, which is why
 * the sandbox then asked for Google all over again: the daemon authenticates people against Google itself and
 * only the browser can hand it a Google-signed token. Minting that token HERE, and spending it on the
 * platform as well, means the second ask never happens.
 *
 * The credential the sandbox eventually receives is byte-for-byte what it receives today, so a daemon that is
 * older, forked, or deliberately built to distrust the platform is not affected by any of this.
 *
 * Google's own button is the control, because it is the one surface that works when One Tap does not. Four
 * things can go wrong. Three are observable and each answers with the redirect rather than a dead page:
 * Google's script never arrives (nothing renders), the user dismisses whatever Google shows, or the platform
 * refuses the token. The fourth: a button that renders but cannot work, behind a blocked frame or a popup
 * policy: is invisible from here, which is why the escape link below it is unconditional. */
const googleButton = ref<HTMLElement>();
/* Whether Google's own button is standing there. Starts true so the container is in the DOM for the very
 * first render: a button cannot be rendered into an element that does not exist, and flips to false when
 * the render is refused (Google's script absent, or this being the desktop webview, where the mechanism
 * refuses on every surface's behalf) or when the platform rejects what Google signed. */
const googleReady = ref(true);
const error = ref<string>();

const redirectSignIn = async (): Promise<void> => {
    if (desktop.value) {
        signInThroughBrowser();
        return;
    }
    await signInWithGoogle(destination.value);
};

/* The mint, started on mount so a click has something to resolve, and so a returning user is signed in with
 * no click at all, which is what Google's automatic re-authentication is for. It can only fire for someone
 * who has signed in this way here BEFORE, so a first-ever account still passes a visible Google surface and
 * the consent line under it. */
const signInWithCredential = async (): Promise<void> => {
    // The mechanism would refuse this window anyway; not starting is just not booting Google's script in a
    // window that can never use it.
    if (desktop.value) {
        return;
    }
    try {
        // `gate: false`, this page's own button IS the gate; the shared overlay would be a second one.
        const idToken = await getIdToken({ gate: false });
        if (idToken === undefined) {
            return; // Dismissed, or Google unavailable. The fallback below is already on screen.
        }
        await signInWithGoogleCredential(idToken);
        await router.push(destination.value);
    } catch {
        /* The platform would not take a token Google did in fact sign: a build without the endpoint, or a
         * client-id mismatch between this app and that platform. The redirect does not depend on either, so
         * hand the user that rather than a dead end. The Google credential stays cached on purpose: the
         * sandbox may well accept what the platform just refused, and re-minting would be a third ask. */
        googleReady.value = false;
        error.value = `Couldn't finish that sign-in. Continue with Google below instead.`;
    }
};

onMounted(() => void signInWithCredential());

/* Google's button, rendered as soon as its container exists. A click resolves the mint above.
 *
 * ITS LIGHT THEME, ALWAYS, AND THAT IS NOT AN OVERSIGHT. This screen has one ground and it is near-black,
 * so it never has a scheme to follow; and Google's dark button on it is a dark box inside a warm rule,
 * which is also the description of the frame around it, the socket under it and every other edge here. The
 * eye finds differences of LIGHTNESS before it finds anything else, so the one thing a visitor has to press
 * would be the quietest object on the page. Light, it is the only light-on-dark thing here, which is the
 * same trade the site makes with its own primary. */
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
        <!-- The plaque, pinned to its own 16:9 across the full width so the two figures are always whole and
             what runs out instead is the bottom, where the fade below is already waiting. No veil on this
             screen: it is the one page composed against the art rather than laid over it. -->
        <div class="entry-plate" aria-hidden="true"><div class="entry-plate-img"></div></div>

        <main class="shell">
            <header class="mark"><AppBrand /></header>

            <!-- The greeting, flanked rather than underlined: a band eyebrow elsewhere trails a hairline to
                 the right, which on a centred axis tips the whole block sideways. -->
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

            <!-- THE GATE. The one framed object on the screen, and the only place the site's turned corner and
                 lotus finial are drawn here: an ornament earns its keep on a panel big enough to carry it and
                 becomes noise everywhere else. -->
            <section class="entry-frame gate">
                <span class="entry-corner entry-corner-tl"></span>
                <span class="entry-corner entry-corner-tr"></span>
                <span class="entry-corner entry-corner-bl"></span>
                <span class="entry-corner entry-corner-br"></span>
                <span class="entry-finial" aria-hidden="true"><AppBrand shape="mark" /></span>

                <p v-if="error" class="gate-error">{{ error }}</p>

                <!-- Google's own button, which is also where the credential the sandbox needs comes from: one
                     sign-in doing both jobs. It cannot be restyled, so it is given a socket cut for it rather
                     than left to float: a recessed strip with a hairline round it, which reads as an inlay
                     instead of as a control from another design. Kept mounted (hidden) rather than removed
                     when it fails to render, so nothing can race the container away from under it. -->
                <div v-show="googleReady" class="socket">
                    <div ref="googleButton" class="socket-slot"></div>
                </div>

                <!-- The cast-bronze cartouche, the site's own primary, drawn by the entry kit's top button
                     tier (styles/entry.css) rather than by a recipe of this page's own. It stands here only
                     when Google's embedded button could not, which is exactly when this page needs one lit
                     object on it. -->
                <Button
                    v-if="!googleReady"
                    :label="desktop ? `Continue with Google in your browser` : `Continue with Google`"
                    class="w-full justify-center"
                    @click="redirectSignIn"
                >
                    <template #icon><Icon name="google" /></template>
                </Button>

                <!-- The escape hatch, always there while the embedded button is. Some of the ways that button
                     can fail are invisible from here: an extension that blocks its frame, a policy that lets
                     it render but not open, and every one of them looks to the visitor like a sign-in page
                     that does nothing. This is the way in that depends on none of it. -->
                <button v-if="googleReady && !desktop" type="button" class="escape" v-action="redirectSignIn">
                    Trouble signing in? Use Google's own page.
                </button>

                <p class="fine">
                    We keep your email address and your workspace's address, and nothing else. By continuing you agree to our
                    <!-- Acceptable Use is named here rather than left to the Terms that incorporate it: it is
                         the document whose breach destroys a hosted machine without notice, and consent to a
                         rule with that consequence should be given to the rule itself. -->
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
/* THE MATERIAL IS IN `styles/entry.css` — the metals, the ink, the faces, the plate, the eyebrow, the carved
 * display type, the frame kit and both button plaques. Everything below is this screen's own composition:
 * where the column sits, how wide the gate is, and the three things only the door has (Google's socket, the
 * escape line and the progress rail). */
.door {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: clamp(1.5rem, 4vw, 3rem) 1.5rem;
}

/* ── THE COLUMN ────────────────────────────────────────────────────────────────────────────────────
 * Everything on the axis the art leaves empty. `margin: auto` on the block rather than `justify-content`
 * on the page, so a short window scrolls instead of clipping the gate off the bottom. */
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

/* ── THE HEADLINE ──────────────────────────────────────────────────────────────────────────────────
 * Two beats, one sentence each, the full stop carrying the only ember above the fold. Capped well below the
 * site's own display size: that page gives the headline a whole screen and this one has a door to fit
 * under it. */
.headline {
    margin: 1.5rem 0 0;
    font-family: var(--face-display);
    font-size: clamp(1.75rem, 7.2vw, 3.4rem);
    line-height: 1.24;
    font-weight: 600;
}
/* One sentence per line, and each one wraps as a block of its own rather than reflowing into the next:
   splitting on the sentence is what keeps the ember stops at the ends of thoughts. */
.beat {
    display: block;
    text-wrap: balance;
}

/* THE LINE UNDER THE HEADLINE — ported verbatim from `.home .hero-sub` in home.css. */
.hero-sub {
    margin: 1.4rem auto 0;
    max-width: 36ch;
    font-size: 1.15rem;
    line-height: 1.6;
    color: #c2a077;
    text-wrap: balance;
}

/* ── THE GATE ──────────────────────────────────────────────────────────────────────────────────────
 * The kit's frame at this screen's size. Only the box is here; the double rule, the plate and the drop are
 * `.entry-frame`'s. */
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

/* A slot cut into the plate rather than a box laid on it: the hairline is the cut's lit edge and the inner
   shadow is its depth, so the one control here that cannot be restyled reads as an inlay somebody made room
   for. `color-scheme: light` matches Google's light-theme iframe, so the browser paints no second canvas of
   its own behind it. */
.socket {
    padding: 0.85rem;
    border: 1px solid var(--rule);
    background: #0b0805;
    box-shadow:
        inset 0 2px 7px rgba(0, 0, 0, 0.66),
        0 1px 0 rgba(201, 160, 92, 0.1);
    color-scheme: light;
}
/* A block, not a flex item: this is the box Google measures itself against, and a shrink-to-fit item is
   0px wide until something is already inside it. */
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

/* ── THE RAIL ──────────────────────────────────────────────────────────────────────────────────────
 * Three stations on one hairline, and the mark on each says which one you are standing on: ember for the
 * step this page is, quiet gold for the two ahead of it. */
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
/* The station's mark sits ON the rail rather than under it, which is what makes the row read as one line
   with three stops instead of three cards that happen to be adjacent. The hairline runs behind it, the way
   the site's own divider is knotted with the same diamond. */
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
        /* One column has no rail to hang marks off, so each station carries its own left-hand rule and the
           lozenge returns to the flow beside its title. */
        border-left: 1px solid var(--rule);
        padding-left: 1.5rem;
    }
    .step .entry-lozenge {
        position: absolute;
        top: 0.3rem;
        left: calc(-1.5rem - 0.275rem);
    }
    /* The slot narrows step by step down here so Google's own button, which sizes itself and is the widest
       fixed thing on the page, keeps a comfortable measure on a phone. */
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
