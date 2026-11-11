<!-- The rebuild of a sandbox Docker Compose runs: its whole Compose file again, building the approved recipe
     (composeRebuild.ts), then Compose's own redeploy. No button and no `ic` command: nothing on this page reaches the file, and a swap would start a container
     Compose does not know.

     Numbered steps, each a few words and a Copy over the block it copies. It used to be a paragraph for every block (a
     lead, a label saying the lead again, a sentence per line to paste), with the YAML scrolling sideways AND folded behind
     "Show all": the reader came to copy three things, so three things to copy is what it shows. Copy sits in the step's
     row rather than on the block, so the block keeps its whole width on a phone. (2026-11-11) Two steps, where there were
     three: the file is the whole file, hash included, rather than service keys and a hash line to splice in. -->
<script setup lang="ts">
import type { ShikiLang } from "@intentic/code-read/langs";
import { COMPOSE_UPDATE_COMMAND } from "@intentic/sandbox-run";
import { Code, CopyButton, toneFill } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { environment } from "../../../../app/environments/environment";
import { useSandbox } from "../../../../client/sandbox/useSandbox";
import { composeRebuildOf } from "./composeRebuild";

const props = defineProps<{
    // The approved recipe waiting to be built, as the daemon composed it.
    hash: string;
    content: string;
}>();

const t = useT();

const { active } = useSandbox();

// The facts the setup page renders the file from: the sandbox's public hostname (the address the editor reaches it at),
// and this editor's own platform, Google client and origin.
// A local-dev platform only (setup's platformUrlOf, not imported: features/setup already depends on this feature).
const api = new URL(environment.api.url);
const platformUrl = api.hostname === `localhost` || api.hostname === `127.0.0.1` ? api.origin : undefined;
const hostname = computed(() => {
    const url = active.value?.daemonUrl;
    return url !== undefined && url !== null && URL.canParse(url) ? new URL(url).hostname : ``;
});
const edit = computed(() =>
    composeRebuildOf(props.hash, props.content, {
        hostname: hostname.value,
        googleClientId: environment.auth.googleClientId,
        webOrigin: globalThis.location.origin,
        platformUrl,
    }),
);

interface Step {
    readonly key: string;
    readonly label: string;
    readonly code: string;
    readonly lang: ShikiLang;
    // A way to do the step without the block, said beside its label.
    readonly hint?: string;
    // Lines shown before the block scrolls in place: a long recipe is there to be copied, not read.
    readonly lines?: number;
}

const steps = computed<Step[]>(() => [
    {
        key: `file`,
        label: t(`sandbox.environmentCard.composeStepFile`),
        code: edit.value.file,
        lang: `yaml`,
        hint: t(`sandbox.environmentCard.composeStepFileElsewhere`),
        lines: 12,
    },
    {
        key: `redeploy`,
        label: t(`sandbox.environmentCard.composeStepRedeploy`),
        code: COMPOSE_UPDATE_COMMAND,
        lang: `bash`,
        hint: t(`sandbox.environmentCard.composeStepRedeployElsewhere`),
    },
]);
</script>

<template>
    <div class="flex flex-col gap-3" data-executor="compose">
        <p class="text-xs font-medium text-content">{{ t(`sandbox.environmentCard.composeTitle`) }}</p>
        <ol class="flex flex-col gap-3">
            <li v-for="(step, index) in steps" :key="step.key" :data-step="step.key" class="flex min-w-0 flex-col gap-1.5">
                <div class="flex items-center gap-2">
                    <span :class="toneFill(`neutral`, `soft`, `flex size-5 shrink-0 items-center justify-center rounded-full text-2xs font-medium text-muted`)">
                        {{ index + 1 }}
                    </span>
                    <p class="min-w-0 flex-1 text-xs text-content">
                        {{ step.label }}
                        <span v-if="step.hint" class="ml-1 text-2xs text-subtle">{{ step.hint }}</span>
                    </p>
                    <CopyButton class="shrink-0" :text="step.code" :label="t(`ui.action.copy`)" />
                </div>
                <!-- Wrapped, so nothing hides to the right, each wrapped line hanging under its own indent. -->
                <Code :code="step.code" :lang="step.lang" wrap :copyable="false" :scroll-lines="step.lines" />
            </li>
        </ol>
    </div>
</template>
