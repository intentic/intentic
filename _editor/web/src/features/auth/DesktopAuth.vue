<!-- The desktop app's sign-in seen from the browser; wears /login's material (@intentic/entry-css), being the same door. -->
<script setup lang="ts">
import { AppBrand, Button, Notice, type NoticeModel, vAction } from "@intentic/ui";
import { noticeFrom, noticeOf } from "@intentic/ui/async";
import { computed, onMounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { idTokenClaims } from "./googleToken";
import { apiClient } from "../../lib/useApi";
import { useAuth } from "./useAuth";
import { useGoogleIdentity } from "./useGoogleIdentity";
import { desktopAuthLink, signInThroughBrowser } from "../../app/environments/desktop";
import { arrivingProfile } from "../../app/useProfile";

// Runs in the user's real browser, not the app's webview (Google refuses OAuth there; see environments/desktop.ts).
// Session handling is this page's own job, not a route guard's: bouncing a signed-out window to /login would sign
// in the wrong browser while the app that asked stays stuck. Only the handoff row's id crosses to the app, never
// the credentials; `state` is the app's nonce, echoed back to match.

const route = useRoute();
const { user, refresh, signInWithGoogle, signInWithGoogleCredential } = useAuth();
const { getIdToken, renderButton, adoptIdToken } = useGoogleIdentity();

const error = ref<NoticeModel | undefined>(undefined);
const working = ref(false);
// Which wait the user is in; only `signin` (Google) can need a click, so only then does the button show.
const stage = ref<`checking` | `signin` | `handing` | `done`>(`checking`);

const googleButton = ref<HTMLElement>();

// Minimum life left to hand over a token; Google's last about an hour, most of which this asks for.
const HANDOFF_USABLE_FOR_MS = 45 * 60 * 1000;

// The three waits, in the order they happen; the rail below draws one station per beat.
const BEATS = [
    { of: `checking`, name: `Check this browser` },
    { of: `signin`, name: `Confirm with Google` },
    { of: `handing`, name: `Hand it over` },
] as const;

// How many beats are behind us, which is both the lit station count and the rail's fill. A beat the flow SKIPPED
// counts as reached: the platform already holding the credential satisfies Google's beat without asking.
const reached = computed(() => (stage.value === `done` ? BEATS.length : BEATS.findIndex((beat) => beat.of === stage.value)));

// Tried first when there's a session, avoiding a redundant Google consent. Re-checks expiry since the token leaves
// for a process that may not spend it soon; too-close-to-expiring counts as nothing held, and a live pull is
// cached for this browser too.
const platformHeldToken = async (): Promise<string | undefined> => {
    try {
        const { idToken } = await apiClient.desktop.googleIdToken();
        if (idToken === undefined || idToken === ``) {
            return undefined;
        }
        const claims = idTokenClaims(idToken);
        if (claims === undefined || Date.now() >= claims.expiresAt - HANDOFF_USABLE_FOR_MS) {
            return undefined;
        }
        adoptIdToken(idToken);
        return idToken;
    } catch {
        // An older or self-hosted platform without this route isn't an error, just one that holds nothing.
        return undefined;
    }
};

// Checked first: a sessionless call gets a 401, tearing down the signed-in runtime and cancelling the Google mint
// the router started. An unreachable platform also answers false, since nothing further can work anyway.
const platformSession = async (): Promise<boolean> => {
    if (user.value !== null) {
        return true;
    }
    try {
        return (await refresh()) !== null;
    } catch {
        return false;
    }
};

// Last resort: a full-page redirect works even where Google's in-page frame won't run. Returns to this same URL
// with fresh tokens stored, so the check above then succeeds on its own.
const useGooglesOwnPage = async (): Promise<void> => {
    await signInWithGoogle(route.fullPath);
};

const hand = async (): Promise<void> => {
    const state = route.query[`state`];
    const challenge = route.query[`challenge`];
    if (typeof state !== `string` || state === `` || typeof challenge !== `string` || challenge === ``) {
        error.value = noticeOf(`This link is missing the value that ties it to your app: open Intentic and sign in from there.`);
        return;
    }
    // Parks the credential for one pickup; the app receives only the row's id, never the credential itself.
    const deliver = async (idToken: string): Promise<void> => {
        stage.value = `handing`;
        const { handoff } = await apiClient.desktop.handoff({ idToken, challenge });
        stage.value = `done`;
        globalThis.location.href = desktopAuthLink(handoff, state, arrivingProfile());
    };
    working.value = true;
    error.value = undefined;
    stage.value = `checking`;
    try {
        const session = await platformSession();
        const held = session ? await platformHeldToken() : undefined;
        if (held !== undefined) {
            await deliver(held);
            return;
        }
        stage.value = `signin`;
        // `gate: false`: this page's own button is already up, so the shared overlay is redundant; a silent re-auth
        // attempt races it. `usableFor`: the token leaves for the app, which may be a whole setup away from having a
        // daemon to spend it on, so a nearly-expired one is re-minted here instead.
        const idToken = await getIdToken({ gate: false, usableFor: HANDOFF_USABLE_FOR_MS });
        if (idToken === undefined) {
            error.value = noticeOf(`Intentic needs your Google sign-in to reach your sandbox.`);
            return;
        }
        // Only runs when there was no session: the freshly minted token both signs this browser in and is the
        // credential
        // the daemon verifies, the same trade the login screen makes. A refusal (client-id mismatch, no endpoint) falls
        // to
        // the catch below, which offers Google's own page instead.
        if (!session) {
            stage.value = `handing`;
            await signInWithGoogleCredential(idToken);
        }
        await deliver(idToken);
    } catch (err) {
        error.value = noticeFrom(err, `Couldn't finish signing in to the app.`);
    } finally {
        working.value = false;
    }
};

// Shown from the first frame rather than after a timer; the silent attempt is often blocked (a suppressed FedCM
// prompt), and this is the only thing that can then end the wait. A render refusal means this is running in the
// desktop webview, so the fallback opens the real browser instead.
const googleReady = ref(true);

// Always rendered in light theme, never following the app's scheme, for /login's reason: this screen has one
// near-black ground, and a light button is the only light-on-dark object needing the visitor's attention.
watch(
    [stage, googleButton],
    async () => {
        if (stage.value === `signin` && googleButton.value) {
            googleReady.value = await renderButton(googleButton.value, false);
        }
    },
    { flush: `post`, immediate: true },
);

// Automatic: reaching this page already means the app's button was pressed; asking again would be redundant.
onMounted(() => void hand());
</script>

<template>
    <div class="entry relay">
        <!-- /login's plate, whole: this screen is the same doorway, reached from the app instead of the address bar. -->
        <div class="entry-plate" aria-hidden="true"><div class="entry-plate-img"></div></div>

        <main class="shell">
            <header class="mark"><AppBrand /></header>

            <p class="entry-eyebrow">
                <span class="entry-lozenge"></span>
                <span>The desktop app</span>
                <span class="entry-lozenge"></span>
            </p>

            <!-- Turns over on arrival: the same two beats end the sentence the page opened with. -->
            <h1 class="headline">
                <template v-if="stage === `done` && !error">
                    <span class="beat"><span class="entry-display">Signed in</span><span class="entry-stop">.</span></span>
                    <span class="beat"><span class="entry-display">Back to the app</span><span class="entry-stop">.</span></span>
                </template>
                <template v-else>
                    <span class="beat"><span class="entry-display">Finish here</span><span class="entry-stop">.</span></span>
                    <span class="beat"><span class="entry-display">The app is waiting</span><span class="entry-stop">.</span></span>
                </template>
            </h1>

            <!-- The reason this tab exists, at the size that answers it; it used to be the smallest print on the page. -->
            <p class="hero-sub">
                <template v-if="stage === `done` && !error">The app has what it needs. You're done here.</template>
                <template v-else>The app can't show Google's sign-in in its own window, so it opened this tab.</template>
            </p>

            <!-- The one framed object, as on /login: whichever single thing this moment asks of the reader. -->
            <section class="entry-frame gate">
                <span class="entry-corner entry-corner-tl"></span>
                <span class="entry-corner entry-corner-tr"></span>
                <span class="entry-corner entry-corner-bl"></span>
                <span class="entry-corner entry-corner-br"></span>
                <span class="entry-finial" aria-hidden="true"><AppBrand shape="mark" /></span>

                <!-- Shown only once there's an account; a browser that was never signed in gets one from the credential below. -->
                <p v-if="user" class="whom">
                    <span class="whom-label">Signing in as</span>
                    <span class="whom-mail">{{ user.email }}</span>
                </p>

                <template v-if="error">
                    <!-- The shared failure box, squared and set left: every other edge inside this frame is a straight rule. -->
                    <Notice :of="error" class="rounded-none text-left" />
                    <div class="gate-actions">
                        <Button label="Try again" severity="secondary" :loading="working" @click="hand" />
                    </div>
                    <!-- Offered with the retry, since retrying alone repeats what just failed (often the platform refusing the token). -->
                    <button type="button" class="escape" v-action="useGooglesOwnPage">Use Google's own page.</button>
                </template>

                <!-- The seal is this page's one moving part: it turns while the handoff runs and locks when it lands. -->
                <template v-else-if="stage === `done`">
                    <div class="entry-seal entry-seal-lit" aria-hidden="true">
                        <span class="entry-seal-ring"></span>
                        <AppBrand shape="mark" class="entry-seal-mark" />
                    </div>
                    <p class="gate-say" role="status">You can close this tab.</p>
                    <p class="gate-aside">If the app didn't come forward, make sure Intentic is running and send it again.</p>
                    <div class="gate-actions">
                        <Button label="Send it again" severity="secondary" :loading="working" @click="hand" />
                    </div>
                </template>

                <template v-else-if="stage === `checking` || stage === `handing`">
                    <div class="entry-seal entry-seal-turning" aria-hidden="true">
                        <span class="entry-seal-ring"></span>
                        <span class="entry-seal-sweep"></span>
                        <AppBrand shape="mark" class="entry-seal-mark" />
                    </div>
                    <p class="gate-say" role="status">
                        <template v-if="stage === `handing`">Handing your sign-in to the app…</template>
                        <template v-else>Checking what this browser is already signed in to…</template>
                    </p>
                </template>

                <!-- Google may resolve this silently, or need this button; it's on screen from the start either way. -->
                <template v-else>
                    <p class="gate-say">
                        <template v-if="googleReady">Continue with Google. The app takes it from there.</template>
                        <template v-else>This page has to run in your browser: Google won't sign you in inside an app window.</template>
                    </p>
                    <div v-show="googleReady" class="entry-socket">
                        <div ref="googleButton" class="entry-socket-slot"></div>
                    </div>
                    <div v-if="!googleReady" class="gate-actions">
                        <Button label="Open this in your browser" class="w-full justify-center" @click="signInThroughBrowser">
                            <template #icon><Icon name="external-link" /></template>
                        </Button>
                    </div>

                    <!-- The button is always rendered because blocked frames are indistinguishable. -->
                    <button v-if="googleReady" type="button" class="escape" v-action="useGooglesOwnPage">Trouble signing in? Use Google's own page.</button>
                </template>

                <p class="fine">Only this one sign-in crosses to the app. Nothing else does.</p>
            </section>

            <!-- /login's rail of stations, made live: the same three stops, lit as this page passes them. -->
            <section class="rail">
                <ol class="steps" :style="{ '--reached': reached }">
                    <li
                        v-for="(beat, index) in BEATS"
                        :key="beat.of"
                        class="station"
                        :class="{
                            'station-done': index < reached,
                            'station-now': index === reached && error === undefined,
                            'station-stalled': index === reached && error !== undefined,
                        }"
                        :aria-current="index === reached ? `step` : undefined"
                    >
                        <span class="entry-lozenge"></span>
                        <h2>{{ beat.name }}</h2>
                    </li>
                </ol>
            </section>
        </main>
    </div>
