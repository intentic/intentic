<!-- The itemized "what adding this does to your sandbox" disclosure: the structured counterpart of the catalog's prose hints. -->
<script setup lang="ts">
import type { CapabilityEffect } from "@intentic/capability-catalog";
import type { IconName, TooltipValue } from "@intentic/ui";
import { computed } from "vue";
import { useT } from "@intentic/ui/i18n";
import { grantList } from "../model/grants";

const t = useT();

const { effects, compact = false } = defineProps<{ effects: readonly CapabilityEffect[]; compact?: boolean }>();

interface EffectRow {
    readonly icon: IconName;
    readonly label: string;
    readonly warn?: boolean;
    // The compact glyph's hover, for the kinds a grid tile badges (effects.ts BADGED_EFFECTS); the sentence is the panel's.
    readonly tip?: TooltipValue;
}

// The two privilege rows, out of the switch: each is its own decision (privileged vs net-admin, writable vs not) and
// the switch is one case per kind, not per decision.
const describeRuntime = (level: `net-admin` | `privileged`): EffectRow =>
    level === `privileged`
        ? {
              icon: `shield`,
              label: t(`capabilities.capabilityEffects.runsSandboxContainerPrivileged`),
              warn: true,
              tip: { title: t(`capabilities.capabilityEffects.privileged`), tone: `warn`, note: t(`capabilities.capabilityEffects.forItsDocker`) },
          }
        : {
              icon: `shield`,
              label: t(`capabilities.capabilityEffects.requiresNetworkAdminContainer`),
              tip: t(`capabilities.capabilityEffects.networkAdmin`),
          };

// Writable is the warned half: a read-only mount can cost the server nothing, a writable one can.
const describeMount = (target: string, writable: boolean): EffectRow => {
    const named = target !== ``;
    if (writable) {
        return {
            icon: `server`,
            label: named
                ? t(`capabilities.capabilityEffects.mountsTargetReadWrite`, { target })
                : t(`capabilities.capabilityEffects.mountsShareReadWrite`),
            warn: true,
        };
    }
    return {
        icon: `server`,
        label: named ? t(`capabilities.capabilityEffects.mountsTargetReadOnly`, { target }) : t(`capabilities.capabilityEffects.mountsShareReadOnly`),
    };
};

// One row per effect kind, keyed rather than switched. The map is exhaustive by type exactly as the switch was — a
// new kind is a compile error here — and each entry is its own small function, which twenty cases in one body could
// never be.
type Describers = { readonly [K in CapabilityEffect["kind"]]: (effect: Extract<CapabilityEffect, { readonly kind: K }>) => EffectRow };

