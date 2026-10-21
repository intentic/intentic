<!-- WHAT IS KNOWN ABOUT A FOLDER'S SANDBOX, beside its steps on its page (LocalSandboxSetup.vue): the folder by its full
     path, its own name the brightest part of it; what its first copy carries and what stays behind; where the sandbox
     runs; how long making it takes, before the press, by the setup's own plan; and who it is for. What to beware of is
     the page's, beside the press it is about. -->
<script setup lang="ts">
import { Icon, InfoHint } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import type { LocalProjectPreview } from "../../app/environments/localHost";
import { spanWords } from "../../components/progress/progress";
import { copyWeight } from "../projectWords";

const { preview, name, path, account, signedIn, started } = defineProps<{
    preview: LocalProjectPreview | undefined;
    name: string;
    path: string;
    /** Who is signed in, by their email; undefined while the window does not know it yet. */
    account: string | undefined;
    /** Someone is signed in, as the app says (its preview, or the folder's setup past the sign-in). */
    signedIn: boolean;
    /** The press has been made: how long it takes is the setup's own measure from here, drawn above. */
    started: boolean;
}>();

const t = useT();

const fresh = computed(() => (preview?.kind === `new` ? preview : undefined));

// The folder's path, split where its own name begins, so the name is never what gets cut off.
const parent = computed(() => (path.endsWith(name) ? path.slice(0, path.length - name.length) : ``));
const folder = computed(() => (path.endsWith(name) ? name : path));

const takes = computed(() => (fresh.value === undefined || started ? undefined : t(`local.sandboxSetup.takes`, { span: spanWords(fresh.value.seconds * 1000) })));
</script>

<template>
    <section class="flex flex-col gap-3">
        <h2 class="text-xs font-semibold text-content">{{ t(`local.sandboxSetup.factsHeading`) }}</h2>
        <dl class="flex flex-col gap-2.5 text-xs">
            <div class="flex flex-col gap-1">
                <dt class="text-2xs text-subtle">{{ t(`local.sandboxSetup.folder`) }}</dt>
                <dd class="flex items-center gap-2 rounded-md bg-canvas px-2.5 py-1.5 font-mono text-2xs">
                    <Icon name="folder-open" class="shrink-0 text-subtle" aria-hidden="true" />
                    <span class="flex min-w-0" v-tooltip.top="path">
                        <span class="truncate text-subtle">{{ parent }}</span>
                        <span class="shrink-0 text-content">{{ folder }}</span>
                    </span>
                </dd>
            </div>
            <div v-if="fresh !== undefined" class="flex items-start justify-between gap-3">
                <dt class="shrink-0 text-subtle">{{ t(`local.sandboxSetup.copy`) }}</dt>
                <dd class="flex items-center gap-1.5 text-right tabular-nums text-content">
                    {{ copyWeight(fresh) }}
                    <InfoHint :label="t(`local.project.staysHere`)">
                        <span class="block text-xs text-content">{{ t(`local.project.staysHere`) }}</span>
                    </InfoHint>
                </dd>
            </div>
            <div class="flex items-start justify-between gap-3">
                <dt class="shrink-0 text-subtle">{{ t(`local.sandboxSetup.where`) }}</dt>
                <dd class="text-right text-content">{{ t(`local.sandboxSetup.thisComputer`) }}</dd>
            </div>
            <div v-if="takes !== undefined" class="flex items-start justify-between gap-3">
                <dt class="shrink-0 text-subtle">{{ t(`local.sandboxSetup.time`) }}</dt>
                <dd class="text-right text-content">{{ takes }}</dd>
            </div>
            <div class="flex items-start justify-between gap-3">
                <dt class="shrink-0 text-subtle">{{ t(`local.sandboxSetup.account`) }}</dt>
                <dd class="min-w-0 truncate text-right" :class="signedIn ? `text-content` : `text-muted`">
                    {{ signedIn ? (account ?? t(`local.sandboxSetup.signedIn`)) : t(`local.sandboxSetup.notSignedIn`) }}
                </dd>
            </div>
        </dl>
    </section>
</template>
