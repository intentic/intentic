<script setup lang="ts">
import { Button, Card, cmp, Icon, Markdown, StatusBadge, type StatusVariant, timeAgo } from "@intentic/extension-ui";
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import { host } from "./host";
import { reposOf, storyDir, type Verdict, verdictTone } from "./runs";
import type { LiveBrowser, RunRow, StoryOutcome } from "./useRuns";

/* One run, story by story: the verdict, the walkthrough the agent wrote, and the screenshots it took at each
 * step. A story with no result yet shows the live session instead — the fleet already knows what it is doing,
 * and "still walking the page" is a truer answer than a blank row.
 *
 * WATCHING. While a session is live, its Chromium is streamed by the daemon (browser-sessions.ts attaches over
 * CDP on the agent's first browser call) into the shell's Browsers area, a tab per open page and a Take control
 * button. This row is the pointer at it — the reason a run is supervisable rather than merely reportable. The
 * button appears only for a session the daemon has actually listed; see useRuns' `browsers` for why it is never
 * derived and offered blind.
 *
 * SCREENSHOTS are the fiddly part. A report references them relatively (`![](shots/03-error.png)`) because that
 * is what makes the file readable on its own, in an editor or a terminal. The browser cannot load those: they
 * sit outside any served origin and reach it only through the daemon's authenticated /workspace/raw, which
 * means an object URL. And an object URL cannot be substituted into the markdown SOURCE, because the sanitizer
 * strips `blob:` from an img src (verified: DOMPurify's default URI allowlist has no blob scheme) while leaving
 * a relative path alone. So the swap happens AFTER sanitizing, imperatively on the rendered DOM — which is also
 * the only place the fetch can be lazy, one story at a time, instead of pulling every shot of every story. */

const { run, outcomes, browsers, loading, stop } = defineProps<{
    run: RunRow;
    outcomes: Readonly<Record<string, StoryOutcome>>;
    // Live browsers by conversationId — see useRuns.
    browsers: Readonly<Record<string, LiveBrowser>>;
    loading: boolean;
    // Ends one story's session. A fan-out of ten unattended sessions has to be stoppable from the surface that
    // started it — sending someone to the Agents board to find the ten cards this view already knows about is
    // the kind of errand that gets a run left running instead.
    stop: (conversationId: string) => Promise<void>;
}>();

const api = host();
const open = ref(new Set<string>());
const failure = ref<string | undefined>(undefined);
// Object URLs by workspace path, minted once per shot and revoked together when this view goes away.
const shots = reactive<Record<string, string>>({});
const reportEl = ref<Record<string, HTMLElement | undefined>>({});

const toggle = (slug: string): void => {
    const next = new Set(open.value);
    if (!next.delete(slug)) {
        next.add(slug);
    }
    open.value = next;
};

const conversationOf = (slug: string): string | undefined => run.manifest.stories.find((story) => story.slug === slug)?.conversationId;
const browserOf = (slug: string): LiveBrowser | undefined => {
    const id = conversationOf(slug);
    return id === undefined ? undefined : browsers[id];
};

const verdictBadge = (slug: string): { readonly label: string; readonly variant: StatusVariant } => {
    const verdict: Verdict | undefined = outcomes[slug]?.result?.verdict;
    if (verdict !== undefined) {
        return { label: verdict, variant: verdictTone(verdict) };
    }
    const agent = run.agents.find((entry) => entry.id === conversationOf(slug));
    if (agent === undefined) {
        return { label: loading ? `…` : `no session`, variant: `neutral` };
    }
    return { label: agent.status, variant: agent.status === `running` || agent.status === `awaiting` ? `info` : `neutral` };
};

const openSession = (slug: string): void => {
    const id = conversationOf(slug);
    if (id !== undefined) {
        api.navigate(`/agents/${encodeURIComponent(id)}`);
    }
};

// Live only: a settled session has nothing to stop, and the button would then be an offer to do nothing.
const isLive = (slug: string): boolean => {
    const status = run.agents.find((entry) => entry.id === conversationOf(slug))?.status;
    return status === `running` || status === `awaiting`;
};

