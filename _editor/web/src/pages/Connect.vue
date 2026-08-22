<script setup lang="ts">
import { Button, Icon, Notice, type NoticeModel } from "@intentic/ui";
import { computed, onMounted, ref } from "vue";
import { useRoute } from "vue-router";
import { useAuth } from "../composables/useAuth";
import { environment } from "../environments/environment";
import AppBrand from "../components/AppBrand.vue";

/* WHERE A CODING AGENT'S OWNER SIGNS IN: the landing Better Auth's `mcp` plugin sends an unauthenticated
 * OAuth authorize to (api auth.ts `loginPage`).
 *
 * NOT /login, and the difference is the whole reason this file exists. /login's job is to open a workspace: it
 * ends by pushing into the shell, and the shell's guard bounces anyone without a sandbox to /setup. Somebody
 * arriving here has no sandbox and is not trying to get one: they typed `/mcp` in a terminal on their own
 * laptop and were handed a URL. Sending them to a setup wizard would be the app answering a question nobody
 * asked, at the one moment they are deciding whether this platform is worth an account.
 *
 * So this is the same Google sign-in wearing the right sentence, and it ends by handing the browser straight
 * back to the authorize URL it came from. For most people who arrive this way it is the first intentic screen
 * they ever see, which is why it says what is about to happen rather than just showing a button.
 *
 * THE QUERY IS THE AUTHORIZATION REQUEST and is carried through untouched: client id, redirect uri, PKCE
 * challenge, state. Better Auth also stashed it in a signed cookie on the way here, but the round trip is what
 * it reads on the way back, so it must survive the sign-in, which is why the callback path below is this
 * page's own full path rather than a bare "/connect". */

const route = useRoute();
const { user, refresh, signInWithGoogle, signOut } = useAuth();

const resolving = ref(true);
const error = ref<NoticeModel>();

// The original authorize query, verbatim. Absent when somebody opens /connect by hand, which is a real case
// (a bookmark, a curious click) and gets its own answer rather than a broken redirect.
const authorizeQuery = computed(() => {
    const query = route.fullPath.split(`?`)[1];
    return query === undefined || query === `` ? undefined : query;
});

const clientName = computed(() => (typeof route.query[`client_id`] === `string` ? `your coding agent` : undefined));

const handBack = (): void => {
    const query = authorizeQuery.value;
    if (query === undefined) {
        return;
    }
    window.location.href = `${environment.api.url}/api/auth/mcp/authorize?${query}`;
};

onMounted(async () => {
    try {
        await refresh();
    } catch {
        // An unreachable platform is not evidence of anything about the session; the button below still works.
        error.value = { tone: `warning`, title: `Couldn't check whether you're signed in.`, detail: `Continue with Google to carry on.` };
    }
    resolving.value = false;
    // Already signed in: there is nothing to ask, so do not make them click a button that only means "yes,
    // still me". Straight back to the authorize endpoint, which will redirect on to the agent.
    if (user.value !== null && authorizeQuery.value !== undefined) {
        handBack();
    }
});

const signIn = (): Promise<void> => signInWithGoogle(route.fullPath);

const switchAccount = async (): Promise<void> => {
    await signOut();
    await signIn();
};
</script>

<template>
    <div class="flex min-h-screen w-full items-center justify-center bg-canvas p-6 text-content">
        <div class="animate-fade-in w-full max-w-sm">
            <AppBrand class="mb-10 text-2xl" />

            <div v-if="resolving" class="flex items-center gap-3 text-sm text-muted">
                <Icon name="spinner" spin />
                <span>Checking your session…</span>
            </div>

            <!-- Opened by hand. Not an error: just a page with nothing to do, so it says what it is for. -->
            <template v-else-if="!authorizeQuery">
                <h2 class="text-2xl font-semibold tracking-tight">Nothing to connect</h2>
                <p class="mt-2 text-sm text-muted">
                    This page finishes connecting a coding agent to intentic. Start it from your agent: in Claude Code, install the intentic plugin
                    and run <span class="font-mono text-content">/mcp</span>.
                </p>
            </template>

            <!-- Signed in, mid-hand-back. A beat of explanation rather than a blank screen, because the
                 redirect below it is already in flight. -->
            <template v-else-if="user">
                <h2 class="text-2xl font-semibold tracking-tight">Connecting…</h2>
                <p class="mt-2 text-sm text-muted">
                    Signed in as <span class="font-medium text-content">{{ user.email }}</span
                    >. Sending you back to your agent.
                </p>
                <Button label="Use a different account" severity="secondary" text class="mt-6 px-0" @click="switchAccount" />
            </template>

            <template v-else>
                <h2 class="text-2xl font-semibold tracking-tight">Connect to intentic</h2>
                <p class="mt-2 text-sm text-muted">
                    Sign in and {{ clientName ?? `your coding agent` }} will be able to read the premium services catalogue and ask you to run one.
                </p>
                <!-- The three things a reader wants to know before granting anything, in the order they think
                     of them. Said here rather than on a consent screen further in, because this is the screen
                     they are actually deciding on. -->
                <ul class="mt-5 flex flex-col gap-2.5">
                    <li class="flex gap-2.5 text-xs text-muted">
                        <Icon name="shield" class="mt-0.5 shrink-0 text-sm text-success" />
                        <span>It can never spend on its own. Every paid run needs your click on a page here first.</span>
                    </li>
                    <li class="flex gap-2.5 text-xs text-muted">
                        <Icon name="eye-slash" class="mt-0.5 shrink-0 text-sm text-success" />
                        <span>It gets no access to your code, your files, or anything else on this platform.</span>
                    </li>
                    <li class="flex gap-2.5 text-xs text-muted">
                        <Icon name="undo" class="mt-0.5 shrink-0 text-sm text-success" />
                        <span>No sandbox and no install needed: an account is enough.</span>
                    </li>
                </ul>
                <Button label="Continue with Google" severity="secondary" class="mt-6 w-full justify-center" @click="signIn">
                    <template #icon><Icon name="google" /></template>
                </Button>
            </template>

            <Notice v-if="error" :of="error" class="mt-4" />
        </div>
    </div>
</template>
