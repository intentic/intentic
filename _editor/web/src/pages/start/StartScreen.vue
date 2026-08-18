<script setup lang="ts">
import { CopyButton, Notice } from "@intentic/ui";
import Button from "primevue/button";
import { computed, onUnmounted, ref, watch, watchEffect } from "vue";
import { useRouter } from "vue-router";
import ConnectOffer from "../../chat/ConnectOffer.vue";
import { startAgent } from "../../composables/agents/agentActions";
import { offerOnBoard } from "../../composables/chat/connectOffer";
import { useChat } from "../../composables/chat/useChat";
import { usePanels } from "../../composables/extensions/usePanels";
import { usePublicOutbox } from "../../composables/workspace/usePublicOutbox";
import { BUILD_IDEAS, blockedPage, buildPrompt, builtPage, markFirstRunDone } from "./firstRun";

/* THE FIRST SCREEN, and the only one in this product whose job is to GIVE something before it asks for
 * anything. The reasoning for its existence is in firstRun.ts; this file is what the reader sees.
 *
 * IT HAS EXACTLY THREE STATES and they are decided by facts, never by a step counter:
 *   · nothing can send yet   → the connect offer, the same card every other gate shows
 *   · nothing built yet      → one question, three examples, and a way out
 *   · a page is in the outbox → the page itself, at its public address
 * The third is read off the OUTBOX rather than off a local "did I press build" flag, which is what makes a
 * reload mid-build land back on the result instead of back on the question.
 *
 * IT STANDS DOWN RATHER THAN INSISTING. A workspace that already has repositories is somebody who came here
 * with work, and the demo must never be in their way — the guard below leaves the moment the panel list says
 * so, and the skip link is a single press at every other moment. */

const router = useRouter();
const chat = useChat();
const { connected, accountsLoaded } = chat;
const { panels, settled: panelsSettled } = usePanels();

const idea = ref(``);
// Pressed. Only ever widens what is shown — the result state below can also be reached by the outbox alone.
const started = ref(false);

/* The tick is bought for exactly as long as it buys something: from the press until the page is on screen.
 * (usePublicOutbox explains why a push cannot be relied on for this directory on a repo-less sandbox.) A ref
 * fed by an effect rather than a getter, because the condition depends on the very files the read returns —
 * a getter closing over `page` would reference it before its own declaration. */
const watching = ref(false);
const { files, url: outboxUrl, settled: outboxSettled } = usePublicOutbox(watching);

const page = computed(() => builtPage(files.value));
watchEffect(() => (watching.value = started.value && page.value === undefined));
const refused = computed(() => (page.value === undefined ? blockedPage(files.value) : undefined));
/* A REFUSED PAGE COUNTS AS A RESULT, and that is not a detail. The refusal notice is the only place anyone is
 * ever told why a file in the outbox is not being served — a stranger requesting it gets the same 404 as any
 * other miss — so a reload that landed back on the question would take the one explanation there is off the
 * screen and leave a user staring at a page they built and cannot see. */
const showingResult = computed(() => started.value || page.value !== undefined || refused.value !== undefined);

/* A sandbox with no tunnel has nowhere to publish to, and a screen promising a public link on one would be
 * lying. The page still gets built and still gets shown — only the sharing half is absent, and it says so. */
const publishable = computed(() => !outboxSettled.value || outboxUrl.value !== undefined);

/* THE OFFER IS MADE ONCE PER SCREEN. This surface owns the whole window while it is asking, so the docked chat
 * drops its identical copy — the same arrangement, and the same reason, as the empty board's (connectOffer). */
const offering = computed(() => !connected.value && !showingResult.value);
watch(offering, (on) => (offerOnBoard.value = on), { immediate: true });
onUnmounted(() => (offerOnBoard.value = false));

const leave = (): void => {
    markFirstRunDone();
    void router.replace(`/workspace`);
};

/* CAME HERE WITH WORK ALREADY IN THE BOX. Only once the list has actually arrived: acting on the empty value a
 * pending query reports would bounce every user off this screen before it ever rendered. */
watch(
    [panelsSettled, panels],
    ([ready, repos]) => {
        if (ready && repos.length > 0 && !showingResult.value) {
            leave();
        }
    },
    { immediate: true },
);

const build = (): void => {
    const wanted = idea.value.trim();
    if (wanted.length === 0) {
        return;
    }
    started.value = true;
    /* ANSWERED, and recorded now rather than when the user finally leaves. The press IS the choice this screen
     * exists to collect; waiting for the way-out button would mean anybody who wandered off through the rail
     * instead got sent back here by the shell's entry on every session afterwards — the demo becoming the
     * thing it was built to stop being. Reaching /start again still shows the page, because the result state
     * is read off the outbox. */
    markFirstRunDone();
    /* An ordinary first turn in an ordinary conversation: it sits in the transcript, the composer keeps the
     * caret, and Stop works on it.
     *
     * WHERE THE BUILD IS WATCHED DIFFERS BY FORM FACTOR, and both are deliberate. On desktop the chat is
     * docked beside this pane, so the work narrates itself one column over while the artifact lands here. On
     * mobile there is no dock — startAgent goes to the conversation's own screen, which is the better place to
     * watch a turn on a phone, and the agent's closing message carries the same public link this pane would
     * have framed. Coming back here shows the page whenever they want it. */
    startAgent(buildPrompt(wanted));
};
</script>