</template>

<style scoped>
/* Layout only; the metals, plate, type and button tiers are shared material in styles/entry.css. */
.relay {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: clamp(1rem, 2.5vw, 2rem) 1.5rem;
}

/* The empty axis in the art, which both entry screens stand in. */
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

/* /login's headline, one step down: this screen carries a frame AND a rail under it. The `vh` arm binds only on a
   short window, so a flattened desktop window shrinks the display rather than growing a scrollbar. */
.headline {
    margin: 1.25rem 0 0;
    font-family: var(--face-display);
    font-size: clamp(1.6rem, min(6.4vw, 5.6vh), 3rem);
    line-height: 1.24;
    font-weight: var(--font-weight-semibold);
}
.beat {
    display: block;
    text-wrap: balance;
}

.hero-sub {
    margin: 0.9rem auto 0;
    max-width: 44ch;
    font-size: 1.0625rem;
    line-height: 1.6;
    color: #c2a077;
    text-wrap: balance;
}

.gate {
    display: flex;
    flex-direction: column;
    width: 100%;
    max-width: 27rem;
    margin-top: clamp(1.25rem, 3.5vh, 2rem);
    padding: 1.75rem 2rem 1.25rem;
}

/* The account this handoff is about, set as a plate caption above the action it explains. */
.whom {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    margin-bottom: 1.25rem;
    padding-bottom: 1rem;
    border-bottom: 1px solid var(--rule);
}
.whom-label {
    font-size: 0.6875rem;
    font-weight: var(--font-weight-semibold);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--gold);
}
/* `anywhere`: a long address must break inside the frame rather than push its rule out. */
.whom-mail {
    font-size: 0.875rem;
    color: var(--ink);
    overflow-wrap: anywhere;
}