const DESCRIBE: Describers = {
    skill: (effect) => ({
        icon: `sparkles`,
        label:
            effect.name === undefined
                ? t(`capabilities.capabilityEffects.addsSkill`)
                : t(`capabilities.capabilityEffects.addsNamedSkill`, { name: effect.name }),
    }),
    secret: (effect) =>
        effect.exposure === `agent-env`
            ? { icon: `key`, label: t(`capabilities.capabilityEffects.storesSecretInjectedInto`) }
            : { icon: `lock`, label: t(`capabilities.capabilityEffects.storesSecretInSandbox`) },
    clone: (effect) => ({
        icon: `download`,
        label:
            effect.url === undefined
                ? t(`capabilities.capabilityEffects.clonesRepository`)
                : t(`capabilities.capabilityEffects.clonesUrl`, { url: effect.url }),
    }),
    image: () => ({
        icon: `box`,
        label: t(`capabilities.capabilityEffects.extendsSandboxImageOne`),
        tip: { title: t(`capabilities.capabilityEffects.imageChange`), note: t(`capabilities.capabilityEffects.oneRebuild`) },
    }),
    runtime: (effect) => describeRuntime(effect.level),
    gpu: () => ({ icon: `bolt`, label: t(`capabilities.capabilityEffects.claimsEveryNvidiaGpu`), warn: true }),
    mount: (effect) => describeMount(effect.target, effect.writable),
    restart: (effect) => ({ icon: `refresh`, label: t(`capabilities.capabilityEffects.appliesWithoutRebuildBy`, { process: effect.process }) }),
    process: (effect) => ({
        icon: `play`,
        label: t(`capabilities.capabilityEffects.runsProcesses`, { names: effect.names.join(`, `) }, effect.names.length),
    }),
    mcp: () => ({ icon: `bolt`, label: t(`capabilities.capabilityEffects.registersMcpServerAgent`) }),
    scaffold: (effect) => ({
        icon: `sitemap`,
        label:
            effect.repos.length === 0
                ? t(`capabilities.capabilityEffects.scaffoldsRepository`)
                : t(`capabilities.capabilityEffects.scaffoldsRepos`, { repos: effect.repos.join(`, `) }, effect.repos.length),
    }),
    "trusted-code": () => ({
        icon: `exclamation-triangle`,
        label: t(`capabilities.capabilityEffects.runsCodeInsideApp`),
        warn: true,
        tip: { title: t(`capabilities.capabilityEffects.runsInApp`), tone: `warn`, note: t(`capabilities.capabilityEffects.trustedOnly`) },
    }),
    // Names the passkey as well as the profile, since a stored security key is a bigger thing to hold than a session
    // cookie; both are removed together.
    profile: (effect) => ({ icon: `globe`, label: t(`capabilities.capabilityEffects.keepsLoggedInBrowser`, { platform: effect.platform }) }),
    // Reaches outside the sandbox: warned, and states the actual verbs granted on the user's device.
    machine: (effect) => ({
        icon: `desktop`,
        label: t(`capabilities.capabilityEffects.machine`, {
            grants: grantList(effect.grants),
            platform: effect.platform === `windows` ? `Windows` : `Linux`,
        }),
        warn: true,
    }),
    // Warned like `machine`; the allowed sites are the user's own choice in the extension, which the reader must know
    // before agreeing to this.
    "own-browser": (effect) => ({
        icon: `globe`,
        label: t(`capabilities.capabilityEffects.ownBrowser`, {
            grants: grantList(effect.grants),
            browser: effect.platform === `edge` ? `Edge` : `Chrome`,
        }),
        warn: true,
    }),
    // Warned like `machine`; which apps it may act in is the person's own choice on the phone, which the reader must
    // know before agreeing to this.
    "own-phone": (effect) => ({
        icon: `mobile`,
        label: t(`capabilities.capabilityEffects.ownPhone`, { grants: grantList(effect.grants) }),
        warn: true,
    }),
    // Named, not warned: pointing at a server is the point of this capability (as often a private choice, like a local
    // model); the row states the destination.
    endpoint: (effect) => ({
        icon: `cloud-upload`,
        label:
            effect.url === ``
                ? t(`capabilities.capabilityEffects.endpointConfigured`)
                : t(`capabilities.capabilityEffects.endpointUrl`, { url: effect.url }),
    }),
    // Warned like `machine`: the spend leaves the sandbox and can't be undone by removing the tile; the row leads with
    // the ceiling and whether it asks each time.
    spend: (effect) => ({
        icon: `credit-card`,
        label: effect.carded
            ? t(`capabilities.capabilityEffects.spendAsks`, { perPayment: effect.perPaymentUsd, daily: effect.dailyUsd })
            : t(`capabilities.capabilityEffects.spendAuto`, { perPayment: effect.perPaymentUsd, daily: effect.dailyUsd }),
        warn: true,
    }),
    // Warned, and worded for what survives removing the tile: sandboxes the agent made stay made, on the account
    // rather than in this box.
    provision: () => ({
        icon: `server`,
        label: t(`capabilities.capabilityEffects.provision`),
        warn: true,
    }),
};

// The key and the handler it selects are correlated by construction and not to the checker, so the narrowing the
// switch did for free costs one assertion here, at the single point where the tag is read.
const describe = (effect: CapabilityEffect): EffectRow => (DESCRIBE[effect.kind] as (value: CapabilityEffect) => EffectRow)(effect);

const rows = computed<readonly EffectRow[]>(() => effects.map(describe));
</script>

<template>
    <!-- `shrink-0`: fixed-width glyphs must not be squashed to buy the truncating name a few more pixels. -->
    <div v-if="compact && rows.length > 0" class="flex shrink-0 items-center gap-1.5 text-2xs text-subtle">
        <span v-for="(row, index) in rows" :key="index" v-tooltip.top="row.tip ?? row.label" :class="row.warn ? 'text-warning' : ''">
            <Icon :name="row.icon" />
        </span>
    </div>
    <!-- Full panel shares the same tile and heading tier as <CredentialGuide>, since both live in the same reference column read beside the form. -->
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
