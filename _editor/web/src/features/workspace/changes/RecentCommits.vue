<script setup lang="ts">
import { timeAgo } from "@intentic/ui";
import { rpcQuery } from "../../../client/sandbox/rpcQuery";
import { useSandboxQuery } from "../../../client/sandbox/useSandboxQuery";

// The last few commits of one repo, under the commit page's composer: what the next commit follows, and what an Amend
// would rewrite. Refreshed by every commit, amend and undo (useChanges invalidates `git.log`).

const { repo, named, now } = defineProps<{ repo: string; named: boolean; now: number }>();

const LIMIT = 3;
const { query } = useSandboxQuery({ ...rpcQuery(`git.log`, () => ({ repo, limit: LIMIT })) });
</script>

<template>
    <!-- Nothing at all for a repo with no history to show yet, so the page's heading over these can hide with them. -->
    <div v-if="(query.data.value?.commits.length ?? 0) > 0" class="flex min-w-0 flex-col" data-recent-commits>
        <span v-if="named" class="text-2xs text-subtle">{{ repo }}</span>
        <div v-for="commit in query.data.value?.commits ?? []" :key="commit.sha" class="flex min-w-0 items-baseline gap-2 py-0.5 text-xs">
            <span class="shrink-0 font-mono text-2xs text-subtle">{{ commit.short }}</span>
            <span class="min-w-0 flex-1 truncate text-content" v-tooltip.top.overflow="commit.subject">{{ commit.subject }}</span>
            <span class="shrink-0 text-2xs text-subtle">{{ timeAgo(commit.at, { now }) }}</span>
        </div>
    </div>
</template>
