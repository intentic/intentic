<script setup lang="ts">
import { errorMessage } from "@intentic/base/errors";
import {
    appLink,
    Button,
    Card,
    DisclosureRow,
    ui,
    Icon,
    Markdown,
    Notice,
    noticeOf,
    StatusBadge,
    timeAgo,
    type StatusVariant,
} from "@intentic/extension-ui";
import { computed, onBeforeUnmount, reactive, ref, watch } from "vue";
import { host } from "./host";
import { isShotPath, storyDir, storyStanding } from "./runs";
import { launchFailureOf, type LiveBrowser, type RunRow, type StoryOutcome } from "./useRuns";

// One run, story by story: verdict, walkthrough, and screenshots; a story with no result yet shows its live session
// instead. Watch streams that session's Chromium into the Browsers area, shown only once the daemon actually lists it.
// Screenshots, referenced relatively in the report markdown, resolve to authenticated object URLs after sanitizing, one
// open story at a time.

const { run, outcomes, browsers, loading, stop, retry } = defineProps<{
    run: RunRow;
    outcomes: Readonly<Record<string, StoryOutcome>>;
    // Live browsers by conversationId; see useRuns.
    browsers: Readonly<Record<string, LiveBrowser>>;
    loading: boolean;
    // Ends one story's session, callable from here rather than the Agents board, so a fan-out of unattended sessions
    // can be stopped from the surface that started it.
    stop: (conversationId: string) => Promise<void>;
    // Relaunches a story whose request was refused before a fleet session ever existed.
    retry: (runId: string, slug: string) => Promise<void>;
}>();

const api = host();
const open = ref(new Set<string>());
const failure = ref<string | undefined>(undefined);
const retrying = ref(new Set<string>());
// Object URLs by workspace path, minted once per shot and revoked together when this view unmounts.
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

const agentOf = (slug: string) => run.agents.find((entry) => entry.id === conversationOf(slug));
const unstartedFailureOf = (slug: string): string | undefined =>
    outcomes[slug]?.result === undefined && outcomes[slug]?.report === undefined && outcomes[slug]?.invalidResult !== true
        ? launchFailureOf(run, slug)
        : undefined;

// Why a story was never walked: the session's own last words, kept only while its card still reads as failed; without
// this a refused session showed only a grey "error" with no reason reachable anywhere.
const failureOf = (slug: string): string | undefined => agentOf(slug)?.failure ?? unstartedFailureOf(slug);

// This row's badge, sharing runs.ts's standing logic plus two report-only answers (still reading artifacts, or no
// session on the roster), so this view and the stories list never disagree.
const verdictBadge = (slug: string): { readonly label: string; readonly variant: StatusVariant } => {
    if (outcomes[slug]?.invalidResult === true) {
        return { label: `invalid result`, variant: `danger` };
    }
    const agent = agentOf(slug);
    const standing = storyStanding(outcomes[slug]?.result?.verdict, agent?.status);
    if (standing !== undefined) {
        return standing;
    }
    if (unstartedFailureOf(slug) !== undefined) {
        return { label: `not started`, variant: `danger` };
    }
    if (agent === undefined) {
        return { label: loading ? `…` : `no session`, variant: `neutral` };
    }
    return { label: agent.status, variant: `neutral` };
};

// Both real links (appLink), so the address, its menu and Ctrl/Cmd-click all work; each renders only where its id
// exists, so the empty fallback path is unreachable.
const sessionLink = (slug: string) => {
    const id = conversationOf(slug);
    const path = id === undefined ? `/agents` : `/agents/${encodeURIComponent(id)}`;
    // A plain click opens the agent's conversation in the docked chat rather than navigating away.
    return appLink(api.href(path), () => (id === undefined ? api.navigate(path) : api.chat.openAgent(id)));
};
const browserLink = (slug: string) => {
    const path = `/browsers/${browserOf(slug)?.session ?? ``}`;
    return appLink(api.href(path), () => api.navigate(path));
};

// Live only: a settled session has nothing to stop, and the button would offer to do nothing.
const isLive = (slug: string): boolean => {
    const status = agentOf(slug)?.status;
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
        failure.value = errorMessage(error);
    }
};

