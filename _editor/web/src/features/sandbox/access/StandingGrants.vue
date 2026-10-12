<!-- What people have allowed beyond a persona or an area, and the credentials released, still standing: each taken back
     with one press. A turn already running keeps what it mounted; the conversation's next turn runs without it. -->
<script setup lang="ts">
import type { GrantRevoke, StandingGrants } from "@intentic/sandbox-contract";
import { Notice, timeAgo, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { RouterLink } from "vue-router";
import { useOperations } from "../../../workbench/operations/operations";
import { useStandingGrants } from "./useStandingGrants";

const t = useT();

// `empty` is what to say when nothing stands, for a page that is only this list; without it an empty list draws nothing.
const props = defineProps<{ titleOf: (conversationId: string) => string; empty?: string }>();

const { conversations, revoke } = useStandingGrants();

interface Item {
    readonly grant: GrantRevoke;
    readonly label: string;
    readonly note?: string | undefined;
}

type StandingConversation = StandingGrants["conversations"][number];

// Each yes in words, in the order a person scans for the risky ones: everything at once, accounts, folders, whole
// shelves, unasked installs, secrets past their host guard, credential requests that stopped asking, released secrets.
const itemsOf = (conversation: StandingConversation): readonly Item[] => {
    const at = (kind: GrantRevoke["kind"], what: string): GrantRevoke => ({ conversationId: conversation.conversationId, kind, what });
    return [
        // Any permission card's "Allow everything in this conversation": the widest yes there is, so it leads.
        ...(conversation.everything ? [{ grant: at(`everything`, ``), label: t(`needs.grants.everything`) }] : []),
        ...conversation.capabilities.map((what) => ({ grant: at(`capability`, what), label: t(`needs.grants.capability`, { what }) })),
        ...conversation.folders.map((what) => ({ grant: at(`folder`, what), label: t(`needs.grants.folder`, { what }) })),
        ...conversation.shelves.map((what) => ({ grant: at(`shelf`, what), label: t(`needs.grants.shelf`, { what }) })),
        // An install card's "Allow installs for this conversation": the one yes that names no single thing.
        ...(conversation.installs ? [{ grant: at(`install`, ``), label: t(`needs.grants.installs`) }] : []),
        // A host guard card's "Allow <secret> anywhere in this conversation".
        ...conversation.secrets.map((what) => ({ grant: at(`secret`, what), label: t(`needs.grants.secret`, { what }) })),
        // A credential gateway card's "Allow requests like this with <name> in this conversation", in the card's words.
        // The rule's identity alone does not say whose rule it is, so the take-back names the capability too.
        ...conversation.rules.map((pass) => ({
            grant: { ...at(`rule`, pass.rule), capability: pass.capability },
            label: t(`needs.grants.rule`, { what: pass.said }),
        })),
        ...conversation.releases.map((release) => ({
            grant: at(`release`, release.subject),
            label: t(`needs.grants.release`, { what: release.subject }),
            note: t(`needs.grants.releasedBy`, { who: release.approvedBy, when: timeAgo(release.at, { days: true }) }),
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

// Each taking-back is the grant's, in the operations ledger: one in flight holds its own row's press wherever the list
// is drawn again, and a refusal is still said there. The newest refusal is the one under the list.
const ops = useOperations(`needs/grants`);
const keyOf = (grant: GrantRevoke): string => `${grant.conversationId}/${grant.kind}/${grant.capability ?? ``}/${grant.what}`;
const busyOn = (grant: GrantRevoke): boolean => ops.at(keyOf(grant))?.state === `running`;
const notice = computed(() => ops.all.value.filter((operation) => operation.state === `failed`).at(-1)?.failure);
const takeBack = async (grant: GrantRevoke, label: string): Promise<void> => {
    ops.dismiss(keyOf(grant));
    await ops.run(keyOf(grant), {
        what: t(`needs.grants.takingBack`, { what: label }),
        failed: t(`needs.grants.couldNotTakeBack`),
        // The row leaving the list says it was taken.
        quiet: true,
        task: async () => {
            await revoke.mutateAsync(grant);
        },
    });
};

const chatOf = (conversationId: string) => ({ path: `/`, query: { conversation: conversationId } });
</script>

<template>
    <p v-if="rows.length === 0 && empty" :class="ui.emptyState(`py-16`)">{{ empty }}</p>
    <section v-if="rows.length > 0" class="mb-6 flex flex-col gap-2">
        <h2 class="text-sm font-semibold text-content">{{ t(`needs.grants.title`) }}</h2>
        <p class="text-2xs text-muted">{{ t(`needs.grants.hint`) }}</p>
        <div v-for="row in rows" :key="row.conversation.conversationId" class="flex flex-col gap-1 rounded-lg border border-border px-3 py-2">
            <div class="flex items-center justify-between gap-3">
                <RouterLink :to="chatOf(row.conversation.conversationId)" class="min-w-0 truncate text-xs font-medium text-content hover:underline">{{ row.title }}</RouterLink>
                <span v-if="row.conversation.by && row.conversation.updatedAt" class="shrink-0 text-2xs text-subtle">
                    {{ t(`needs.grants.allowedBy`, { who: row.conversation.by, when: timeAgo(row.conversation.updatedAt, { days: true }) }) }}
                </span>
            </div>
            <ul class="flex flex-col">
                <li v-for="item in row.items" :key="keyOf(item.grant)" class="flex items-center justify-between gap-3 py-0.5">
                    <span class="min-w-0 text-xs text-content/85">
                        {{ item.label }}
                        <span v-if="item.note" class="text-2xs text-subtle">· {{ item.note }}</span>
                    </span>
                    <button type="button" class="shrink-0 text-2xs text-link hover:underline disabled:cursor-default disabled:text-[var(--ui-button-off-content)] disabled:hover:no-underline" :disabled="busyOn(item.grant)" @click="takeBack(item.grant, item.label)">
                        {{ t(`needs.grants.takeBack`) }}
                    </button>
                </li>
            </ul>
        </div>
        <Notice v-if="notice" :of="notice" />
    </section>
</template>
