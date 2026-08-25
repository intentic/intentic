<!-- ═══════════════════════════════════════════════════════════════════════════════════════════════════
     THE DOOR, BUILT OUT OF THE SAME STONE AS THE PAGE IT IS REACHED FROM.

     A visitor arrives here by pressing "Create your workspace" on intentic.dev, and the two screens used to
     share nothing but an orange: the marketing page is a photographed temple wall with engraved display type
     and gold rules, this one was a dark gradient, a dot grid and a bulleted feature list. So the whole
     vocabulary comes across — the plate behind the first screen, the carved headline with an ember full stop
     on each beat, the gold hairlines, the turned corners, the lotus finial and the cast-bronze cartouche. The
     recipes are ported from `_site/site/src/styles/global.css`; when one of them moves there, it moves here.

     IT IS CENTRED, WHERE THE APP'S OTHER ENTRY SCREENS ARE SPLIT. The art behind it is a framed plaque with a
     figure standing in each outer third and a deliberately empty middle, and the site composes its own first
     screen on that axis. A two-column layout would put the copy over one of the figures, and the second
     column existed to hold a feature list nobody reads with a sign-in in front of them.

     IT IS ALWAYS DARK, whatever scheme the app is in. Everything the visitor has seen up to this point is,
     the materials below are built for a near-black ground, and this is the last screen before the app's own
     look takes over. Having one ground rather than two is also what decides the sign-in button's theme; the
     note over the render call has that argument.
     ═══════════════════════════════════════════════════════════════════════════════════════════════════ -->