const relaunch = async (slug: string): Promise<void> => {
    retrying.value = new Set([...retrying.value, slug]);
    failure.value = undefined;
    try {
        await retry(run.manifest.runId, slug);
    } catch (error) {
        failure.value = errorMessage(error);
    } finally {
        const next = new Set(retrying.value);
        next.delete(slug);
        retrying.value = next;
    }
};

// The agent's live one-liner when there's no report yet: the browser's own page first (the same fact the Watch button
// acts on), else the fleet's last-tool/current-todo.
const activityOf = (slug: string): string | undefined => {
    const url = browserOf(slug)?.url;
    if (url !== undefined && url !== ``) {
        return url;
    }
    const activity = agentOf(slug)?.activity;
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

// Runs after sanitizing but before v-html inserts the fragment, dropping every image outside the story-local convention
// so a remote source is never even briefly fetched; resolveShots later fills the accepted ones in.
const restrictReportImages = (fragment: DocumentFragment): void => {
    for (const image of fragment.querySelectorAll(`img`)) {
        const relative = (image.getAttribute(`src`) ?? ``).replace(/^\.\//, ``);
        image.removeAttribute(`srcset`);
        if (!isShotPath(relative)) {
            image.removeAttribute(`src`);
        }
    }
};

// Resolves the rendered report's relative <img> sources against the story's run directory, after every render of an
// open story; idempotent, since only object URLs minted here survive a later pass.
const resolveShots = (slug: string): void => {
    const container = reportEl.value[slug];
    if (container === undefined) {
        return;
    }
    for (const image of container.querySelectorAll(`img`)) {
        const source = image.getAttribute(`src`) ?? ``;
        image.removeAttribute(`srcset`);
        if (source === `` || source.startsWith(`blob:`)) {
            continue;
        }
        image.removeAttribute(`src`);
        image.classList.add(`max-w-full`, `rounded-md`, `border`, `border-line`);
        const relative = source.replace(/^\.\//, ``);
        if (!isShotPath(relative)) {
            continue;
        }
        void blobFor(`${storyDir(run.manifest.runId, slug)}/${relative}`).then((url) => {
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
// One line per address the run used, read off the manifest rather than re-derived from stories, since what was chosen
// is the fact worth keeping when two groups were aimed at two ports.
const addresses = computed(() => Object.entries(run.manifest.targets).map(([key, url]) => ({ key, url })));
</script>

<template>
    <div class="flex flex-col gap-4">
        <Card class="p-4">
            <div class="flex flex-col gap-1">
                <div v-for="address in addresses" :key="address.key" class="flex items-baseline gap-2 text-xs">
                    <span class="font-mono text-muted">{{ address.key }}</span>
                    <span class="truncate font-mono text-content">{{ address.url || `—` }}</span>
                </div>
            </div>
            <div class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
                <span>{{ run.manifest.pick.agent }} · {{ run.manifest.pick.model }}</span>
                <span>{{ timeAgo(run.manifest.createdAt) }}</span>
                <span v-if="defects.length > 0" class="text-danger">{{ defects.length }} {{ defects.length === 1 ? `defect` : `defects` }}</span>
            </div>
        </Card>

        <Notice v-if="failure" :of="noticeOf(failure)" />

        <div class="overflow-hidden rounded-lg border border-line-subtle bg-card">
            <!-- A report has its own measure and its own screenshots; not a fact hanging off the story's title. -->
            <DisclosureRow
                v-for="story in run.manifest.stories"
                :key="story.slug"
                class="border-b border-line-subtle last:border-b-0"
                density="compact"
                body="drawer"
                :open="open.has(story.slug)"
                @update:open="toggle(story.slug)"
            >
                <template #title>
                    <span class="block truncate font-normal">{{ story.title }}</span>
                </template>
                <template #description>
                    <!--
                        The session's last words replace the activity line for a dead story: a dead session has no activity left, and why it stopped
                        matters more here than the repo.
                    -->
                    <span v-if="failureOf(story.slug)" class="block truncate text-danger" v-tooltip.top="failureOf(story.slug)">
                        {{ failureOf(story.slug) }}
                    </span>
                    <span v-else class="block truncate font-mono text-subtle">
                        {{ story.repo }}<template v-if="activityOf(story.slug)"> · {{ activityOf(story.slug) }}</template>
                    </span>
                </template>
                <template #control>
                    <StatusBadge :variant="verdictBadge(story.slug).variant" :label="verdictBadge(story.slug).label" size="xs" />
                    <!--
                        Only while the daemon lists this session's Chromium; opens the Browsers area on the live screencast, with keyboard/mouse
                        control if needed.
                    -->
                    <Button v-if="browserOf(story.slug)" label="Watch" size="small" severity="secondary" as="a" v-bind="browserLink(story.slug)">
                        <template #icon><Icon name="eye" /></template>
                    </Button>
                    <Button
                        v-if="unstartedFailureOf(story.slug)"
                        label="Retry"
                        size="small"
                        severity="secondary"
                        :loading="retrying.has(story.slug)"
                        @click="relaunch(story.slug)"
                    >
                        <template #icon><Icon name="refresh" /></template>
                    </Button>
                    <Button v-if="agentOf(story.slug)" label="Session" size="small" severity="secondary" as="a" v-bind="sessionLink(story.slug)">
                        <template #icon><Icon name="comments" /></template>
                    </Button>
                    <Button v-if="isLive(story.slug)" label="Stop" size="small" severity="secondary" @click="halt(story.slug)">
                        <template #icon><Icon name="stop" /></template>
                    </Button>
                </template>

                <template #below>
                    <!-- The report is the artifact; everything else on this row summarizes it. -->
                    <!--
                        Capped prose width (prose.css), since an unbounded 72rem page ran paragraphs past 150 characters; screenshots below keep the
                        full column.
                    -->
                    <div v-if="outcomes[story.slug]?.report" :ref="(el) => (reportEl[story.slug] = el as HTMLElement)" style="--prose-measure: 68ch">
                        <Markdown :source="outcomes[story.slug]?.report ?? ``" :decorate="restrictReportImages" />
                    </div>
                    <!--
                        The one thing to read when a session died without a report: the provider's own failure sentence, instead of an
                        otherwise-empty transcript.
                    -->
                    <Notice
                        v-else-if="outcomes[story.slug]?.invalidResult"
                        :of="
                            noticeOf(
                                `The session wrote a result that did not match this run's story and acceptance criteria. Open the session to correct it.`,
                            )
                        "
                    />
                    <!-- For the compiler: `failureOf` is a call, so the v-else-if guard above can't narrow it. -->
                    <Notice v-else-if="failureOf(story.slug)" :of="noticeOf(failureOf(story.slug) ?? ``)" />
                    <div v-else :class="ui.emptyState()">
                        {{
                            verdictBadge(story.slug).variant === `info`
                                ? `Still testing: the report is written at the end of the walkthrough.`
                                : `No report was written. Open the session to see how far it got.`
                        }}
                    </div>

                    <!--
                        The story's own criteria, one verdict each, in authored order: the one part of result.json the report's prose doesn't already
                        state in order.
                    -->
                    <!--
                        At full reading size and colour, since this matrix answers the question the view exists for, not chrome around the answer;
                        the agent's note stays quiet as its annotation.
                    -->
                    <ul v-if="(outcomes[story.slug]?.result?.criteria ?? []).length > 0" class="mt-4 flex max-w-read flex-col gap-1.5">
                        <li
                            v-for="(criterion, index) in outcomes[story.slug]?.result?.criteria ?? []"
                            :key="index"
                            class="flex items-start gap-2 text-sm leading-relaxed"
                        >
                            <Icon
                                :name="criterion.verdict === `pass` ? `check-circle` : criterion.verdict === `fail` ? `exclamation-circle` : `circle`"
                                :class="[
                                    'mt-1 shrink-0',
                                    criterion.verdict === `pass` ? `text-success` : criterion.verdict === `fail` ? `text-danger` : `text-subtle`,
                                ]"
                            />
                            <span class="min-w-0 flex-1 text-content">
                                {{ criterion.text }}
                                <span v-if="criterion.note" class="text-subtle">: {{ criterion.note }}</span>
                            </span>
                        </li>
                    </ul>
                </template>
            </DisclosureRow>
        </div>
    </div>
</template>