.gate-say {
    font-size: 0.875rem;
    line-height: 1.55;
    color: var(--ink-muted);
    text-wrap: pretty;
}
.gate-aside {
    margin-top: 0.4rem;
    font-size: 0.75rem;
    line-height: 1.55;
    color: var(--ink-subtle);
    text-wrap: pretty;
}
.gate-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: 0.9rem;
    margin-top: 1.1rem;
}

/* The slot itself is shared material (entry.css); only its place in this gate's stack is this screen's business. */
.entry-socket {
    margin-top: 1rem;
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

/* THE RAIL — /login's three stations, reporting instead of promising. */
.rail {
    --rail-gap: 1.75rem;

    width: 100%;
    margin-top: clamp(1.5rem, 4vh, 2.25rem);
}
.steps {
    position: relative;
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--rail-gap);
    padding-top: 1.25rem;
    border-top: 1px solid var(--rule-strong);
    text-align: left;
}
/* The rail IS the progress bar: the fill stops on the mark of the station being worked, one column pitch per beat
   (a column plus its gap is (100% + gap) / 3), and covers the whole rule once the handoff has landed. */
.steps::before {
    content: "";
    position: absolute;
    top: -1px;
    left: 0;
    height: 1px;
    width: min(100%, calc(var(--reached) * (100% + var(--rail-gap)) / 3));
    background: var(--ember);
    box-shadow: 0 0 8px color-mix(in oklab, var(--ember) 55%, transparent);
    transition: width 0.5s ease;
}
.station {
    position: relative;
}
/* The mark sits on the rail, not under it, so the row reads as one line with three stops rather than separate cards. */
.station .entry-lozenge {
    position: absolute;
    top: calc(-1.25rem - 0.325rem);
    left: 0;
    width: 0.65rem;
    height: 0.65rem;
    color: var(--ink-subtle);
    transition: color 0.3s ease;
}
.station h2 {
    font-family: var(--face-mark);
    font-size: 0.9375rem;
    font-weight: var(--font-weight-semibold);
    color: var(--ink-subtle);
    transition: color 0.3s ease;
}
.station-done .entry-lozenge {
    color: var(--gold);
}
.station-done h2 {
    color: var(--ink-muted);
}
.station-now .entry-lozenge {
    color: var(--ember);
    filter: var(--house-ember-mark-glow);
}
.station-now h2 {
    color: var(--gold-bright);
}
.station-stalled .entry-lozenge {
    color: var(--color-danger);
}
.station-stalled h2 {
    color: var(--ink);
}

