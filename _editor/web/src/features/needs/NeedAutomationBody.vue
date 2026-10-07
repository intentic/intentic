<!-- An automation need's own answer: what would be saved and switched on, said in plain words, then approved whole. -->
<script setup lang="ts">
import type { Automation, AutomationNeed, Need, Trigger, WatchSource } from "@intentic/sandbox-contract";
import { Code, Icon, Notice, ui } from "@intentic/ui";
import { useAsyncAction } from "@intentic/ui/async";
import { formatDateTime } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { useAgents } from "../agents/fleet/useAgents";
import { modelLabelFor } from "../chat/accounts/providerCatalog";
import ChatDecisionButton from "../chat/transcript/cards/ChatDecisionButton.vue";
import { useNeeds } from "./useNeeds";

const t = useT();

const props = defineProps<{ need: Need; subject: AutomationNeed }>();

const needs = useNeeds();
const { agentById } = useAgents();
const automation = computed<Automation>(() => props.subject.automation);

// The cron shapes a proposed watch is made of (`automations propose --every`), in words; anything else is said as written.
// A step of minutes or hours means the same on every clock, so these name no zone.
const cronWords = (cron: string): string | undefined => {
    const hours = /^(\d{1,2}) \*\/(\d{1,2}) \* \* \*$/.exec(cron.trim());
    if (hours?.[1] !== undefined && hours[2] !== undefined) {
        return t(`needs.automation.trigger.everyHours`, { count: Number(hours[2]), minute: hours[1].padStart(2, `0`) });
    }
    const hourly = /^(\d{1,2}) \* \* \* \*$/.exec(cron.trim());
    if (hourly?.[1] !== undefined) {
        return t(`needs.automation.trigger.everyHour`, { minute: hourly[1].padStart(2, `0`) });
    }
    const minutes = /^\*\/(\d{1,2}) \* \* \* \*$/.exec(cron.trim());
    return minutes?.[1] === undefined ? undefined : t(`needs.automation.trigger.everyMinutes`, { count: Number(minutes[1]) });
};

// The trigger in words. No full cron reader lives in the app, so a schedule beyond the shapes above says its cron as
// written, with the clock it is read on when it names one; every other kind is a sentence.
const triggerWords = (trigger: Trigger): string => {
    switch (trigger.kind) {
        case `schedule`:
            return (
                cronWords(trigger.cron) ??
                (trigger.tz === undefined
                    ? t(`needs.automation.trigger.schedule`, { cron: trigger.cron })
                    : t(`needs.automation.trigger.scheduleIn`, { cron: trigger.cron, zone: trigger.tz }))
            );
        case `once`:
            return t(`needs.automation.trigger.once`, { at: formatDateTime(trigger.at) });
        case `event`:
            return t(`needs.automation.trigger.event`);
        case `listener`:
            return trigger.eventType === undefined
                ? t(`needs.automation.trigger.listener`, { source: trigger.provider })
                : t(`needs.automation.trigger.listenerEvent`, { source: trigger.provider, event: trigger.eventType });
        case `workspace`:
            if (trigger.event === `turn.settled`) {
                return t(`needs.automation.trigger.turnSettled`);
            }
            return trigger.event === `agent.landed`
                ? t(`needs.automation.trigger.agentLanded`)
                : t(`needs.automation.trigger.workspace`, { event: trigger.event });
    }
};

// What a ready-made source looks at, as the person approving it would say it.
const sourceWords = (source: WatchSource): string => {
    switch (source.kind) {
        case `npm`: {
            const spec = source.range ?? source.tag;
            return t(`needs.automation.source.npm`, { spec: spec === undefined ? source.package : `${source.package}@${spec}` });
        }
        case `github-release`:
            return source.prereleases === true
                ? t(`needs.automation.source.githubPre`, { repo: source.repo })
                : t(`needs.automation.source.github`, { repo: source.repo });
        case `url`:
            return source.select === undefined
                ? t(`needs.automation.source.url`, { url: source.url })
                : t(`needs.automation.source.urlSelect`, { url: source.url, select: source.select });
    }
};

// What a passing check sets off; a new agent names the models it would spend, best first.
const thenWords = computed<string>(() => {
    const target = automation.value.target;
    if (target?.kind === `conversation`) {
        // Almost always the conversation asking, which is the one this card sits in.
        return target.conversationId === props.need.conversationId
            ? t(`needs.automation.conversationHere`)
            : t(`needs.automation.conversation`, { conversation: agentById(target.conversationId)?.title ?? target.conversationId });
    }
    return target?.kind === `notify` ? t(`needs.automation.notify`) : t(`needs.automation.agent`);
});