<script setup lang="ts">
import { vAction } from "@intentic/ui";
import { computed, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import AppBrand from "../components/AppBrand.vue";
import { useAuth } from "../composables/useAuth";
import { useGoogleIdentity } from "../composables/useGoogleIdentity";
import { desktopVersion, signInThroughBrowser } from "../environments/desktop";

const { signInWithGoogle, signInWithGoogleCredential } = useAuth();
const { getIdToken, renderButton } = useGoogleIdentity();
const router = useRouter();

/* THE SITE'S TWO FACES, FETCHED BY THIS ROUTE AND NO OTHER. Playfair sets the one heading drawn at display
 * size and Mukta sets the reading copy, which is what makes the type on this screen the type on the page
 * before it; the app's own Inter is neither. Charging every workspace load for a face used on one screen is
 * the thing to avoid, so the <link> is appended when this page is set up, the way skins/useSkin.ts fetches
 * its own. It is left behind afterwards: the files are in cache by then and removing it only risks a second
 * download if the visitor comes back. `display=swap` means a slow font costs a reflow, never a blank page. */
const FACE_ELEMENT_ID = `login-site-faces`;
if (document.getElementById(FACE_ELEMENT_ID) === null) {
    const link = document.createElement(`link`);
    link.id = FACE_ELEMENT_ID;
    link.rel = `stylesheet`;
    link.href = `https://fonts.googleapis.com/css2?family=Baloo+2:wght@600&family=Mukta:wght@400;500&family=Playfair+Display:wght@600&display=swap`;
    document.head.append(link);
}

/* Inside the desktop app, the button below CANNOT work: Google refuses OAuth from an embedded webview, and
 * the redirect would dead-end on a `disallowed_useragent` page with no way back. So the app gets a different
 * button that hands the whole sign-in to the user's real browser and receives the result over a deep link
 * (see environments/desktop.ts). Same account, same session: just not in this window. */
const desktop = computed(() => desktopVersion() !== undefined);

const year = new Date().getFullYear();

/* WHAT HAPPENS AFTER THE PRESS, WHICH IS THE QUESTION A SIGN-IN SCREEN LEAVES UNANSWERED. The same three
 * beats the site's "Getting started" band walks through, in its words, so a reader who scrolled that far
 * meets them again rather than something new. The first is what the button above does, and it is marked as
 * the one happening now: this is a progress rail, not a feature list, and the order carries the meaning. */
const steps: readonly { title: string; body: string }[] = [
    { title: `Sign in with Google`, body: `No forms and no card.` },
    { title: `Your sandbox is waiting`, body: `The private room your agents live and work in, with a web address of its own.` },
    { title: `Paste one command`, body: `One line starts it on your own machine.` },
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
    await signInWithGoogle();
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
        await router.push(`/`);
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
    <div class="door">
        <!-- The plaque, pinned to its own 16:9 across the full width so the two figures are always whole and
             what runs out instead is the bottom, where the fade below is already waiting. -->
        <div class="plate" aria-hidden="true"><div class="plate-img"></div></div>

        <main class="shell">
            <header class="animate-fade-in-up mark"><AppBrand /></header>

            <!-- The greeting, flanked rather than underlined: a band eyebrow elsewhere trails a hairline to
                 the right, which on a centred axis tips the whole block sideways. -->
            <p class="animate-fade-in-up eyebrow" style="animation-delay: 60ms">
                <span class="lozenge"></span>
                <span>Welcome to intentic</span>
                <span class="lozenge"></span>
            </p>

            <h1 class="animate-fade-in-up headline" style="animation-delay: 110ms">
                <span class="beat"><span class="display">Sign in</span><span class="stop">.</span></span>
                <span class="beat"><span class="display">Your workspace opens</span><span class="stop">.</span></span>
            </h1>

            <p class="animate-fade-in-up hero-sub" style="animation-delay: 160ms">A workspace for coding agents, on hardware you own.</p>

            <!-- THE GATE. The one framed object on the screen, and the only place the site's turned corner and
                 lotus finial are drawn here: an ornament earns its keep on a panel big enough to carry it and
                 becomes noise everywhere else. -->
            <section class="animate-fade-in-up gate" style="animation-delay: 210ms">
                <span class="corner corner-tl"></span>
                <span class="corner corner-tr"></span>
                <span class="corner corner-bl"></span>
                <span class="corner corner-br"></span>
                <span class="finial" aria-hidden="true"><AppBrand shape="mark" /></span>

                <p v-if="error" class="gate-error">{{ error }}</p>

                <!-- Google's own button, which is also where the credential the sandbox needs comes from: one
                     sign-in doing both jobs. It cannot be restyled, so it is given a socket cut for it rather
                     than left to float: a recessed strip with a hairline round it, which reads as an inlay
                     instead of as a control from another design. Kept mounted (hidden) rather than removed
                     when it fails to render, so nothing can race the container away from under it. -->
                <div v-show="googleReady" class="socket">
                    <div ref="googleButton" class="socket-slot"></div>
                </div>

                <!-- The cast-bronze cartouche, the site's own primary. It stands here only when Google's
                     embedded button could not, which is exactly when this page needs one lit object on it. -->
                <button v-if="!googleReady" type="button" class="btn btn-primary" @click="redirectSignIn">
                    <Icon name="google" class="btn-icon" />
                    <span>{{ desktop ? `Continue with Google in your browser` : `Continue with Google` }}</span>
                </button>

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

            <section class="animate-fade-in-up rail" style="animation-delay: 260ms">
                <p class="eyebrow eyebrow-bare">Three steps to your first agent</p>
                <ol class="steps">
                    <li v-for="(step, index) in steps" :key="step.title" class="step" :aria-current="index === 0 ? `step` : undefined">
                        <span class="lozenge"></span>
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
/* ── THE METALS, THE GROUND AND THE INK ────────────────────────────────────────────────────────────
 * The site's own values, written out rather than taken from the app's tokens. Those follow the accent the
 * user picked in the workspace, and nobody has picked anything yet on the screen they sign in on: what this
 * page has to match is the page behind it, which is one fixed set of colours. Structure is GOLD; the ember
 * is SPENT, never spread — the full stop on a headline beat, the mark on the step you are standing on. */
.door {
    --gold: #c9a05c;
    --gold-bright: #e5c489;
    --ember: #e07b27;
    --canvas: #0c0907;
    --rule: rgba(201, 160, 92, 0.16);
    --rule-strong: rgba(201, 160, 92, 0.3);
    --ink: #efe3cd;
    --ink-muted: #b7a68d;
    --ink-subtle: #9c8b73;
    --face-display: "Playfair Display", Georgia, "Times New Roman", serif;
    --face-mark: "Baloo 2", "Trebuchet MS", ui-rounded, sans-serif;
    --face-read: "Mukta", ui-sans-serif, system-ui, sans-serif;
    --corner-size: 1.7rem;

    position: relative;
    display: flex;
    flex-direction: column;
    align-items: center;
    min-height: 100dvh;
    padding: clamp(1.5rem, 4vw, 3rem) 1.5rem;
    background: var(--canvas);
    color: var(--ink);
    font-family: var(--face-read);
    color-scheme: dark;
    isolation: isolate;
}

/* THE SKIN STOPS HERE. These screens match the marketing site, not the workspace chrome; a selected skin's
 * heading face, stone-ink and cut shadow must not leak in — they are a different palette from the landing hero. */
.door :is(h1, h2, h3, h4) {
    font-family: unset;
    color: unset;
    text-shadow: none;
}

/* Keyboard focus in the page's own metal. The default ring is a blue-white box, which on this ground is the
   one thing here from another design, and the visitor arriving by keyboard is the one who most needs to see
   where they are. */
.door :focus-visible {
    outline: 2px solid var(--gold-bright);
    outline-offset: 3px;
}

/* ── THE PLATE ─────────────────────────────────────────────────────────────────────────────────────
 * The art is a framed plaque: a carved border, a figure standing in each outer third, an empty middle. The
 * box is pinned to the art's own ratio so `cover` is an exact fit and neither figure is ever cropped; what
 * runs out on a tall window is the bottom, and the gradient below dissolves that edge into the canvas
 * rather than letting a carved rule stop against flat black. */
.plate {
    position: absolute;
    inset: 0;
    z-index: -1;
    overflow: hidden;
    pointer-events: none;
    background: var(--canvas);
}
.plate-img {
    position: absolute;
    top: 0;
    right: 0;
    left: 0;
    aspect-ratio: 16 / 9;
    background-image: url("/assets/angkor/temple-900.avif");
    background-position: 50% 0%;
    background-size: cover;
    background-repeat: no-repeat;
}
@media (min-width: 60rem) {
    .plate-img {
        background-image: url("/assets/angkor/temple-1600.avif");
    }
}
.plate-img::after {
    content: "";
    position: absolute;
    right: 0;
    bottom: 0;
    left: 0;
    height: 38%;
    background: linear-gradient(180deg, transparent 0%, rgba(12, 9, 7, 0.55) 52%, var(--canvas) 100%);
}
/* The scrim is a WELL, not a ramp, and the symmetry of the art is why: a gradient run left to right darkens
 * one figure and leaves the other lit, which reads as a lighting fault. Sunk in the middle it follows the
 * copy and leaves both figures alone. Four layers, one paint: the well, a floor that holds down the ember
 * glow along the art's lower edge, a vignette off the corners, and a flat wash of canvas over all of it. */
.plate::after {
    content: "";
    position: absolute;
    inset: 0;
    background:
        radial-gradient(58% 46% at 50% 34%, rgba(9, 6, 4, 0.78) 0%, rgba(9, 6, 4, 0.62) 42%, rgba(9, 6, 4, 0.3) 72%, transparent 100%),
        linear-gradient(0deg, rgba(9, 6, 4, 0.78) 0%, rgba(9, 6, 4, 0.46) 20%, rgba(9, 6, 4, 0.14) 40%, transparent 60%),
        radial-gradient(128% 108% at 50% 40%, transparent 44%, rgba(9, 6, 4, 0.55) 100%), rgba(12, 9, 7, 0.14);
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

/* ── THE BAND OPENER ───────────────────────────────────────────────────────────────────────────── */
.eyebrow {
    display: inline-flex;
    align-items: center;
    gap: 0.7rem;
    font-size: 0.6875rem;
    font-weight: 600;
    letter-spacing: 0.22em;
    text-transform: uppercase;
    color: var(--gold);
}
.lozenge {
    display: inline-block;
    flex: none;
    width: 0.55rem;
    height: 0.55rem;
    background-color: currentColor;
    /* The ornament kit's diamond, worn as a mask so a caller sets the metal by setting a text colour —
       which is what lets the same shape be gold beside a greeting and ember beside the live step. */
    mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 12 12' fill='none'%3E%3Cpath d='M6 .8 11.2 6 6 11.2.8 6z' stroke='%23000' stroke-width='1.1'/%3E%3Cpath d='M6 3.6 8.4 6 6 8.4 3.6 6z' fill='%23000' opacity='.55'/%3E%3C/svg%3E");
    mask-size: contain;
    mask-repeat: no-repeat;
    mask-position: center;
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

/* CARVED STONE, NOT POLISHED METAL, and the difference is texture rather than colour. Three layers are
 * clipped to the glyphs at once: a coarse fractal cloud for the blotching a weathered surface has, a fine
 * one for grain, and a narrow warm ramp under both. They composite with `overlay` and `soft-light`, so the
 * noise moves the ramp's own colour lighter and darker rather than laying grey over it — a stone is one
 * material lit unevenly, not two materials stacked.
 *
 * DESCENDERS ARE STRUCTURAL HERE. The letters are painted as a background clipped to their shape, and a
 * background stops at the padding box, so anything a glyph reaches below it is simply not painted and the
 * tail of a "g" or "y" vanishes. The clearance is bought with padding and taken straight back out with a
 * matching negative margin: the painted box grows by the depth of a descender while the laid-out box does
 * not move, and it holds at any leading. The pair must stay together. */
.display {
    font-family: var(--face-display);
    font-weight: 600;
    letter-spacing: 0.02em;
    line-height: 1.24;
    --descender: 0.2em;
    padding-block-end: var(--descender);
    margin-block-end: calc(-1 * var(--descender));
    background-image:
        url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='70' height='70'%3E%3Cfilter id='g' color-interpolation-filters='sRGB'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' seed='5' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0.33 0.33 0.33 0 0 0.33 0.33 0.33 0 0 0.33 0.33 0.33 0 0 0 0 0 0 1'/%3E%3CfeComponentTransfer%3E%3CfeFuncR type='linear' slope='0.78' intercept='0.11'/%3E%3CfeFuncG type='linear' slope='0.78' intercept='0.11'/%3E%3CfeFuncB type='linear' slope='0.78' intercept='0.11'/%3E%3C/feComponentTransfer%3E%3C/filter%3E%3Crect width='70' height='70' filter='url(%23g)'/%3E%3C/svg%3E"),
        url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Cfilter id='s' color-interpolation-filters='sRGB'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.04' numOctaves='5' seed='11' stitchTiles='stitch'/%3E%3CfeColorMatrix values='0.33 0.33 0.33 0 0 0.33 0.33 0.33 0 0 0.33 0.33 0.33 0 0 0 0 0 0 1'/%3E%3CfeComponentTransfer%3E%3CfeFuncR type='linear' slope='0.55' intercept='0.225'/%3E%3CfeFuncG type='linear' slope='0.55' intercept='0.225'/%3E%3CfeFuncB type='linear' slope='0.55' intercept='0.225'/%3E%3C/feComponentTransfer%3E%3C/filter%3E%3Crect width='200' height='200' filter='url(%23s)'/%3E%3C/svg%3E"),
        linear-gradient(176deg, #cbb08d 0%, #bda07d 24%, #ab8c6c 52%, #97795c 78%, #86694f 100%);
    background-size:
        70px 70px,
        200px 200px,
        100% 100%;
    background-blend-mode: soft-light, overlay, normal;
    -webkit-background-clip: text;
    background-clip: text;
    color: transparent;
    -webkit-text-fill-color: transparent;
    /* The bevel, and it has to be `filter` rather than `text-shadow`: the fill here IS a background, and a
       background is painted BEFORE a text shadow, so a light shadow offset up-left would lay a flat pale
       copy of the glyph over the texture it is meant to be lighting. Chained drop-shadows composite behind
       the finished element instead — two pale edges for the lit face of the cut, a hard black one for its
       depth, then two soft ones for the shadow the letter throws on the wall. */
    filter: drop-shadow(0 -1px 0 rgba(247, 234, 208, 0.8)) drop-shadow(-1px -1px 0 rgba(247, 234, 208, 0.38)) drop-shadow(0 2px 0 rgba(0, 0, 0, 0.92))
        drop-shadow(0 4px 5px rgba(0, 0, 0, 0.62)) drop-shadow(0 12px 24px rgba(0, 0, 0, 0.45));
}
/* Its own span, so it escapes the clipped gradient above. */
.stop {
    color: var(--ember);
    font-family: var(--face-display);
    margin-left: 0.06em;
    filter: drop-shadow(0 0 14px rgba(224, 123, 39, 0.55));
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
 * A double rule with a turned corner in each elbow and the lotus astride the top rail. Opaque rather than
 * tinted glass: small print sitting over a photograph reads at a different contrast in every line. */
.gate {
    position: relative;
    width: 100%;
    max-width: 27rem;
    margin-top: clamp(2.25rem, 6vh, 3.25rem);
    padding: 2.5rem 2rem 1.5rem;
    border: 1px solid var(--rule-strong);
    background: #14100b;
    box-shadow: 0 24px 60px -18px rgba(0, 0, 0, 0.85);
}
.gate::before {
    content: "";
    position: absolute;
    inset: 4px;
    border: 1px solid var(--rule);
    pointer-events: none;
}
/* The corners keep their drawn weight at any frame size, which is why they are elements and not a stretched
   border-image. One shape, rotated three times. */
.corner {
    position: absolute;
    width: var(--corner-size);
    height: var(--corner-size);
    background-color: var(--gold);
    opacity: 0.95;
    pointer-events: none;
    mask-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 44 44' fill='none'%3E%3Cg stroke='%23000' stroke-width='1.1' stroke-linecap='round'%3E%3Cpath d='M43 1H13.5A12.5 12.5 0 0 0 1 13.5V43'/%3E%3Cpath d='M43 7H16a9 9 0 0 0-9 9v27' opacity='.55'/%3E%3Cpath d='M25 1c0 3.9-3.1 7-7 7'/%3E%3Cpath d='M1 25c3.9 0 7-3.1 7-7'/%3E%3C/g%3E%3Cpath d='M12.5 8.6 16.4 12.5 12.5 16.4 8.6 12.5z' stroke='%23000' stroke-width='1' fill='none'/%3E%3C/svg%3E");
    mask-size: contain;
    mask-repeat: no-repeat;
}
.corner-tl {
    top: -1px;
    left: -1px;
}
.corner-tr {
    top: -1px;
    right: -1px;
    transform: scaleX(-1);
}
.corner-bl {
    bottom: -1px;
    left: -1px;
    transform: scaleY(-1);
}
.corner-br {
    right: -1px;
    bottom: -1px;
    transform: scale(-1);
}
/* The finial carries no plate of its own: a filled box behind it reads as a sticker punched through the
   wall the frame stands on. What separates it from the rail is a glow of its own colour, which the rail
   passes behind without being cut. */
.finial {
    position: absolute;
    top: 0;
    left: 50%;
    display: grid;
    place-items: center;
    font-size: 1.5rem;
    transform: translate(-50%, -52%);
    filter: drop-shadow(0 0 6px rgba(12, 9, 7, 0.95)) drop-shadow(0 0 16px rgba(224, 123, 39, 0.35));
    pointer-events: none;
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

/* ── THE CARTOUCHE ─────────────────────────────────────────────────────────────────────────────────
 * An octagon: two concentric gold rules with a 45-degree notch taken out of all four corners, like a
 * chamfer off a stone slab. `clip-path` cuts the shape out of everything the element paints, and
 * `border-image` draws the rules — a nine-slice, because the corner is the one part of the frame that must
 * NOT stretch, so a wide button and a narrow one get the same notch. The chamfer is set in two places that
 * have to agree: the artwork's geometry and `--cut`.
 *
 * The diagonals are drawn heavier than the straight runs on purpose. A corner tile is 13 source units
 * painted into 13px while the artwork is authored on a 40 unit grid, and a 45-degree stroke loses far more
 * to that resampling than a horizontal one, so the outline visibly changed colour wherever it turned.
 *
 * THE PRIMARY IS CAST BRONZE, and it inverts. It is the only light-on-dark object here: a gilded plaque
 * with the words cut into it, where everything else is cream on stone. Gold rather than ember, because
 * ember is the page's one spent colour and filling a plaque with it would leave the accents nothing to be
 * brighter than. */
.btn {
    --cut: 7.3px;
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.55rem;
    width: 100%;
    padding: 0.85rem 1.6rem;
    font-family: var(--face-read);
    font-size: 0.9375rem;
    font-weight: 600;
    letter-spacing: 0.015em;
    line-height: 1.35;
    white-space: nowrap;
    cursor: pointer;
    color: #21140a;
    text-shadow: 0 1px 0 rgba(255, 248, 232, 0.42);
    background-color: #d9b169;
    background-image:
        linear-gradient(100deg, transparent 26%, rgba(255, 250, 236, 0.42) 44%, rgba(255, 250, 236, 0.08) 55%, transparent 68%),
        url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='320' height='64'%3E%3Cfilter id='b' color-interpolation-filters='sRGB'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.006 0.9' numOctaves='3' seed='7'/%3E%3CfeColorMatrix values='0 0 0 0 0.35 0 0 0 0 0.23 0 0 0 0 0.07 0.5 0 0 0 -0.16'/%3E%3C/filter%3E%3Crect width='320' height='64' filter='url(%23b)'/%3E%3C/svg%3E"),
        linear-gradient(180deg, #f2d69f 0%, #ddb571 40%, #c99a4f 74%, #b3823c 100%);
    background-size: 100% 100%;
    background-repeat: no-repeat;
    border: 1px solid transparent;
    border-image-source: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40' viewBox='0 0 40 40'%3E%3Cpath d='M6.7 0.6H33.3M39.4 6.7V33.3M33.3 39.4H6.7M0.6 33.3V6.7' fill='none' stroke='rgba(255,239,203,0.92)' stroke-width='1.2'/%3E%3Cpath d='M33.3 0.6L39.4 6.7M39.4 33.3L33.3 39.4M6.7 39.4L0.6 33.3M0.6 6.7L6.7 0.6' fill='none' stroke='rgba(255,239,203,0.92)' stroke-width='2.34'/%3E%3Cpath d='M8.6 4.5H31.4M35.5 8.6V31.4M31.4 35.5H8.6M4.5 31.4V8.6' fill='none' stroke='rgba(120,80,32,0.45)' stroke-width='1.15'/%3E%3Cpath d='M31.4 4.5L35.5 8.6M35.5 31.4L31.4 35.5M8.6 35.5L4.5 31.4M4.5 8.6L8.6 4.5' fill='none' stroke='rgba(120,80,32,0.45)' stroke-width='2.24'/%3E%3C/svg%3E");
    border-image-slice: 13;
    border-image-width: 13px;
    border-image-repeat: stretch;
    clip-path: polygon(
        var(--cut) 0,
        calc(100% - var(--cut)) 0,
        100% var(--cut),
        100% calc(100% - var(--cut)),
        calc(100% - var(--cut)) 100%,
        var(--cut) 100%,
        0 calc(100% - var(--cut)),
        0 var(--cut)
    );
    /* A lit hairline along the top edge and a shade along the foot is the whole of a bevel at this size.
       The outer pair lifts the plaque off the wall: a warm halo the near-black page has nothing else like,
       and a short drop under it so the object has somewhere to sit. */
    box-shadow:
        inset 0 1px 0 rgba(255, 252, 242, 0.8),
        inset 0 -1px 0 rgba(88, 56, 18, 0.5),
        inset 0 0 16px rgba(140, 94, 36, 0.25),
        0 0 30px rgba(226, 168, 78, 0.3),
        0 6px 18px -6px rgba(0, 0, 0, 0.75);
    /* A stacking context, so the sheen below can sit at `z-index: -1`: inside one, a negative layer paints
       after the element's own background and border but BEFORE its inline content, which is where a wash
       belongs — over the frame, under the label. */
    z-index: 0;
}
/* Under the pointer the plate catches more of the same light rather than changing colour: one warm sheen,
   one opacity, so the lift arrives as a single movement. The label does not lighten — it is cut into metal,
   and metal that brightens does not turn its engraving pale. */
.btn::after {
    content: "";
    position: absolute;
    inset: 0;
    background: linear-gradient(180deg, rgba(255, 250, 236, 0.42) 0%, rgba(255, 244, 220, 0.12) 55%, transparent 100%);
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.22s ease;
    z-index: -1;
}
.btn:hover::after,
.btn:focus-visible::after {
    opacity: 1;
}
.btn-icon {
    flex: none;
    display: block;
    font-size: 1rem;
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
.step .lozenge {
    position: absolute;
    top: calc(-1.5rem - 0.325rem);
    left: 0;
    width: 0.65rem;
    height: 0.65rem;
    color: var(--ink-subtle);
}
.step[aria-current="step"] .lozenge {
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
    .step .lozenge {
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