@media (max-width: 40rem) {
    .relay {
        padding-left: 1rem;
        padding-right: 1rem;
    }
    /* Google's own button sizes itself and is the widest fixed element here; a narrower slot keeps it comfortable. */
    .gate {
        padding-left: 1.25rem;
        padding-right: 1.25rem;
    }
    .entry-socket {
        padding-left: 0.5rem;
        padding-right: 0.5rem;
    }
    /* One column has no rail to hang marks off, so each station carries its own segment of it and lights that. */
    .steps {
        grid-template-columns: minmax(0, 1fr);
        gap: 0;
        padding-top: 0;
        border-top: 0;
    }
    .steps::before {
        display: none;
    }
    .station {
        padding: 0.5rem 0 0.5rem 1.5rem;
        border-left: 1px solid var(--rule-strong);
        transition: border-color 0.3s ease;
    }
    .station-done,
    .station-now {
        border-left-color: var(--ember);
    }
    /* Astride its own segment, as the marks sit on the rule when the three stand side by side; `top` is the label's
       optical centre, which is below the line box's own middle by the cap-height's share of the leading. */
    .station .entry-lozenge {
        top: 0.875rem;
        left: -0.325rem;
    }
}

@media (prefers-reduced-motion: reduce) {
    /* The fill still lands where it should; it just arrives there without the travel. */
    .steps::before {
        transition: none;
    }
}
</style>