const halt = async (slug: string): Promise<void> => {
    const id = conversationOf(slug);
    if (id === undefined) {
        return;
    }
    failure.value = undefined;
    try {
        await stop(id);
    } catch (error) {
        failure.value = error instanceof Error ? error.message : String(error);
    }
};

/* The agent's live one-liner while there is no report to read. The page its browser is on comes FIRST when there
 * is one: during a walkthrough "on /checkout/payment" is the most informative thing anyone can be told in six
 * words, and it is the same fact the Watch button acts on. Otherwise the fleet's own "last tool, current todo",
 * so this view is never a worse version of the board. */
const activityOf = (slug: string): string | undefined => {
    const url = browserOf(slug)?.url;
    if (url !== undefined && url !== ``) {
        return url;
    }
    const agent = run.agents.find((entry) => entry.id === conversationOf(slug));
    const activity = agent?.activity;
    return (
        activity?.todo ?? (activity?.tool === undefined ? undefined : `${activity.tool}${activity.target === undefined ? `` : ` ${activity.target}`}`)
    );
};

const blobFor = async (path: string): Promise<string | undefined> => {
    if (shots[path] !== undefined) {
        return shots[path];
    }
    try {
        const response = await api.sandbox.request(`/workspace/raw?path=${encodeURIComponent(path)}`);
        if (!response.ok) {
            return undefined;
        }
        const url = URL.createObjectURL(await response.blob());
        shots[path] = url;
        return url;
    } catch {
        return undefined;
    }
};

/* Resolve the rendered report's relative <img> sources against the story's own run directory. Runs after every
 * render of an open story (flush: post — the v-html has to exist first) and is idempotent: an image already
 * pointed at an object URL has no relative src left to match. */
const resolveShots = (slug: string): void => {
    const container = reportEl.value[slug];
    if (container === undefined) {
        return;
    }
    for (const image of container.querySelectorAll(`img`)) {
        const source = image.getAttribute(`src`) ?? ``;
        if (source === `` || /^[a-z]+:/i.test(source) || source.startsWith(`/`)) {
            continue;
        }
        image.removeAttribute(`src`);
        image.classList.add(`max-w-full`, `rounded-md`, `border`, `border-line`);
        void blobFor(`${storyDir(run.manifest.runId, slug)}/${source.replace(/^\.\//, ``)}`).then((url) => {
            if (url !== undefined) {
                image.src = url;
            }
        });
    }
};

watch(
    [open, () => outcomes],
    () => {
        for (const slug of open.value) {
            resolveShots(slug);
        }
    },
    { flush: `post`, deep: true },
);

onBeforeUnmount(() => {
    for (const url of Object.values(shots)) {
        URL.revokeObjectURL(url);
    }
});

const defects = computed(() => run.manifest.stories.flatMap((story) => outcomes[story.slug]?.result?.defects ?? []));
// One line per repo the run touched: which app each story was walked through. A run that spanned two repos is
// unreadable a week later without it.
const addresses = computed(() => reposOf(run.manifest).map((repo) => ({ repo, url: run.manifest.targets[repo] })));
</script>

