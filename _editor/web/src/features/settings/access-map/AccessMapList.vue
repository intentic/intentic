<script setup lang="ts">
import { Button, Icon, SandboxLogo } from "@intentic/ui";
import type { IconName } from "@intentic/ui/icons";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import AccessMapTies from "./AccessMapTies.vue";
import type { AccountGraph, GraphMachine, GraphSandbox, Standing } from "./accountGraph";
import { machineName, readWords, sandboxLine, tierWord } from "./accessMapWords";

// THE ACCESS MAP IN WORDS: every sandbox the account reaches with what it is tied to, then every computer and server
// with which sandboxes reach it. What a narrow window shows in place of the drawing, and what a reader who would rather
// read than point picks; it says everything the lines say.

const t = useT();

const { graph, now } = defineProps<{ graph: AccountGraph; now: number }>();
const emit = defineEmits<{ read: [sandboxId: string] }>();

const STANDINGS: readonly { readonly standing: Standing; readonly label: () => string }[] = [
    { standing: `yours`, label: () => t(`settings.accessMap.yours`) },
    { standing: `shared`, label: () => t(`settings.accessMap.shared`) },
    { standing: `beyond`, label: () => t(`settings.accessMap.beyond`) },
];
const groups = computed(() =>
    STANDINGS.map((group) => ({ ...group, sandboxes: graph.sandboxes.filter((sandbox) => sandbox.standing === group.standing) })).filter(
        (group) => group.sandboxes.length > 0,
    ),
);

const MACHINE_ICONS = { computer: `desktop`, phone: `mobile`, browser: `browsers`, server: `server`, cloud: `cloud` } as const satisfies Record<
    GraphMachine[`kind`],
    IconName
>;

const facts = (sandbox: GraphSandbox): string =>
    [sandboxLine(sandbox), readWords(sandbox.read, sandbox.readAt, now)].filter((part) => part !== undefined && part !== ``).join(` · `);

const fleetWords = (sandbox: GraphSandbox): string | undefined => {
    if (sandbox.fleet === undefined) {
        return undefined;
    }
    const base = sandbox.standing === `yours` ? t(`settings.accessMap.fleetYours`) : t(`settings.accessMap.fleetOwner`);
    const others = sandbox.fleet.others ?? 0;
    return others > 0 ? `${base} · ${t(`settings.accessMap.others`, { count: others }, others)}` : base;
};
</script>

<template>
    <div class="flex flex-col gap-6">
        <section v-for="group in groups" :key="group.standing" class="flex flex-col gap-2">
            <h3 class="text-xs font-medium text-muted">{{ group.label() }}</h3>
            <div class="flex flex-col divide-y divide-line-subtle rounded-lg border border-line-subtle bg-card">
                <article v-for="sandbox in group.sandboxes" :key="sandbox.id" class="flex flex-col gap-1.5 px-3 py-2.5">
                    <header class="flex min-w-0 items-center gap-2.5">
                        <SandboxLogo :size="22" :image="sandbox.image ?? null" :name="sandbox.name" class="shrink-0 rounded-md" />
                        <span class="flex min-w-0 flex-1 flex-col">
                            <span class="truncate text-sm font-medium text-content">{{ sandbox.name }}</span>
                            <span v-if="facts(sandbox) !== ``" class="truncate text-xs text-subtle">{{ facts(sandbox) }}</span>
                        </span>
                        <span
                            v-if="(sandbox.people ?? 0) > 0"
                            class="flex shrink-0 items-center gap-1 text-xs text-muted"
                            :title="t(`settings.accessMap.people`, { count: sandbox.people }, sandbox.people ?? 0)"
                        >
                            <Icon name="users" />{{ sandbox.people }}
                        </span>
                        <Button
                            v-if="sandbox.read === `signin` && sandbox.sandboxId !== undefined"
                            size="small"
                            tier="boring"
                            :label="t(`settings.accessMap.read`)"
                            @click="emit(`read`, sandbox.sandboxId)"
                        />
                    </header>
                    <p v-if="sandbox.platformTier !== undefined" class="pl-8 text-xs text-subtle">
                        {{ t(`settings.accessMap.platformSays`, { tier: tierWord(sandbox.platformTier) }) }}
                    </p>
                    <div class="pl-8">
                        <AccessMapTies :graph :id="sandbox.id" />
                        <p v-if="fleetWords(sandbox) !== undefined" class="text-sm text-content">{{ fleetWords(sandbox) }}</p>
                    </div>
                </article>
            </div>
        </section>

        <section v-if="graph.machines.length > 0" class="flex flex-col gap-2">
            <h3 class="text-xs font-medium text-muted">{{ t(`settings.accessMap.columnReaches`) }}</h3>
            <div class="flex flex-col divide-y divide-line-subtle rounded-lg border border-line-subtle bg-card">
                <article v-for="machine in graph.machines" :key="machine.id" class="flex flex-col gap-1.5 px-3 py-2.5">
                    <header class="flex min-w-0 items-center gap-2.5">
                        <span class="flex size-5.5 shrink-0 items-center justify-center rounded-md bg-overlay text-xs text-muted">
                            <Icon :name="MACHINE_ICONS[machine.kind]" />
                        </span>
                        <span class="flex min-w-0 flex-1 flex-col">
                            <span class="truncate text-sm font-medium text-content">{{ machineName(machine) }}</span>
                            <span v-if="(machine.detail ?? machine.platform) !== undefined" class="truncate text-xs text-subtle">{{
                                machine.detail ?? machine.platform
                            }}</span>
                        </span>
                        <span v-if="machine.online !== undefined" class="shrink-0 text-xs text-subtle">{{
                            machine.online ? t(`settings.accessMap.connected`) : t(`settings.accessMap.notConnected`)
                        }}</span>
                    </header>
                    <div class="pl-8">
                        <AccessMapTies :graph :id="machine.id" />
                    </div>
                </article>
            </div>
        </section>
    </div>
</template>
