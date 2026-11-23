<!-- What an agent runs on and where, the full card's facts line (AgentCard): the sandbox when it is not the reader's own,
     whose it is, the model, the machine, the login, the branch and what it changed, and the geek metrics while opted in.
     A slim card (boardGrid.ts `CardFit`) draws none of it: the card's chat says it whole. -->
<script setup lang="ts">
import { providerLabel } from "@intentic/sandbox-contract/models/agent-catalog";
import { SandboxLogo, useDevice } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { useAudience } from "../../../../../app/useAudience";
import { useAuth } from "../../../../../client/auth/useAuth";
import { sessionMark } from "../../../../../models/agent-status/ownership";
import { boxImageOf, boxNameOf } from "../../../../../models/fleet/fleetScope";
import type { FleetAgent } from "../../../../../models/fleet/useAgents-fleet";
import { providerAccounts } from "../../../../../models/providers/providerAccounts";
import { apiKeyName, modelLabelFor, shortModelLabel } from "../../../../../models/providers/providerCatalog";
import { presenceOthers } from "../../../../../workbench/presence/usePresence";
import SessionMetrics from "../../../metrics/SessionMetrics.vue";
import { keyBadge, sessionLogin } from "../../session/accountChip";
import OwnerMark from "../../session/OwnerMark.vue";
import SessionChip from "../../session/SessionChip.vue";
import { diffCount, diffTip } from "../cardPresses";

const props = defineProps<{
    agent: FleetAgent;
    // A finished card that asks nothing (AgentCard's `receipt`): its diff flattens to the line's own ink.
    receipt: boolean;
}>();

const t = useT();
const { mobile } = useDevice();
const { user } = useAuth();
const { maker } = useAudience();
const localOnly = computed(() => props.agent.sandboxId === undefined);
// Whose it is, decided here rather than inside the mark, since the line the mark rides must know whether it has
// anything at all to draw: a card of the reader's own says nothing about ownership and spends no row on it.
const provenance = computed(() => sessionMark(props.agent, user.value?.email, presenceOthers.value));
// Sandbox chip contents, or nothing when this is the box the app is already pointed at.
// Read live from the roster rather than passed in, since the owner can rename or re-image a sandbox at any time.
const box = computed(() =>
    props.agent.sandboxId === undefined
        ? undefined
        : { name: boxNameOf.value.get(props.agent.sandboxId) ?? t(`agents.agentCard.anotherSandbox`), image: boxImageOf.value.get(props.agent.sandboxId) },
);
// Gated on exactly what it renders, no more and no less: gating on a subset hides what should show, a superset opens an
// empty strip.
// The diff chip's own condition, not merely `diff exists`, since renames alone render nothing.
// Context is deliberately absent: it is a row of the identity tile's hover (AgentCard's `tileHint`), so a card whose only stat
// was its context opens no summary row at all.
// A maker's card drops cost, diff, model and login, which crowd a narrow card and mean nothing to a non-coder. A coder's
// cost is a row of the tile's hover (a total with no denominator, asking no press): in the summary row it was a stat,
// and a stat takes a row of its own, so it cost every finished card a line. Its diff rides the branch's line.
const diffShown = computed(() => !maker.value && props.agent.diff !== undefined && (props.agent.diff.insertions > 0 || props.agent.diff.deletions > 0));
// Which provider/model the next turn is picked to run on: an open conversation's selection reaches this card through
// the fleet projection, so this agrees with the composer even before that turn starts. The tile wears no provider mark.
const model = computed(() => {
    if (maker.value) {
        return undefined;
    }
    return props.agent.model === undefined ? providerLabel(props.agent.provider) : modelLabelFor(props.agent.provider, props.agent.model);
});
// Which login actually served this turn (the turn's own session frame, not the composer's pick), read against the
// window's account list; folded into the owner's hover when it is the owner's own (sessionLogin).
const login = computed(() => (maker.value ? {} : sessionLogin(providerAccounts.value[props.agent.provider] ?? [], props.agent.account, provenance.value)));
const account = computed(() => login.value.badge ?? (maker.value ? undefined : keyBadge(apiKeyName(props.agent.provider))));
</script>

