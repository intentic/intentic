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
import { useT } from "@intentic/ui/i18n";

// Runs in the user's real browser, not the app's webview (Google refuses OAuth there; see environments/desktop.ts).
// Session handling is this page's own job, not a route guard's: bouncing a signed-out window to /login would sign
// in the wrong browser while the app that asked stays stuck. Only the handoff row's id crosses to the app, never
// the credentials; `state` is the app's nonce, echoed back to match.
//
// TWO CREDENTIALS CROSS HERE AND THEY HAVE TO NAME ONE PERSON: a one-time token for this browser's Intentic session,
// and a Google ID token minted beside it. The app shows the first and the sandbox daemon trusts only the second, so a
// row carrying two identities hands the app a sandbox it can never open — and no screen in the app can say why, since
// each half looks right on its own. That is what `agreed` below refuses.

const t = useT();

const route = useRoute();
const { user, refresh, signInWithGoogle, signInWithGoogleCredential } = useAuth();
const { getIdToken, renderButton, adoptIdToken } = useGoogleIdentity();

const error = ref<NoticeModel | undefined>(undefined);
const working = ref(false);
// Which wait the user is in; only `signin` (Google) can need a click, so only then does the button show.
const stage = ref<`checking` | `signin` | `handing` | `done`>(`checking`);

// The app's press said "not that account" (`intentic://signin?switch=1`), so every road that answers without asking
// is refused here and Google's chooser is what this page puts up. The fork below turns it on too.
const picking = ref(route.query[`switch`] === `1`);

// The pair that would not name one person, held for the reader to settle rather than handed over.
const disagreement = ref<{ readonly google: string; readonly intentic: string; readonly idToken: string } | undefined>(undefined);

// Whose credential is crossing, once one is in hand — the Google account, which is the half the sandbox verifies.
// Before that there is only this browser's Intentic account to name.
const googleEmail = ref<string | undefined>(undefined);
const handingEmail = computed(() => googleEmail.value ?? user.value?.email);

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

// Whether this credential may cross as this browser's own sign-in. A browser with no Intentic session takes the
// credential as one (the trade the login screen makes), equal addresses hand over, and anything else stops at the
// fork: the app has no way to reconcile two people, and shipping both is what made "Switch Google account" loop.
const agreed = async (idToken: string, session: boolean): Promise<boolean> => {
    const google = idTokenClaims(idToken)?.email;
    if (google === undefined) {
        error.value = noticeOf(`Google's answer couldn't be read. Try signing in again.`);
        return false;
    }
    googleEmail.value = google;
    const intentic = session ? user.value?.email : undefined;
    if (intentic === undefined) {
        stage.value = `handing`;
        await signInWithGoogleCredential(idToken);
        return true;
    }
    if (intentic.toLowerCase() === google.toLowerCase()) {
        return true;
    }
    disagreement.value = { google, intentic, idToken };
    return false;
};

// What ties this page to the app that opened it: the app's nonce, echoed back on the deep link, and the challenge
// whose verifier only the app holds. Undefined means a link nobody's app is waiting behind.
const linkParts = (): { readonly state: string; readonly challenge: string } | undefined => {
    const state = route.query[`state`];
    const challenge = route.query[`challenge`];
    return typeof state === `string` && state !== `` && typeof challenge === `string` && challenge !== `` ? { state, challenge } : undefined;
};

const hand = async (): Promise<void> => {
    const link = linkParts();
    if (link === undefined) {
        error.value = noticeOf(`This link is missing the value that ties it to your app: open Intentic and sign in from there.`);
        return;
    }
    // Parks the credential for one pickup; the app receives only the row's id, never the credential itself.
    const deliver = async (idToken: string): Promise<void> => {
        stage.value = `handing`;
        const { handoff } = await apiClient.desktop.handoff({ idToken, challenge: link.challenge });
        stage.value = `done`;
        globalThis.location.href = desktopAuthLink(handoff, link.state, arrivingProfile());
    };
    working.value = true;
    error.value = undefined;
    disagreement.value = undefined;
    stage.value = `checking`;
    try {
        const session = await platformSession();
        // Skipped on a switch: the platform's own token names the account being rejected, and it would answer
        // before the reader was asked anything.
        let idToken = session && !picking.value ? await platformHeldToken() : undefined;
        if (idToken === undefined) {
            stage.value = `signin`;
            // `gate: false`: this page's own button is already up, so the shared overlay is redundant; a silent re-auth
            // attempt races it. `usableFor`: the token leaves for the app, which may be a whole setup away from having a
            // daemon to spend it on, so a nearly-expired one is re-minted here instead. `pick`: no silent attempt at
            // all, so Google's chooser is the only road to a credential.
            idToken = await getIdToken({ gate: false, usableFor: HANDOFF_USABLE_FOR_MS, pick: picking.value });
        }
        if (idToken === undefined) {
            error.value = noticeOf(`Intentic needs your Google sign-in to reach your sandbox.`);
            return;
        }
        // A refusal inside (client-id mismatch, no endpoint) falls to the catch below, which offers Google's own page.
        if (await agreed(idToken, session)) {
            await deliver(idToken);
        }
    } catch (err) {
        error.value = noticeFrom(err, `Couldn't finish signing in to the app.`);
    } finally {
        working.value = false;
    }
};

