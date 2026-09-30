<!-- What people have allowed beyond a persona or an area, and the credentials released, still standing: each taken back
     with one press. A turn already running keeps what it mounted; the conversation's next turn runs without it. -->
<script setup lang="ts">
import type { GrantRevoke, StandingGrants } from "@intentic/sandbox-contract";
import { Notice } from "@intentic/ui";
import { useAsyncAction } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { relativeTime } from "../chat/models/catalog";
import { useStandingGrants } from "./useStandingGrants";

const t = useT();

const props = defineProps<{ titleOf: (conversationId: string) => string }>();

const { conversations, revoke } = useStandingGrants();

interface Item {
    readonly grant: GrantRevoke;
    readonly label: string;
    readonly note?: string | undefined;
}

type StandingConversation = StandingGrants["conversations"][number];

// Each yes in words, in the order a person scans for the risky ones: accounts, folders, whole shelves, unasked installs,
// released secrets.
const itemsOf = (conversation: StandingConversation): readonly Item[] => {
    const at = (kind: GrantRevoke["kind"], what: string): GrantRevoke => ({ conversationId: conversation.conversationId, kind, what });
    return [
        ...conversation.capabilities.map((what) => ({ grant: at(`capability`, what), label: t(`needs.grants.capability`, { what }) })),
        ...conversation.folders.map((what) => ({ grant: at(`folder`, what), label: t(`needs.grants.folder`, { what }) })),
        ...conversation.shelves.map((what) => ({ grant: at(`shelf`, what), label: t(`needs.grants.shelf`, { what }) })),
        // An install card's "Allow installs for this conversation": the one yes that names no single thing.
        ...(conversation.installs ? [{ grant: at(`install`, ``), label: t(`needs.grants.installs`) }] : []),
        ...conversation.releases.map((release) => ({
            grant: at(`release`, release.subject),
            label: t(`needs.grants.release`, { what: release.subject }),
            note: t(`needs.grants.releasedBy`, { who: release.approvedBy, when: relativeTime(release.at) }),
        })),
    ];
};

const rows = computed(() =>
    conversations.value.map((conversation) => ({
        conversation,
        title: props.titleOf(conversation.conversationId),
        items: itemsOf(conversation),
    })),
);

const { busy, notice, run } = useAsyncAction();
const takeBack = async (grant: GrantRevoke): Promise<void> => {
    await run(async () => {
        await revoke.mutateAsync(grant);
    }, t(`needs.grants.couldNotTakeBack`));
};

const chatOf = (conversationId: string) => ({ path: `/`, query: { conversation: conversationId } });
</script>

<template>
    <section v-if="rows.length > 0" class="mb-6 flex flex-col gap-2">
        <h2 class="text-sm font-semibold text-content">{{ t(`needs.grants.title`) }}</h2>
        <p class="text-2xs text-muted">{{ t(`needs.grants.hint`) }}</p>
        <div v-for="row in rows" :key="row.conversation.conversationId" class="flex flex-col gap-1 rounded-lg border border-border px-3 py-2">
            <div class="flex items-center justify-between gap-3">
                <RouterLink :to="chatOf(row.conversation.conversationId)" class="min-w-0 truncate text-xs font-medium text-content hover:underline">{{ row.title }}</RouterLink>
                <span v-if="row.conversation.by && row.conversation.updatedAt" class="shrink-0 text-2xs text-subtle">
                    {{ t(`needs.grants.allowedBy`, { who: row.conversation.by, when: relativeTime(row.conversation.updatedAt) }) }}
                </span>
            </div>
            <ul class="flex flex-col">
                <li v-for="item in row.items" :key="`${item.grant.kind}:${item.grant.what}`" class="flex items-center justify-between gap-3 py-0.5">
                    <span class="min-w-0 text-xs text-content/85">
                        {{ item.label }}
                        <span v-if="item.note" class="text-2xs text-subtle">· {{ item.note }}</span>
                    </span>
                    <button type="button" class="shrink-0 text-2xs text-link hover:underline disabled:cursor-default disabled:text-[var(--ui-button-off-content)] disabled:hover:no-underline" :disabled="busy" @click="takeBack(item.grant)">
                        {{ t(`needs.grants.takeBack`) }}
                    </button>
                </li>
            </ul>
        </div>
        <Notice v-if="notice" :of="notice" />
    </section>
</template>