<template>
    <div class="flex flex-col gap-4">
        <Card class="p-4">
            <div class="flex flex-col gap-1">
                <div v-for="address in addresses" :key="address.repo" class="flex items-baseline gap-2 text-xs">
                    <span class="font-mono text-muted">{{ address.repo }}</span>
                    <span class="truncate font-mono text-content">{{ address.url ?? `—` }}</span>
                </div>
            </div>
            <div class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
                <span>{{ run.manifest.provider }}{{ run.manifest.model ? ` · ${run.manifest.model}` : `` }}</span>
                <span>{{ timeAgo(run.manifest.createdAt) }}</span>
                <span v-if="defects.length > 0" class="text-danger">{{ defects.length }} {{ defects.length === 1 ? `defect` : `defects` }}</span>
            </div>
        </Card>

        <div v-if="failure" :class="cmp.alertDanger()">{{ failure }}</div>

        <div class="overflow-hidden rounded-lg border border-line bg-card">
            <div v-for="story in run.manifest.stories" :key="story.slug" class="border-b border-line last:border-b-0">
                <div class="flex items-center gap-3 px-4 py-2.5">
                    <button
                        type="button"
                        class="flex min-w-0 flex-1 cursor-pointer items-center gap-3 text-left"
                        :aria-expanded="open.has(story.slug)"
                        @click="toggle(story.slug)"
                    >
                        <Icon :name="open.has(story.slug) ? `chevron-down` : `chevron-right`" class="shrink-0 text-subtle" />
                        <span class="min-w-0 flex-1">
                            <span class="block truncate text-sm text-content">{{ story.title }}</span>
                            <span class="block truncate font-mono text-2xs text-subtle">
                                {{ story.repo }}<template v-if="activityOf(story.slug)"> · {{ activityOf(story.slug) }}</template>
                            </span>
                        </span>
                    </button>
                    <StatusBadge :variant="verdictBadge(story.slug).variant" :label="verdictBadge(story.slug).label" size="xs" />
                    <!-- The supervision button. Only while the daemon lists this session's Chromium: it opens
                         the Browsers area on the live screencast, where the view's own control offers the
                         keyboard and mouse if the user wants to intervene. -->
                    <Button
                        v-if="browserOf(story.slug)"
                        label="Watch"
                        size="small"
                        severity="secondary"
                        @click="api.navigate(`/browsers/${browserOf(story.slug)?.session ?? ``}`)"
                    >
                        <template #icon><Icon name="eye" /></template>
                    </Button>
                    <Button label="Session" size="small" severity="secondary" @click="openSession(story.slug)">
                        <template #icon><Icon name="comments" /></template>
                    </Button>
                    <Button v-if="isLive(story.slug)" label="Stop" size="small" severity="secondary" @click="halt(story.slug)">
                        <template #icon><Icon name="stop" /></template>
                    </Button>
                </div>

                <div v-if="open.has(story.slug)" class="border-t border-line/60 bg-canvas px-4 py-3">
                    <!-- The report is the artifact; everything else on this row is a summary of it. -->
                    <div v-if="outcomes[story.slug]?.report" :ref="(el) => (reportEl[story.slug] = el as HTMLElement)">
                        <Markdown :source="outcomes[story.slug]?.report ?? ``" />
                    </div>
                    <div v-else :class="cmp.emptyState()">
                        {{
                            verdictBadge(story.slug).variant === `info`
                                ? `Still testing — the report is written at the end of the walkthrough.`
                                : `No report was written. Open the session to see how far it got.`
                        }}
                    </div>

                    <!-- The criteria matrix: the story's own promises, one verdict each, in the order they were
                         authored. It is the one part of result.json the report's prose does not already say in
                         order — and the reason the brief hands the agent a numbered list. -->
                    <ul v-if="(outcomes[story.slug]?.result?.criteria ?? []).length > 0" class="mt-3 flex flex-col gap-1">
                        <li
                            v-for="(criterion, index) in outcomes[story.slug]?.result?.criteria ?? []"
                            :key="index"
                            class="flex items-start gap-2 text-xs"
                        >
                            <Icon
                                :name="criterion.verdict === `pass` ? `check-circle` : criterion.verdict === `fail` ? `exclamation-circle` : `circle`"
                                :class="[
                                    'mt-0.5 shrink-0',
                                    criterion.verdict === `pass` ? `text-success` : criterion.verdict === `fail` ? `text-danger` : `text-subtle`,
                                ]"
                            />
                            <span class="min-w-0 flex-1 text-muted">
                                {{ criterion.text }}
                                <span v-if="criterion.note" class="text-subtle"> — {{ criterion.note }}</span>
                            </span>
                        </li>
                    </ul>
                </div>
            </div>
        </div>
    </div>
</template>
