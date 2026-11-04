<!-- A SWAP RUN BY THE DESKTOP APP (appRecreate.ts): HostRecreate's lane for a reader in the app with no connected
     machine to stream from. The press is a link the app runs on this computer; from then on the button holds and names
     what runs, the line under it says where the app's run stands with the way to its page, and a run that failed says
     so here rather than only on a tile on the rail. -->
<script setup lang="ts">
import { Button, type IconName, Notice, type NoticeModel, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, type VNode } from "vue";
import { useRouter } from "vue-router";
import { useSandbox } from "../../../../client/sandbox/useSandbox";
import { processOnHome } from "../../../../models/processes/processAddress";
import { pressAppRecreate, useAppRecreate } from "./appRecreate";
import { actionOfMode, quietOf, type RecreateAction, verbOf, workingWords } from "./recreateWords";

const props = defineProps<{
    slug: string;
    hash?: string | undefined;
    action: RecreateAction;
    /** The caller's own words for the button, over "{action} now". */
    label?: string | undefined;
    gilded?: boolean | undefined;
    icon: IconName;
    /** The button row's classes, shared with the caller's `beside` step. */
    row: string;
}>();
defineSlots<{
    beside?: () => VNode[];
    /** The caller's line about what it costs, under the row. */
    cost?: () => VNode[];
}>();

const t = useT();
const router = useRouter();
const { activeSandboxId } = useSandbox();
const app = useAppRecreate(() => props.slug);

// Which of the three the app runs, by its own word: an update pressed on Overview holds Environment's Rebuild too.
const running = computed<RecreateAction>(() => {
    const mode = app.mode.value;
    return mode === undefined ? props.action : actionOfMode(mode);
});
const buttonLabel = computed(() =>
    app.busy.value
        ? t(`capabilities.hostRecreate.running`, { action: verbOf(running.value) })
        : (props.label ?? t(`capabilities.hostRecreate.now`, { action: verbOf(props.action) })),
);
const status = computed(() =>
    app.handing.value ? t(`capabilities.hostRecreate.appHanding`) : t(`capabilities.hostRecreate.appRunning`, { what: workingWords(running.value) }),
);
const failure = computed<NoticeModel | undefined>(() => {
    const why = app.failure.value;
    if (why === undefined) {
        return undefined;
    }
    const title = t(`capabilities.hostRecreate.appFailed`, { action: verbOf(props.action) });
    return why === `` ? { tone: `warning`, title } : { tone: `warning`, title, detail: why };
});

const press = (): void => {
    if (app.busy.value) {
        return;
    }
    // Read at the press: the run outlives this card, and its props with it.
    const { action, hash, slug } = props;
    const sandbox = activeSandboxId.value;
    pressAppRecreate({
        slug,
        hash,
        rollback: action === `Roll back`,
        restart: sandbox === undefined ? undefined : { sandbox, id: `recreate`, what: workingWords(action), quiet: quietOf(action) },
    });
};
// The run's own page, on Home in the chat's place, as its tile on the rail opens it.
const showRun = (): void => {
    const run = app.run.value;
    if (run !== undefined) {
        void router.push(processOnHome(run.id));
    }
};
</script>

<template>
    <div :class="row">
        <Button
            :label="buttonLabel"
            :size="gilded ? undefined : `small`"
            :tier="gilded ? `loud` : `accent`"
            :gilded="gilded"
            :loading="app.busy.value"
            @click="press"
        >
            <template #icon><Icon :name="icon" /></template>
        </Button>
        <slot name="beside" />
    </div>
    <slot name="cost" />
    <p v-if="app.busy.value" class="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-muted" role="status" data-app-recreate>
        <Icon name="spinner" spin class="shrink-0" aria-hidden="true" />
        <span>{{ status }}</span>
        <button v-if="app.live.value && app.run.value" type="button" :class="ui.textButton({ tone: `quiet`, size: `xs` })" @click="showRun">
            {{ t(`capabilities.hostRecreate.appShowProgress`) }}
        </button>
    </p>
    <Notice v-else-if="failure" :of="failure" />
    <p v-else-if="app.silent.value" class="text-2xs text-muted" role="status">{{ t(`capabilities.hostRecreate.appSilent`) }}</p>
</template>