// The fork's first road: this browser's Intentic account becomes the Google account that answered — the same trade
// the login screen makes — after which the ordinary road has one person to hand over.
const continueAsGoogle = async (): Promise<void> => {
    const pair = disagreement.value;
    if (pair === undefined) {
        return;
    }
    working.value = true;
    stage.value = `handing`;
    try {
        await signInWithGoogleCredential(pair.idToken);
    } catch (err) {
        error.value = noticeFrom(err, `Couldn't sign in to Intentic as ${pair.google}.`);
        return;
    } finally {
        working.value = false;
    }
    picking.value = false;
    disagreement.value = undefined;
    await hand();
};

// The fork's other road, and what the app's own "Switch Google account" asks for: Google is asked again with
// auto-select off, so its chooser lists every account signed in here instead of re-answering with one.
const pickAnother = async (): Promise<void> => {
    picking.value = true;
    disagreement.value = undefined;
    googleEmail.value = undefined;
    await hand();
};

// Shown from the first frame rather than after a timer; the silent attempt is often blocked (a suppressed FedCM
// prompt), and this is the only thing that can then end the wait. A render refusal means this is running in the
// desktop webview, so the fallback opens the real browser instead — carrying the same switch intent this page has.
const googleReady = ref(true);
const openInBrowser = (): void => signInThroughBrowser({ pickAccount: picking.value });