<template>
    <!-- The card hands its `data-shares` through: whether this line shares its row with the land presses. -->
    <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-2xs text-subtle empty:hidden">
        <!-- NO DOT BEFORE A FACT THAT LEADS WITH ITS OWN GLYPH (the runner's desktop, the branch's code mark, the
             account's person): the glyph already parts it from the one before, and a dot written ahead of it was
             left at the start of the next line whenever the line wrapped there ("· 👤 someone"). The dot stays only
             between the two facts that are bare words, whose it is and the model. -->
        <!-- Which sandbox this agent is in, shown only when it isn't the reader's own; leads the line since it changes what every other number means. -->
        <span
            v-if="box !== undefined"
            class="flex min-w-0 shrink-0 items-center gap-1 truncate rounded bg-content/10 px-2.5 py-1 text-muted"
            v-tooltip.top="{ title: t(`agents.words.otherSandbox`), rows: [{ label: t(`agents.words.sandbox`), value: box.name }] }"
        >
            <SandboxLogo :size="12" :image="box.image ?? null" :name="box.name" />
            <span class="truncate">{{ box.name }}</span>
        </span>
        <!-- Whose it is leads what it runs on: for a card that isn't the reader's own, that outranks the model. -->
        <OwnerMark v-if="provenance !== undefined" :mark="provenance" :own-account="login.own" />
        <span v-if="model !== undefined" class="inline-flex min-w-0 items-center gap-1.5">
            <!-- Pulled back into the line's wider gap, so the dot sits as close to whose it is as to the model. -->
            <span v-if="provenance !== undefined" class="-ml-1.5">·</span>
            <span class="truncate text-muted" v-tooltip.top="shortModelLabel(model) === model ? undefined : model">{{ shortModelLabel(model) }}</span>
        </span>
        <!-- Where it's running, shown only when that's somewhere other than here: the fleet spreads work across machines without a per-agent choice. -->
        <span
            v-if="agent.runner !== undefined && !maker"
            class="flex shrink-0 items-center gap-1 truncate"
            v-tooltip.top="{ title: t(`agents.agentCard.runner`), rows: [{ label: t(`agents.agentCard.machine`), value: agent.runner }] }"
        >
            <Icon name="desktop" class="text-2xs" />
            {{ agent.runner }}
        </span>
        <!-- Not on a phone: which login served the turn is the line's least-read fact, and on a phone's width it was the one that broke the line in two. -->
        <span v-if="account !== undefined && !mobile" v-tooltip.top="account.hint" class="inline-flex min-w-0 shrink items-center gap-1">
            <Icon :name="account.icon" class="shrink-0 text-2xs" />
            <span class="truncate">{{ account.label }}</span>
        </span>
        <!-- Abbreviated on the card, full string on hover; a label, not a control (copy is on the right-click menu). -->
        <!-- Clipped on the card, full identity on hover; nothing renders if the sandbox can't name the account. -->
        <SessionChip v-if="agent.branch !== undefined && !maker" :branch="agent.branch" :from="agent.branches" />
        <!-- What the branch changed, alongside the other metadata. A label, not a control: a click on it selects the card like anywhere else (the bar's icons open the review); red and green mark a live diff. -->
        <span
            v-if="diffShown && agent.diff !== undefined"
            class="shrink-0 font-mono tabular-nums"
            :aria-label="t(`agents.agentCard.viewChangesCount`, { added: agent.diff.insertions, removed: agent.diff.deletions })"
            v-tooltip.top="diffTip(agent.diff)"
        >
            <span :class="receipt ? '' : 'text-success'">+{{ diffCount(agent.diff.insertions) }}</span>
            <span :class="receipt ? '' : 'text-danger'"> −{{ diffCount(agent.diff.deletions) }}</span>
        </span>
        <!-- Opt-in geek metrics: what its processes and those of everything grouped under it hold now, beside the other metadata rather than on a row of its own. Draws only when the board provides a reading naming this conversation, so never for another box's card. -->
        <SessionMetrics v-if="localOnly" :card="agent.id" />
    </div>
</template>
