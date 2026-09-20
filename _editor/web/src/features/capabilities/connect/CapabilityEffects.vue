<!-- The itemized "what adding this does to your sandbox" disclosure: the structured counterpart of the catalog's prose hints. -->
<script setup lang="ts">
import type { CapabilityEffect } from "@intentic/capability-catalog";
import type { IconName } from "@intentic/ui";
import { computed } from "vue";
import { useT } from "@intentic/ui/i18n";

const t = useT();

const { effects, compact = false } = defineProps<{ effects: readonly CapabilityEffect[]; compact?: boolean }>();

interface EffectRow {
    readonly icon: IconName;
    readonly label: string;
    readonly warn?: boolean;
}

// The two privilege rows, out of the switch: each is its own decision (privileged vs net-admin, writable vs not) and
// the switch is one case per kind, not per decision.
const describeRuntime = (level: `net-admin` | `privileged`): EffectRow =>
    level === `privileged`
        ? { icon: `shield`, label: t(`capabilities.capabilityEffects.runsSandboxContainerPrivileged`), warn: true }
        : { icon: `shield`, label: t(`capabilities.capabilityEffects.requiresNetworkAdminContainer`) };

// Writable is the warned half: a read-only mount can cost the server nothing, a writable one can.
const describeMount = (target: string, writable: boolean): EffectRow => {
    const named = target !== ``;
    if (writable) {
        return {
            icon: `server`,
            label: named ? t(`capabilities.capabilityEffects.mountsTargetReadWrite`, { target }) : t(`capabilities.capabilityEffects.mountsShareReadWrite`),
            warn: true,
        };
    }
    return {
        icon: `server`,
        label: named ? t(`capabilities.capabilityEffects.mountsTargetReadOnly`, { target }) : t(`capabilities.capabilityEffects.mountsShareReadOnly`),
    };
};

const describe = (effect: CapabilityEffect): EffectRow => {
    switch (effect.kind) {
        case "skill":
            return {
                icon: `sparkles`,
                label: effect.name === undefined ? `Adds a skill the agent loads next turn` : `Adds skill "${effect.name}" the agent loads next turn`,
            };
        case "secret":
            return effect.exposure === `agent-env`
                ? { icon: `key`, label: t(`capabilities.capabilityEffects.storesSecretInjectedInto`) }
                : { icon: `lock`, label: t(`capabilities.capabilityEffects.storesSecretInSandbox`) };
        case "clone":
            return {
                icon: `download`,
                label: effect.url === undefined ? `Clones a git repository into your sandbox` : `Clones ${effect.url} into your sandbox`,
            };
        case "image":
            return { icon: `box`, label: t(`capabilities.capabilityEffects.extendsSandboxImageOne`) };
        case "runtime":
            return describeRuntime(effect.level);
        case "gpu":
            return { icon: `bolt`, label: t(`capabilities.capabilityEffects.claimsEveryNvidiaGpu`), warn: true };
        case "mount":
            return describeMount(effect.target, effect.writable);
        case "restart":
            return { icon: `refresh`, label: t(`capabilities.capabilityEffects.appliesWithoutRebuildBy`, { process: effect.process }) };
        case "process":
            return { icon: `play`, label: `Runs background process${effect.names.length === 1 ? `` : `es`}: ${effect.names.join(`, `)}` };
        case "mcp":
            return { icon: `bolt`, label: t(`capabilities.capabilityEffects.registersMcpServerAgent`) };
        case "scaffold":
            return {
                icon: `sitemap`,
                label:
                    effect.repos.length === 0
                        ? `Scaffolds a repository`
                        : `Scaffolds ${effect.repos.length === 1 ? `repository` : `repositories`} ${effect.repos.join(`, `)}`,
            };
        case "trusted-code":
            return {
                icon: `exclamation-triangle`,
                label: t(`capabilities.capabilityEffects.runsCodeInsideApp`),
                warn: true,
            };
        case "profile":
            // Names the passkey as well as the profile, since a stored security key is a bigger thing to hold than a
            // session
            // cookie; both are removed together.
            return { icon: `globe`, label: t(`capabilities.capabilityEffects.keepsLoggedInBrowser`, { platform: effect.platform }) };
        case "machine":
            // The one effect reaching outside the sandbox: warned, and states the actual verbs granted on the user's
            // device.
            return {
                icon: `desktop`,
                label: `Lets the agent ${effect.grants.join(`, `)} on your ${effect.platform === `windows` ? `Windows` : `Linux`} device`,
                warn: true,
            };
        case "own-browser":
            // Warned like `machine`; the allowed sites are the user's own choice in the extension, which the reader
            // must know
            // before agreeing to this.
            return {
                icon: `globe`,
                label: `Lets the agent ${effect.grants.join(`, `)} in your ${effect.platform === `edge` ? `Edge` : `Chrome`}, on the sites you allow it in the extension`,
                warn: true,
            };
        case "endpoint":
            // Named, not warned: pointing at a server is the point of this capability (as often a private choice, like
            // a local
            // model); the row states the destination.
            return {
                icon: `cloud-upload`,
                label:
                    effect.url === ``
                        ? `Sends this sandbox's prompts, files and command output to the model API you configure`
                        : `Sends this sandbox's prompts, files and command output to ${effect.url}`,
            };
        case "spend":
            // Warned like `machine`: the spend leaves the sandbox and can't be undone by removing the card; the row
            // leads with
            // the ceiling and whether it asks each time.
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
    <!-- `shrink-0`: fixed-width glyphs must not be squashed to buy the truncating name a few more pixels. -->
    <div v-if="compact && rows.length > 0" class="flex shrink-0 items-center gap-1.5 text-2xs text-subtle">
        <span v-for="(row, index) in rows" :key="index" v-tooltip.top="row.label" :class="row.warn ? 'text-warning' : ''">
            <Icon :name="row.icon" />
        </span>
    </div>
    <!-- Full panel shares the same card and heading tier as <CredentialGuide>, since both live in the same reference column read beside the form. -->
    <div v-else-if="rows.length > 0" class="ui-card">
        <div class="mb-3 text-sm font-semibold text-content">{{ t(`capabilities.capabilityEffects.addToSandbox`) }}</div>
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