// A beat the reader has to answer before it can move: a failure, or the two accounts disagreeing.
const stalled = computed(() => error.value !== undefined || disagreement.value !== undefined);

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
                <span>{{ t(`auth.desktopAuth.desktopApp`) }}</span>
                <span class="entry-lozenge"></span>
            </p>

            <!-- Turns over on arrival: the same two beats end the sentence the page opened with. -->
            <h1 class="headline">
                <template v-if="stage === `done` && !error">
                    <span class="beat"
                        ><span class="entry-display">{{ t(`auth.desktopAuth.signedIn`) }}</span
                        ><span class="entry-stop">.</span></span
                    >
                    <span class="beat"
                        ><span class="entry-display">{{ t(`auth.desktopAuth.backToApp`) }}</span
                        ><span class="entry-stop">.</span></span
                    >
                </template>
                <template v-else>
                    <span class="beat"
                        ><span class="entry-display">{{ t(`auth.desktopAuth.finishHere`) }}</span
                        ><span class="entry-stop">.</span></span
                    >
                    <span class="beat"
                        ><span class="entry-display">{{ t(`auth.desktopAuth.appWaiting`) }}</span
                        ><span class="entry-stop">.</span></span
                    >
                </template>
            </h1>

            <!-- The reason this tab exists, at the size that answers it; it used to be the smallest print on the page. -->
            <p v-if="stage !== `done` || error" class="hero-sub">{{ t(`auth.desktopAuth.appCantShowGoogles`) }}</p>

            <!-- The one framed object, as on /login: whichever single thing this moment asks of the reader. -->
            <section class="entry-frame gate">
                <span class="entry-corner entry-corner-tl"></span>
                <span class="entry-corner entry-corner-tr"></span>
                <span class="entry-corner entry-corner-bl"></span>
                <span class="entry-corner entry-corner-br"></span>
                <span class="entry-finial" aria-hidden="true"><AppBrand shape="mark" /></span>

                <!-- The account actually crossing, which is the Google one as soon as there is a credential: naming the
                     Intentic account here while another Google account's token shipped is what made the mismatch in the
                     app unreadable. Held back while the two disagree, since the fork below names them both. -->
                <p v-if="handingEmail && !disagreement" class="whom">
                    <span class="whom-label">{{ t(`auth.desktopAuth.signingIn`) }}</span>
                    <span class="whom-mail">{{ handingEmail }}</span>
                </p>

                <template v-if="error">
                    <!-- The shared failure box, squared and set left: every other edge inside this frame is a straight rule. -->
                    <Notice :of="error" class="rounded-none text-left" />
                    <div class="gate-actions">
                        <Button :label="t(`ui.action.tryAgain`)" severity="secondary" :loading="working" @click="hand" />
                    </div>
                    <!-- Offered with the retry, since retrying alone repeats what just failed (often the platform refusing the token). -->
                    <button type="button" class="escape" v-action="useGooglesOwnPage">{{ t(`auth.desktopAuth.useGooglesOwnPage`) }}</button>
                </template>

                <!-- THE PAIR THAT WOULD NOT NAME ONE PERSON. Handing it over is what put the app in front of a sandbox
                     it could never open, with no screen able to say why; so both names are shown and the reader says
                     which of them this is. -->
                <template v-else-if="disagreement">
                    <p class="gate-say">{{ t(`auth.desktopAuth.twoAccountsHere`) }}</p>
                    <dl class="pair">
                        <div class="pair-row">
                            <dt>{{ t(`auth.desktopAuth.googleAccount`) }}</dt>
                            <dd>{{ disagreement.google }}</dd>
                        </div>
                        <div class="pair-row">
                            <dt>{{ t(`auth.desktopAuth.intenticAccount`) }}</dt>
                            <dd>{{ disagreement.intentic }}</dd>
                        </div>
                    </dl>
                    <p class="gate-aside">{{ t(`auth.desktopAuth.sandboxOpensForGoogle`) }}</p>
                    <div class="gate-actions">
                        <Button
                            :label="t(`auth.desktopAuth.continueAs`, { email: disagreement.google })"
                            class="w-full justify-center"
                            :loading="working"
                            @click="continueAsGoogle"
                        />
                        <Button
                            :label="t(`auth.desktopAuth.useDifferentGoogle`)"
                            severity="secondary"
                            class="w-full justify-center"
                            :disabled="working"
                            @click="pickAnother"
                        />
                    </div>
                </template>

                <!-- The seal is this page's one moving part: it turns while the handoff runs and locks when it lands. -->
                <template v-else-if="stage === `done`">
                    <div class="entry-seal entry-seal-lit" aria-hidden="true">
                        <span class="entry-seal-ring"></span>
                        <AppBrand shape="mark" class="entry-seal-mark" />
                    </div>
                    <p class="gate-say" role="status">{{ t(`auth.desktopAuth.closeTab`) }}</p>
                    <p class="gate-aside">{{ t(`auth.desktopAuth.appDidntComeForward`) }}</p>
                    <div class="gate-actions">
                        <Button :label="t(`auth.words.sendItAgain`)" severity="secondary" :loading="working" @click="hand" />
                    </div>
                </template>

                <template v-else-if="stage === `checking` || stage === `handing`">
                    <div class="entry-seal entry-seal-turning" aria-hidden="true">
                        <span class="entry-seal-ring"></span>
                        <span class="entry-seal-sweep"></span>
                        <AppBrand shape="mark" class="entry-seal-mark" />
                    </div>
                    <p class="gate-say" role="status">
                        <template v-if="stage === `handing`">{{ t(`auth.desktopAuth.handingSignInTo`) }}</template>
                        <template v-else>{{ t(`auth.desktopAuth.checkingWhatBrowserAlready`) }}</template>
                    </p>
                </template>

                <!-- Google may resolve this silently, or need this button; it's on screen from the start either way. -->
                <template v-else>
                    <p class="gate-say">
                        <template v-if="!googleReady">{{ t(`auth.desktopAuth.pageToRunIn`) }}</template>
                        <!-- A switch press: the button is the whole of this beat, since nothing here may answer silently. -->
                        <template v-else-if="picking">{{ t(`auth.desktopAuth.pickAccountForSandbox`) }}</template>
                        <template v-else>{{ t(`auth.desktopAuth.continueGoogleAppTakes`) }}</template>
                    </p>
                    <div v-show="googleReady" class="entry-socket">
                        <div ref="googleButton" class="entry-socket-slot"></div>
                    </div>
                    <div v-if="!googleReady" class="gate-actions">
                        <Button :label="t(`auth.desktopAuth.openInBrowser`)" class="w-full justify-center" @click="openInBrowser">
                            <template #icon><Icon name="external-link" /></template>
                        </Button>
                    </div>

                    <!-- The button is always rendered because blocked frames are indistinguishable. -->
                    <button v-if="googleReady" type="button" class="escape" v-action="useGooglesOwnPage">
                        {{ t(`auth.words.troubleSigningInUse`) }}
                    </button>
                </template>
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
                            'station-now': index === reached && !stalled,
                            'station-stalled': index === reached && stalled,
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
    color: var(--ink-lede);
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

/* The two names, set as facts between rules rather than inside a warning box: this is a question about who the
   reader is, and the plate caption above is the same object with one name in it. */
.pair {
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
    margin: 1rem 0 0;
    padding: 0.9rem 0;
    border-top: 1px solid var(--rule);
    border-bottom: 1px solid var(--rule);
    text-align: left;
}
.pair dt {
    font-size: 0.6875rem;
    font-weight: var(--font-weight-semibold);
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--gold);
}
.pair dd {
    margin: 0.15rem 0 0;
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
