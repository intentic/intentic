<!-- Where a sign-in mail's link lands: one press spends the code it carries. Wears the entry material, as /login does. -->
<script setup lang="ts">
import { AppBrand, Button, Notice, type NoticeModel } from "@intentic/ui";
import { noticeFrom, noticeOf } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { z } from "zod";
import { useAuth } from "../../client/auth/useAuth";
import { CODE_LENGTH, codeDigits, EmailCodeError, plausibleAddress } from "../../client/auth/emailCode";
import { returnPath } from "../../lib/routes/signIn";
import EmailCodeSignIn from "./EmailCodeSignIn.vue";

// THE MAIL'S LINK, `/login/confirm?email=…&code=…[&returnTo=…]`. It never signs in on load: mail scanners fetch every
// link in a message to judge it, and a page that spent the code on a GET would sign the scanner in, or spend the code
// before its reader got here. So it names the address and waits for a press. The values leave the address bar the moment
// the page mounts (kept in memory only), so neither the history, a shared screenshot nor a pasted URL carries a live
// code. The page loads nothing from another origin, and the app's Referrer-Policy (nginx.conf) sends other origins the
// bare origin at most; index.html leaves Google's script off this path for that reason.

const t = useT();
const route = useRoute();
const router = useRouter();
const { signInWithEmailCode } = useAuth();

// What the link carries, as the mail wrote it; a part repeated or missing reads as missing.
const LinkSchema = z.object({
    email: z.string().min(1).optional().catch(undefined),
    code: z.string().min(1).optional().catch(undefined),
});

// Read once, before the address bar is cleared; the route's own query is left alone, which nothing reads again.
const link = LinkSchema.parse(route.query);
const email = link.email?.trim().toLowerCase();
const code = link.code === undefined ? undefined : codeDigits(link.code);
const destination = returnPath(route.query[`returnTo`]);
// A link that lost a part on the way (a mail client that cut it) has nothing to confirm.
const complete = email !== undefined && plausibleAddress(email) && code?.length === CODE_LENGTH;

const state = ref<`ready` | `signing-in` | `refused` | `done`>(`ready`);
const notice = ref<NoticeModel>();

// The router keeps the address it navigated to in the history entry's own state (`current`), so that copy is cleared
// with the bar's: a code left there would ride the tab's history after the page is gone.
const RouterStateSchema = z.looseObject({ current: z.string() });
onMounted(() => {
    const path = globalThis.location.pathname;
    const routerState = RouterStateSchema.safeParse(globalThis.history.state);
    globalThis.history.replaceState(routerState.success ? { ...routerState.data, current: path } : globalThis.history.state, ``, path);
});

const land = async (): Promise<void> => {
    state.value = `done`;
    await router.replace(destination);
};

const confirm = async (): Promise<void> => {
    if (!complete || email === undefined || code === undefined || state.value === `signing-in`) {
        return;
    }
    state.value = `signing-in`;
    notice.value = undefined;
    try {
        await signInWithEmailCode(email, code);
        await land();
    } catch (error) {
        // A code this link carried that no longer signs in (spent by the code field, run out, guessed at) is a fresh
        // code away, mailed to the same address; anything else is said in the platform's words, with a retry.
        const spent = error instanceof EmailCodeError && error.refusal !== `failed` && error.refusal !== `rate-limited`;
        notice.value = noticeFrom(error, t(`auth.loginConfirm.linkDidntSignIn`), { tone: `warning` });
        state.value = spent ? `refused` : `ready`;
    }
};

const brokenNotice = noticeOf(t(`auth.loginConfirm.linkIncomplete`), { tone: `warning` });
</script>

