<script setup lang="ts">
import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { providerSpec } from "@intentic/sandbox-contract/models/provider-specs";
import type { IconName } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { toneWash } from "@intentic/ui/tone";
import { computed } from "vue";
import { requirementWords, runsWords } from "../../../models/providers/providerWords";
import { connectTripNote } from "../secrets/connectFlowNotes";

// WHAT CONNECTING THIS PROVIDER WILL BE LIKE, said before the press: the press goes straight to the provider's page
// (signInTab.ts), so anything that page will show has to be said here or it is met unprepared. One line each, an icon
// that carries what kind of fact it is, and a tag where a fact needs a verdict: what it costs, where it opens and how
// long it takes, what the provider's pages will show that our words don't (connectFlowNotes.ts), and where the account
// ends up. Replaces "Not connected yet. Signing in takes a minute, and the account stays in this sandbox.", which said
// none of what a first-time reader actually needed to decide.

const t = useT();

const { provider, found = false } = defineProps<{
    provider: AgentProvider;
    // The desktop app found this provider signed in on this computer: one click, nothing to type.
    found?: boolean;
}>();

const spec = computed(() => providerSpec(provider));
const destination = computed(() => spec.value?.destination ?? provider);

interface Fact {
    readonly key: string;
    readonly icon: IconName;
    readonly text: string;
    // The page's own words, set apart so they are recognised there.
    readonly quote?: string;
    readonly tag?: { readonly text: string; readonly tone: `success` | `warning` | `neutral` };
}

const facts = computed<readonly Fact[]>(() => {
    const access = spec.value?.access;
    const list: Fact[] = [];
    if (access !== undefined) {
        list.push(
            access.kind === `free`
                ? {
                      key: `cost`,
                      icon: `gift`,
                      text: t(`connect.preflight.freeWith`, { requirement: requirementWords(access, `needed`) }),
                      tag: { text: t(`connect.connect.free`), tone: `success` },
                  }
                : { key: `cost`, icon: `credit-card`, text: t(`connect.preflight.needs`, { requirement: requirementWords(access, `needed`) }) },
        );
    }
    list.push(
        found
            ? { key: `go`, icon: `desktop`, text: t(`connect.preflight.found`), tag: { text: t(`connect.preflight.oneClick`), tone: `success` } }
            : { key: `go`, icon: `external-link`, text: t(`connect.preflight.opens`, { destination: destination.value }), tag: { text: t(`connect.preflight.aMinute`), tone: `neutral` } },
    );
    // Whichever way its sign-in ends, these are on the way: the signs a pasted landing alone would add are said live.
    for (const sign of connectTripNote(provider, { redirect: true })?.signs ?? []) {
        list.push({
            key: sign.shows,
            icon: sign.warning ? `exclamation-triangle` : `info-circle`,
            text: t(`sandbox.connectFlow.whatYoullSee`),
            quote: sign.shows,
            tag: { text: sign.means, tone: sign.warning ? `warning` : `neutral` },
        });
    }
    list.push({ key: `where`, icon: `shield`, text: t(`connect.preflight.staysHere`) });
    return list;
});
</script>

<template>
    <div class="flex flex-col gap-3">
        <p v-if="spec" class="text-sm text-content">{{ t(`connect.preflight.runs`, { runs: runsWords(spec.access) }) }}</p>
        <ul class="flex flex-col gap-2" :aria-label="t(`connect.preflight.label`)">
            <li v-for="fact in facts" :key="fact.key" class="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 text-xs">
                <Icon :name="fact.icon" class="w-4 shrink-0 text-muted" />
                <span class="min-w-0 text-content">
                    {{ fact.text }}
                    <span v-if="fact.quote" class="font-semibold">{{ fact.quote }}</span>
                </span>
                <span v-if="fact.tag" :class="toneWash(fact.tag.tone, `rounded px-1.5 py-px text-2xs leading-4`, fact.tag.tone === `neutral` && `text-muted`)">{{
                    fact.tag.text
                }}</span>
            </li>
        </ul>
    </div>
</template>
