<script setup lang="ts">
import { appLink, formatCount, formatDateTime, InfoTable, Markdown, Notice } from "@intentic/extension-ui";
import { computed } from "vue";
import { host } from "./host";
import { t } from "./i18n.js";
import type { CodeLink, Finding } from "./wire";

// What opens under a row: what PostHog measured, where it points in the workspace, PostHog's own guidance, and, set
// apart, what came from users' browsers. Deciding whether a finding deserves an agent means reading this, and a decision
// that needs a navigation is one people make from the title alone.

const { finding } = defineProps<{ finding: Finding }>();

const api = host();

const measured = computed<string[][]>(() => {
    const impact = finding.impact;
    const rows: (string[] | undefined)[] = [
        impact?.occurrences === undefined ? undefined : [t(`evidence.occurrences`), formatCount(impact.occurrences)],
        impact?.users === undefined ? undefined : [t(`evidence.users`), formatCount(impact.users)],
        impact?.sessions === undefined ? undefined : [t(`evidence.sessions`), formatCount(impact.sessions)],
        impact?.percent === undefined ? undefined : [t(`evidence.share`), `${impact.percent}%`],
        finding.since === undefined ? undefined : [t(`evidence.firstSeen`), formatDateTime(finding.since)],
        finding.lastSeen === undefined ? undefined : [t(`evidence.lastSeen`), formatDateTime(finding.lastSeen)],
    ];
    return rows.filter((row) => row !== undefined);
});

// A link's workspace path: the repository's folder, then the file; the workspace root's own files have no folder.
const pathOf = (link: CodeLink): string => [link.repo === `root` ? undefined : link.repo, link.path === `.` ? undefined : link.path].filter(Boolean).join(`/`);
const linkOf = (link: CodeLink) => appLink(api.href(api.links.workspace(pathOf(link))), () => api.navigate(api.links.workspace(pathOf(link))));
const linkWords = (link: CodeLink): string => `${pathOf(link) || link.repo}${link.line === undefined ? `` : `:${link.line}`}`;

const evidence = computed(() => Object.entries(finding.untrusted));
</script>

<template>
    <div class="flex flex-col gap-3 py-1">
        <Notice v-if="finding.agent?.ownerStep" tone="warning" :title="t(`evidence.ownerStep`)">
            <span class="whitespace-pre-wrap break-words">{{ finding.agent.ownerStep }}</span>
        </Notice>

        <section v-if="measured.length > 0" class="flex flex-col gap-1">
            <h4 class="text-xs font-medium text-muted">{{ t(`evidence.measured`) }}</h4>
            <InfoTable :rows="measured" />
        </section>

        <section v-if="finding.code.length > 0" class="flex flex-col gap-1">
            <h4 class="text-xs font-medium text-muted">{{ t(`evidence.points`) }}</h4>
            <ul class="flex flex-col gap-0.5">
                <li v-for="link in finding.code" :key="`${link.repo}:${link.path}:${link.line ?? 0}`" class="flex flex-wrap items-baseline gap-2 text-sm">
                    <a v-bind="linkOf(link)" class="font-mono text-xs text-link underline-offset-2 hover:underline break-all">{{ linkWords(link) }}</a>
                    <span class="text-xs text-muted">{{ t(`evidence.why.${link.why}`) }}</span>
                </li>
            </ul>
        </section>

        <section v-if="finding.advice" class="flex flex-col gap-1">
            <h4 class="text-xs font-medium text-muted">{{ t(`evidence.advice`) }}</h4>
            <Markdown :source="finding.advice" class="text-sm" />
        </section>

        <!-- Rendered as text, never markup: an exception's message is whatever a user's browser sent. -->
        <section v-if="evidence.length > 0" class="flex flex-col gap-1">
            <h4 class="text-xs font-medium text-muted">{{ t(`evidence.untrusted`) }}</h4>
            <dl class="flex flex-col gap-1 rounded border border-line-subtle bg-canvas px-2 py-1.5">
                <div v-for="[key, value] in evidence" :key="key" class="flex flex-col gap-0.5">
                    <dt class="font-mono text-2xs text-subtle">{{ key }}</dt>
                    <dd class="font-mono text-xs whitespace-pre-wrap break-words text-muted">{{ value }}</dd>
                </div>
            </dl>
        </section>
    </div>
</template>