// Labelled facts, one per question a person asks before letting something run unattended; a fact with nothing to say is
// left out rather than drawn as "none".
const facts = computed<readonly { key: string; label: string; value: string; mono?: boolean }[]>(() => {
    const it = automation.value;
    const checks = it.guard !== undefined || it.source !== undefined;
    const ends =
        it.until === `first-fire` && it.expiresAt !== undefined
            ? t(`needs.automation.firstFireOrAt`, { date: formatDateTime(it.expiresAt) })
            : it.until === `first-fire`
              ? t(`needs.automation.firstFire`)
              : it.expiresAt === undefined
                ? undefined
                : t(`needs.automation.at`, { date: formatDateTime(it.expiresAt) });
    // By its id: the persona cards live in the sandbox feature, which this one may not reach (editor-boundaries).
    const persona = it.actsAs;
    const models = (it.target === undefined || it.target.kind === `agent`) && it.models !== undefined ? it.models : [];
    return [
        { key: `name`, label: t(`needs.automation.name`), value: it.id, mono: true },
        ...(it.note === undefined ? [] : [{ key: `for`, label: t(`needs.automation.for`), value: it.note }]),
        { key: `when`, label: t(`needs.automation.when`), value: triggerWords(it.trigger) },
        {
            key: `if`,
            label: t(`needs.automation.if`),
            value:
                it.source !== undefined
                    ? sourceWords(it.source)
                    : it.guard !== undefined
                      ? t(`needs.automation.guard`)
                      : t(`needs.automation.noCheck`),
        },
        ...(checks
            ? [
                  {
                      key: `fires`,
                      label: t(`needs.automation.fires`),
                      value:
                          it.fireOn === `change`
                              ? t(`needs.automation.onChange`)
                              : it.until === `first-fire`
                                ? t(`needs.automation.firstPass`)
                                : t(`needs.automation.everyPass`),
                  },
              ]
            : []),
        ...(ends === undefined ? [] : [{ key: `ends`, label: t(`needs.automation.ends`), value: ends }]),
        { key: `then`, label: t(`needs.automation.then`), value: thenWords.value },
        ...(models.length === 0
            ? []
            : [
                  {
                      key: `models`,
                      label: t(`needs.automation.runsOn`),
                      value: models.map((pin) => modelLabelFor(pin.provider, pin.model)).join(`, `),
                  },
              ]),
        ...(persona === undefined ? [] : [{ key: `persona`, label: t(`needs.automation.runsAs`), value: persona }]),
        ...(it.requireApproval === true ? [{ key: `approval`, label: t(`needs.automation.approval`), value: t(`needs.automation.heldForYou`) }] : []),
    ];
});

// A prompt is read in full only on request once it is long; the clamp keeps the card a card.
const PROMPT_FOLD_CHARS = 280;
const promptLong = computed(() => automation.value.prompt.length > PROMPT_FOLD_CHARS || automation.value.prompt.split(`\n`).length > 4);
const promptOpen = ref(false);

// What its check saw the moment it was proposed: the watch working, rather than a promise that it would. One that
// already passes and fires on every pass would fire at its first check, which is worth saying before the yes.
const firstCheck = computed(() => props.subject.firstCheck);
const firesAtOnce = computed(() => firstCheck.value?.pass === true && automation.value.fireOn !== `change`);

const { busy, notice, run } = useAsyncAction();
const approve = async (): Promise<void> => {
    await run(async () => {
        await needs.answer.mutateAsync({ id: props.need.id, answer: { kind: `approve` } });
    }, t(`needs.card.couldNotAnswer`));
};
</script>

<template>
    <div class="chat-card-body flex flex-col gap-2">
        <p v-if="subject.replaces" class="flex items-start gap-1.5 text-2xs text-warning">
            <Icon name="exclamation-triangle" class="mt-0.5 shrink-0" />{{ t(`needs.automation.replaces`, { id: automation.id }) }}
        </p>

        <!-- Labels in one column so the values line up, the way a failure's facts are laid out. -->
        <dl class="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
            <template v-for="fact in facts" :key="fact.key">
                <dt class="text-subtle">{{ fact.label }}</dt>
                <dd class="min-w-0 break-words text-content/85" :class="{ 'font-mono text-2xs leading-5': fact.mono }">{{ fact.value }}</dd>
            </template>
        </dl>

        <!-- A guard is a command that runs with the persona's credentials: shown whole, since that is what is approved. -->
        <Code v-if="automation.guard" :code="automation.guard" lang="bash" wrap :scroll-lines="6" />

        <div v-if="firstCheck" class="flex flex-col gap-1">
            <span class="flex items-center gap-1.5 text-2xs" :class="firstCheck.pass ? `text-success` : `text-muted`">
                <Icon :name="firstCheck.pass ? `check-circle` : `clock`" />{{
                    firstCheck.pass
                        ? t(`needs.automation.todaySees`, { when: formatDateTime(firstCheck.at) })
                        : t(`needs.automation.todayWaiting`, { when: formatDateTime(firstCheck.at) })
                }}
            </span>
            <pre class="chat-inset max-h-32 overflow-auto px-2.5 py-1.5 font-mono text-2xs break-words whitespace-pre-wrap select-text">{{
                firstCheck.saw
            }}</pre>
            <span v-if="firesAtOnce" class="text-2xs text-subtle">{{ t(`needs.automation.firesAtOnce`) }}</span>
        </div>

        <div class="flex flex-col gap-0.5">
            <span class="text-2xs text-subtle">{{ t(`needs.automation.prompt`) }}</span>
            <p class="text-xs break-words whitespace-pre-wrap text-content/85" :class="{ 'line-clamp-4': promptLong && !promptOpen }">
                {{ automation.prompt }}
            </p>
            <button v-if="promptLong" type="button" :class="ui.textAction(`self-start text-2xs`)" @click="promptOpen = !promptOpen">
                {{ promptOpen ? t(`needs.automation.hidePrompt`) : t(`needs.automation.showPrompt`) }}
            </button>
        </div>

        <template v-if="need.status === `open`">
            <span class="text-2xs text-subtle">{{ t(`needs.automation.approveHint`) }}</span>
            <div class="flex flex-wrap items-center gap-2">
                <ChatDecisionButton tone="primary" icon="check" :disabled="busy" @click="approve">{{
                    t(`needs.automation.approve`)
                }}</ChatDecisionButton>
                <slot name="decline" />
            </div>
        </template>
        <Notice v-if="notice" :of="notice" />
    </div>
</template>