<template>
    <div class="entry arrival">
        <div class="entry-plate" aria-hidden="true"><div class="entry-plate-img"></div></div>

        <main class="shell">
            <header class="mark"><AppBrand /></header>

            <section class="entry-frame gate">
                <span class="entry-corner entry-corner-tl"></span>
                <span class="entry-corner entry-corner-tr"></span>
                <span class="entry-corner entry-corner-bl"></span>
                <span class="entry-corner entry-corner-br"></span>

                <!-- A link with a part missing: the sign-in page is where a code can be asked for again. -->
                <template v-if="!complete">
                    <Notice :of="brokenNotice" class="rounded-none text-left" />
                    <Button :label="t(`auth.desktopAuthComplete.backToSignIn`)" tier="boring" class="mt-4 self-center" @click="void router.replace(`/login`)" />
                </template>

                <!-- The code is spent: one more mail to the same address, typed here this time. -->
                <template v-else-if="state === `refused`">
                    <Notice v-if="notice" :of="notice" class="mb-4 rounded-none text-left" />
                    <EmailCodeSignIn :locked-email="email" @signed-in="land" />
                </template>

                <template v-else>
                    <h1 class="title">{{ t(`auth.loginConfirm.title`) }}</h1>
                    <i18n-t keypath="auth.loginConfirm.signInAs" tag="p" class="say" scope="global">
                        <template #email
                            ><span class="who">{{ email }}</span></template
                        >
                    </i18n-t>
                    <div role="status">
                        <Notice v-if="notice" :of="notice" class="mt-4 rounded-none text-left" />
                    </div>
                    <Button
                        :label="t(`auth.loginConfirm.confirm`)"
                        class="mt-5 w-full justify-center"
                        :loading="state === `signing-in` || state === `done`"
                        @click="confirm"
                    >
                        <template #icon><Icon name="sign-in" /></template>
                    </Button>
                    <!-- The first sign-in makes the account, so the terms stand here as they did where the code was asked for. -->
                    <p class="fine">
                        {{ t(`auth.login.weKeepEmailAddress`) }}
                        <a href="https://intentic.dev/terms/" target="_blank" rel="noopener noreferrer">{{ t(`auth.login.terms`) }}</a
                        >, <a href="https://intentic.dev/acceptable-use/" target="_blank" rel="noopener noreferrer">{{ t(`auth.login.acceptableUsePolicy`) }}</a>
                        {{ t(`auth.login.and`) }}
                        <a href="https://intentic.dev/privacy/" target="_blank" rel="noopener noreferrer">{{ t(`auth.login.privacyPolicy`) }}</a
                        >.
                    </p>
                    <p class="fine">{{ t(`auth.loginConfirm.notYou`) }}</p>
                </template>
            </section>
        </main>
    </div>
</template>

<style scoped>
/* Layout only; the plate and the frame are shared material in @intentic/entry-css, as on /desktop-auth/complete. */
.arrival {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: clamp(1rem, 2.5vw, 2rem) 1.5rem;
}
.shell {
    display: flex;
    flex-direction: column;
    align-items: center;
    width: 100%;
    max-width: 27rem;
    margin: auto;
    text-align: center;
}
.mark {
    font-size: 1.375rem;
    margin-bottom: clamp(1.5rem, 5vh, 2.75rem);
}
.gate {
    display: flex;
    flex-direction: column;
    width: 100%;
    padding: 1.75rem 1.75rem 1.5rem;
}
.title {
    font-family: var(--face-display);
    font-size: 1.5rem;
    font-weight: var(--font-weight-semibold);
    color: var(--ink);
}
.say {
    margin-top: 0.5rem;
    font-size: 0.9375rem;
    color: var(--ink-muted);
}
.who {
    word-break: break-all;
    font-weight: var(--font-weight-semibold);
    color: var(--ink);
}
.fine {
    margin-top: 1.1rem;
    font-size: 0.75rem;
    line-height: 1.6;
    color: var(--ink-subtle);
    text-wrap: pretty;
}
.fine a {
    color: var(--gold-bright);
    text-decoration: underline;
}
.fine a:hover {
    text-decoration: underline;
}
</style>
