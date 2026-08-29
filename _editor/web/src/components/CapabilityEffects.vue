<!-- The itemized "what adding this does to your sandbox" disclosure: the structured counterpart of the catalog's
     prose hints, derived by capabilityEffects (capability-catalog). Full mode is the pre-add panel on the "+" config
     form; `compact` is the icon-only strip under a connected instance (labels move into title tooltips). -->
<script setup lang="ts">
import type { CapabilityEffect } from "@intentic-app/capability-catalog";
import type { IconName } from "@intentic/ui";
import { computed } from "vue";

const { effects, compact = false } = defineProps<{ effects: readonly CapabilityEffect[]; compact?: boolean }>();

interface EffectRow {
    readonly icon: IconName;
    readonly label: string;
    readonly warn?: boolean;
}

const describe = (effect: CapabilityEffect): EffectRow => {
    switch (effect.kind) {
        case "skill":
            return {
                icon: `sparkles`,
                label: effect.name === undefined ? `Adds a skill the agent loads next turn` : `Adds skill "${effect.name}" the agent loads next turn`,
            };
        case "secret":
            return effect.exposure === `agent-env`
                ? { icon: `key`, label: `Stores a secret, injected into the agent's env each turn, never written to disk or shown in Files` }
                : { icon: `lock`, label: `Stores a secret in your sandbox, never shown in Files` };
        case "clone":
            return {
                icon: `download`,
                label: effect.url === undefined ? `Clones a git repository into your sandbox` : `Clones ${effect.url} into your sandbox`,
            };
        case "image":
            return { icon: `box`, label: `Extends the sandbox image, one-time rebuild required` };
        case "runtime":
            return effect.level === `privileged`
                ? { icon: `shield`, label: `Runs the sandbox container privileged, what its own isolated Docker Engine needs`, warn: true }
                : { icon: `shield`, label: `Requires network-admin container access` };
        case "gpu":
            return { icon: `bolt`, label: `Claims every NVIDIA GPU on the host machine, needs its container toolkit installed`, warn: true };
        case "restart":
            return { icon: `refresh`, label: `Applies without a rebuild by restarting ${effect.process}, anything it is running stops` };
        case "process":
            return { icon: `play`, label: `Runs background process${effect.names.length === 1 ? `` : `es`}: ${effect.names.join(`, `)}` };
        case "mcp":
            return { icon: `bolt`, label: `Registers an MCP server the agent connects to next turn` };
        case "scaffold":
            return {
                icon: `sitemap`,
                label:
                    effect.repos.length === 0
                        ? `Scaffolds a repository`
                        : `Scaffolds ${effect.repos.length === 1 ? `repository` : `repositories`} ${effect.repos.join(`, `)}`,
            };
        case "deploy":
            return effect.provisions
                ? { icon: `cloud-upload`, label: `Writes a deploy config entry and provisions infrastructure now` }
                : { icon: `server`, label: `Writes a deploy config entry, applied on the next provision` };
        case "trusted-code":
            return {
                icon: `exclamation-triangle`,
                label: `Runs code inside the app with your session, owner-only; install only publishers you trust`,
                warn: true,
            };
        case "profile":
            // Names the passkey as well as the profile, because a security key the sandbox holds is a stronger
            // thing to store than a session cookie and the row is where the user decides. Both are torn down
            // together when the connection is removed.
            return { icon: `globe`, label: `Keeps a logged-in ${effect.platform} browser profile, and any passkey you enroll, in your sandbox` };
        case "machine":
            // The one effect that reaches OUTSIDE the sandbox, so it is warned and spelled out: the row names
            // the verbs the agent gets on a computer of the user's, not the mechanism that carries them.
            return {
                icon: `desktop`,
                label: `Lets the agent ${effect.grants.join(`, `)} on your ${effect.platform === `windows` ? `Windows` : `Linux`} computer`,
                warn: true,
            };
        case "own-browser":
            // Warned like `machine`, and bounded in the same sentence that grants it: the sites are the
            // person's own decision, made in their browser, which is the half a reader has to be told about
            // before they agree to the half stated here.
            return {
                icon: `globe`,
                label: `Lets the agent ${effect.grants.join(`, `)} in your ${effect.platform === `edge` ? `Edge` : `Chrome`}, on the sites you allow it in the extension`,
                warn: true,
            };
        case "endpoint":
            // Named, not warned: pointing turns at a server is the POINT of this capability, and it is as often
            // the private choice (a model on your own hardware) as the exposing one. The row states the
            // destination and what leaves for it, and lets the reader judge their own URL.
            return {
                icon: `cloud-upload`,
                label:
                    effect.url === ``
                        ? `Sends this sandbox's prompts, files and command output to the model API you configure`
                        : `Sends this sandbox's prompts, files and command output to ${effect.url}`,
            };
        case "spend":
            // Warned like `machine`, and for the same reason: the consequence leaves the sandbox and cannot be
            // undone by removing the card. The row leads with the ceiling and says plainly whether the agent
            // has to ask each time, because that is the sentence the reader is actually deciding about.
            return {
                icon: `credit-card`,
                label: effect.carded
                    ? `Lets the agent spend real money: up to $${effect.perPaymentUsd} per payment and $${effect.dailyUsd} a day, and it asks you in chat every time`
                    : `Lets the agent spend real money, up to $${effect.perPaymentUsd} per payment and $${effect.dailyUsd} a day, and small payments go through without asking`,
                warn: true,
            };
    }
};

const rows = computed<readonly EffectRow[]>(() => effects.map(describe));
</script>

<template>
    <!-- `shrink-0`: the strip sits on one line beside a name that truncates, and squashing fixed-width glyphs to
         buy that name three more pixels loses the state the glyphs are there to show. -->
    <div v-if="compact && rows.length > 0" class="flex shrink-0 items-center gap-1.5 text-2xs text-subtle">
        <span v-for="(row, index) in rows" :key="index" v-tooltip.top="row.label" :class="row.warn ? 'text-warning' : ''">
            <Icon :name="row.icon" />
        </span>
    </div>
    <!-- The full panel stands beside <CredentialGuide> in the same reference column, so it is built out of the
         same parts: the app's own card (not a hand-rolled near-copy of it, which is what this was, one step of
         padding off) and a heading in the same tier as "How to get it". The rows stay at the chrome size, like
         the guide's steps: this column is read beside the form, not instead of it. -->
    <div v-else-if="rows.length > 0" class="ui-card">
        <div class="mb-3 text-sm font-semibold text-content">This will add to your sandbox</div>
        <ul class="flex flex-col gap-2">
            <li
                v-for="(row, index) in rows"
                :key="index"
                :class="['flex items-start gap-2 text-xs leading-relaxed', row.warn ? 'text-warning' : 'text-muted']"
            >
                <Icon :name="row.icon" class="mt-0.5 shrink-0 text-2xs" />
                <span class="min-w-0 break-words">{{ row.label }}</span>
            </li>
        </ul>
    </div>
</template>