<template>
    <div class="flex h-full flex-col items-center justify-center overflow-y-auto px-6 py-8">
        <!-- ── 1. NOTHING CAN SEND YET ─────────────────────────────────────────────────────────────────── -->
        <div v-if="offering" class="flex w-full max-w-md flex-col gap-4">
            <div class="flex flex-col gap-1 text-center">
                <h1 class="text-base font-semibold text-content">Let's build something</h1>
                <p class="text-xs text-muted">Connect an AI account and the first thing you'll get is a working page at your own public link.</p>
            </div>
            <div class="rounded-xl border border-line bg-card px-5 py-6">
                <p v-if="!accountsLoaded" class="flex items-center justify-center gap-2 text-xs text-muted">
                    <Icon name="spinner" spin />Checking your AI accounts…
                </p>
                <ConnectOffer v-else :view="chat" prominent />
            </div>
            <button type="button" class="text-2xs text-subtle underline-offset-2 hover:text-content hover:underline" @click="leave">
                Skip — I have my own code
            </button>
        </div>

        <!-- ── 2. THE QUESTION ─────────────────────────────────────────────────────────────────────────── -->
        <div v-else-if="!showingResult" class="flex w-full max-w-xl flex-col gap-5">
            <div class="flex flex-col gap-1.5 text-center">
                <h1 class="text-lg font-semibold text-content">What should I build?</h1>
                <p class="text-xs text-muted">
                    Say it in a sentence. You'll get a real page, live at a link you can open on your phone, in about a minute.
                </p>
            </div>

            <!-- The examples FILL the box rather than sending: the edit is what makes the idea theirs. -->
            <div class="flex flex-wrap items-center justify-center gap-1.5">
                <button
                    v-for="example in BUILD_IDEAS"
                    :key="example.label"
                    type="button"
                    class="rounded-full border border-line px-2.5 py-1 text-2xs text-muted transition-colors hover:border-line-strong hover:bg-overlay hover:text-content"
                    @click="idea = example.idea"
                >
                    {{ example.label }}
                </button>
            </div>

            <form class="flex flex-col gap-2" @submit.prevent="build">
                <label class="sr-only" for="first-run-idea">What should I build?</label>
                <textarea
                    id="first-run-idea"
                    v-model="idea"
                    rows="3"
                    placeholder="A one-page site for my dog-walking business…"
                    class="w-full resize-none rounded-xl border border-line bg-canvas px-3 py-2.5 text-sm text-content placeholder:text-subtle focus:border-primary-500 focus:outline-none"
                    @keydown.enter.meta.prevent="build"
                    @keydown.enter.ctrl.prevent="build"
                />
                <div class="flex items-center justify-between gap-3">
                    <button type="button" class="text-2xs text-subtle underline-offset-2 hover:text-content hover:underline" @click="leave">
                        Skip — I have my own code
                    </button>
                    <Button type="submit" :disabled="idea.trim().length === 0"> <Icon name="sparkles" />Build it </Button>
                </div>
            </form>
        </div>

        <!-- ── 3. THE ARTIFACT ─────────────────────────────────────────────────────────────────────────── -->
        <div v-else class="flex w-full max-w-3xl flex-col gap-3">
            <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
                <h1 class="text-base font-semibold text-content">
                    {{ page === undefined ? `Building your page…` : `Your page is live` }}
                </h1>
                <p v-if="page === undefined" class="flex items-center gap-1.5 text-2xs text-muted">
                    <Icon name="spinner" spin />Watch it work in the chat beside this.
                </p>
                <button type="button" class="ml-auto text-2xs text-subtle underline-offset-2 hover:text-content hover:underline" @click="leave">
                    Go to my workspace
                </button>
            </div>

            <!-- A guard refused the page. Only the publisher can ever be told this — a stranger requesting the
                 same file gets the 404 every other miss gets — so saying it here is the only way it is said. -->
            <Notice
                v-if="refused !== undefined"
                :of="{
                    tone: `warning`,
                    title: `That page was built but isn't being served.`,
                    detail: `${refused.path} — ${refused.blocked}. Ask the chat to rename it or take the flagged content out, and it will publish itself.`,
                }"
            />

            <div class="overflow-hidden rounded-xl border border-line bg-card">
                <!-- The artifact itself. Cross-origin and without `allow-same-origin`, so the built page can
                     run its own scripts (a game was one of the three things offered) and can reach nothing of
                     this app's. -->
                <iframe
                    v-if="page?.url !== undefined"
                    :src="page.url"
                    title="The page you just built"
                    sandbox="allow-scripts"
                    referrerpolicy="no-referrer"
                    class="h-[26rem] w-full bg-white"
                />
                <div v-else class="flex h-[26rem] flex-col items-center justify-center gap-3 text-center">
                    <Icon name="spinner" spin class="text-2xl text-subtle" />
                    <p class="max-w-xs text-xs text-muted">Writing the page. It appears here the moment it lands.</p>
                </div>
            </div>

            <!-- THE POINT OF THE WHOLE SCREEN: a link that works for anyone, said plainly enough that
                 "shareable" can never be misread as "leaked". -->
            <div v-if="page?.url !== undefined" class="flex flex-col gap-2 rounded-xl border border-line bg-card p-3">
                <div class="flex items-center gap-2">
                    <Icon name="globe" class="shrink-0 text-base text-link" />
                    <a :href="page.url" target="_blank" rel="noreferrer" class="min-w-0 flex-1 truncate text-xs text-link hover:underline">
                        {{ page.url }}
                    </a>
                    <CopyButton :text="page.url" aria-label="Copy the public link" />
                </div>
                <p class="text-2xs text-subtle">
                    Anyone with this link can open it — no sign-in. It comes from the <code>public</code> folder in your workspace; delete the file
                    there and the link stops working.
                </p>
            </div>
            <p v-else-if="!publishable" class="text-2xs text-subtle">
                This sandbox has no public address, so the page can't be shared from here. It's still in your workspace.
            </p>
        </div>
    </div>
</template>
