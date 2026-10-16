<!-- What single conversations may do beyond their persona or area, still standing: one row per conversation, saying which
     one it is, whether it can still use any of it (an archived one cannot until it is brought back) and where to open it,
     with each thing it may do under it in plain words and taken back with one press. A turn already running keeps what it
     mounted; the conversation's next use runs without it. Above them, the yeses that name no conversation: policy lines
     allowed with a card's Always, approved hook sets and approved workspace extensions. -->
<script setup lang="ts">
import type { ConversationGrantRevoke, GrantRevoke, OwnerGrant, StandingGrants } from "@intentic/sandbox-contract/schemas/needs";
import { Button, type IconName, Notice, Row, RowGroup, RowNote, timeAgo } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, watch } from "vue";
import { RouterLink } from "vue-router";
import { useAuth } from "../../../client/auth/useAuth";
import { useOperations } from "../../../workbench/operations/operations";
import { agentDisplayTitle, agentStatusMeta } from "../../../models/agent-status/agentStatus-meta";
import { useAgents } from "../../../models/fleet/useAgents";
import { useStandingGrants } from "./useStandingGrants";

const t = useT();

const { conversations, ownerWide, revoke, unreadable } = useStandingGrants();
const { fleet, agentById, loadArchived, archiveLoading } = useAgents();
const { user } = useAuth();

type StandingConversation = StandingGrants["conversations"][number];

interface Item {
    readonly grant: GrantRevoke;
    readonly icon: IconName;
    readonly label: string;
    // The two that reach furthest (every request, a secret anywhere) wear the warning hue; the rest name one thing.
    readonly wide?: boolean;
    // Who allowed it and when, for a yes whose row has no conversation line to say so.
    readonly note?: string;
}

// The reader's own yes reads as "you": in a box with one owner every row would otherwise repeat their address.
const whoOf = (who: string): string => (who.toLowerCase() === user.value?.email?.toLowerCase() ? t(`needs.grants.you`) : who);

// Each yes as what the conversation may now do, in the order a person scans for the risky ones: everything at once,
// accounts, folders, whole shelves, unasked installs, secrets past their host guard, credential requests that stopped
// asking, released secrets.
const itemsOf = (conversation: StandingConversation): readonly Item[] => {
    const at = (kind: ConversationGrantRevoke["kind"], what: string): ConversationGrantRevoke => ({ conversationId: conversation.conversationId, kind, what });
    return [
        // Any permission card's "Allow everything in this conversation": the widest yes there is, so it leads.
        ...(conversation.everything ? [{ grant: at(`everything`, ``), icon: `unlock` as const, label: t(`needs.grants.everything`), wide: true }] : []),
        ...conversation.capabilities.map((what) => ({ grant: at(`capability`, what), icon: `link` as const, label: t(`needs.grants.capability`, { what }) })),
        ...conversation.folders.map((what) => ({ grant: at(`folder`, what), icon: `folder` as const, label: t(`needs.grants.folder`, { what }) })),
        ...conversation.shelves.map((what) => ({ grant: at(`shelf`, what), icon: `wrench` as const, label: t(`needs.grants.shelf`, { what }) })),
        // An install card's "Allow installs for this conversation": the one yes that names no single thing.
        ...(conversation.installs ? [{ grant: at(`install`, ``), icon: `box` as const, label: t(`needs.grants.installs`) }] : []),
        // A host guard card's "Allow <secret> anywhere in this conversation".
        ...conversation.secrets.map((what) => ({ grant: at(`secret`, what), icon: `key` as const, label: t(`needs.grants.secret`, { what }), wide: true })),
        // A credential gateway card's "Allow requests like this with <name> in this conversation", in the card's words.
        // The rule's identity alone does not say whose rule it is, so the take-back names the capability too.
        ...conversation.rules.map((pass) => ({
            grant: { ...at(`rule`, pass.rule), capability: pass.capability },
            icon: `shield` as const,
            label: t(`needs.grants.rule`, { what: pass.said }),
        })),
        ...conversation.releases.map((release) => ({
            grant: at(`release`, release.subject),
            icon: `lock` as const,
            label: t(`needs.grants.release`, { what: release.subject, who: whoOf(release.approvedBy), when: timeAgo(release.at, { days: true }) }),
        })),
    ];
};

// One owner-wide yes in words, with what makes it a take-back of its own: the policy line itself, the hook set's digest,
// the extension's id.
const ownerItemOf = (grant: OwnerGrant): Item => {
    if (grant.kind === `command-policy`) {
        return {
            grant: { kind: grant.kind, what: grant.line },
            icon: `shield`,
            label: t(`needs.grants.commandPolicy`, { what: grant.line }),
            note: grant.by === undefined ? timeAgo(grant.at, { days: true }) : t(`needs.grants.allowedBy`, { who: whoOf(grant.by), when: timeAgo(grant.at, { days: true }) }),
        };
    }
    if (grant.kind === `hook-set`) {
        return {
            grant: { kind: grant.kind, what: grant.digest },
            icon: `wrench`,
            label: t(`needs.grants.hookSet`, { what: grant.hooks.join(`; `) }),
            note: timeAgo(grant.at, { days: true }),
        };
    }
    return {
        grant: { kind: grant.kind, what: grant.id },
        icon: `box`,
        label: t(`needs.grants.extension`, { what: grant.id }),
        note: [grant.powers.length === 0 ? `` : t(`needs.grants.extensionPowers`, { what: grant.powers.join(`; `) }), timeAgo(grant.at, { days: true })]
            .filter((part) => part !== ``)
            .join(` · `),
    };
};

const ownerItems = computed(() => ownerWide.value.map(ownerItemOf));

// Which records this sandbox could not read, in words: none of those stands until the file is fixed.
const KIND_WORDS = { "command-policy": `commandPolicy`, "hook-set": `hookSet`, extension: `extension` } as const;
const unreadableWhat = computed(() => unreadable.value.map((kind) => t(`needs.grants.kind.${KIND_WORDS[kind]}`)).join(`, `));

// Where the conversation stands, which decides whether any of this can still be used: a live one uses it on its next
// turn, an archived one only if somebody brings it back, and one that is on neither list cannot be opened from here.
type Standing = { readonly kind: `live`; readonly status: string } | { readonly kind: `archived`; readonly at: number | undefined } | { readonly kind: `unknown` };

const standingOf = (conversationId: string): Standing => {
    const agent = agentById(conversationId);
    if (agent === undefined) {
        return { kind: `unknown` };
    }
    // The fleet's half wins: a conversation brought back keeps its archive entry until the archive is read again.
    const live = fleet.value.some((candidate) => candidate.id === conversationId);
    return live ? { kind: `live`, status: agentStatusMeta(agent.status).label } : { kind: `archived`, at: agent.archivedAt };
};

// The line under the conversation's name: its standing first, since that says whether anything below still matters,
// then who last allowed something here and when.
const lineOf = (conversation: StandingConversation, standing: Standing): string | undefined => {
    if (standing.kind === `archived`) {
        return standing.at === undefined
            ? t(`needs.grants.archived`)
            : t(`needs.grants.archivedAt`, { when: timeAgo(standing.at, { days: true }) });
    }
    if (standing.kind === `unknown`) {
        // Still being looked up in the archive, or the lookup could not say: nothing is claimed either way.
        return archiveLoading.value ? undefined : t(`needs.grants.notFound`);
    }
    const allowed =
        conversation.by !== undefined && conversation.updatedAt !== undefined
            ? t(`needs.grants.lastAllowed`, { who: whoOf(conversation.by), when: timeAgo(conversation.updatedAt, { days: true }) })
            : undefined;
    return allowed === undefined ? standing.status : `${standing.status} · ${allowed}`;
};

// Live conversations first, as the daemon ordered them (the one a person just allowed leads); archived ones after,
// since what they hold applies to nothing until they are brought back.
const RANK = { live: 0, unknown: 1, archived: 2 } as const satisfies Record<Standing["kind"], number>;
const rows = computed(() =>
    conversations.value
        .map((conversation) => {
            const standing = standingOf(conversation.conversationId);
            const agent = agentById(conversation.conversationId);
            return {
                conversation,
                standing,
                title: agent === undefined ? t(`needs.grants.untitled`) : agentDisplayTitle(agent),
                line: lineOf(conversation, standing),
                items: itemsOf(conversation),
            };
        })
        .toSorted((left, right) => RANK[left.standing.kind] - RANK[right.standing.kind]),
);

// A conversation the live roster does not hold may be archived: the archive is read once something here needs it, so
// such a row can say it is put away rather than leave the reader guessing whether it still runs.
watch(
    () => conversations.value.some((conversation) => agentById(conversation.conversationId) === undefined),
    (missing) => {
        if (missing) {
            void loadArchived();
        }
    },
    { immediate: true },
);

// Each taking-back is the grant's, in the operations ledger: one in flight holds its own row's press wherever the list
// is drawn again, and a refusal is still said there. The newest refusal is the one under the list.
const ops = useOperations(`needs/grants`);
const keyOf = (grant: GrantRevoke): string =>
    `conversationId` in grant ? `${grant.conversationId}/${grant.kind}/${grant.capability ?? ``}/${grant.what}` : `everywhere/${grant.kind}/${grant.what}`;
const allKey = (conversationId: string): string => `${conversationId}/*`;
const allBusy = (conversationId: string): boolean => ops.at(allKey(conversationId))?.state === `running`;
const busyOn = (grant: GrantRevoke): boolean =>
    ops.at(keyOf(grant))?.state === `running` || (`conversationId` in grant && allBusy(grant.conversationId));
const notice = computed(() => ops.all.value.findLast((operation) => operation.state === `failed`)?.failure);
const takeBack = async (item: Item): Promise<void> => {
    ops.dismiss(keyOf(item.grant));
    await ops.run(keyOf(item.grant), {
        what: t(`needs.grants.takingBack`, { what: item.label }),
        failed: t(`needs.grants.couldNotTakeBack`),
        // The line leaving the list says it was taken.
        quiet: true,
        task: async () => {
            await revoke.mutateAsync(item.grant);
        },
    });
};
// Every yes one conversation holds, one at a time: a refusal stops there, and what was already taken stays taken.
const takeBackAll = async (conversationId: string, title: string, items: readonly Item[]): Promise<void> => {
    ops.dismiss(allKey(conversationId));
    await ops.run(allKey(conversationId), {
        what: t(`needs.grants.takingBackAll`, { title }),
        failed: t(`needs.grants.couldNotTakeBack`),
        quiet: true,
        task: async () => {
            for (const item of items) {
                await revoke.mutateAsync(item.grant);
            }
        },
    });
};

// The conversation's own page, which opens an archived one too: its transcript and its work are kept there.
const pageOf = (conversationId: string): string => `/agents/${encodeURIComponent(conversationId)}`;
</script>

<template>
    <!-- Draws nothing while nothing stands, as the other machine doors do. The yeses that name no conversation come first:
         each reaches every conversation at once. -->
    <RowGroup
        v-if="ownerItems.length > 0 || unreadable.length > 0"
        :label="t(`needs.grants.ownerWideTitle`)"
    >
        <RowNote v-if="unreadable.length > 0" variant="block"><Notice tone="warning" size="sm">{{ t(`needs.grants.unreadable`, { what: unreadableWhat }) }}</Notice></RowNote>
        <Row v-for="item in ownerItems" :key="keyOf(item.grant)" :icon="item.icon" :description="item.note" indent>
            <template #title>
                <span class="break-words">{{ item.label }}</span>
            </template>
            <template #control>
                <Button
                    :label="t(`ui.action.revoke`)"
                    size="small"
                    tier="quiet"
                    tone="danger"
                    :disabled="busyOn(item.grant)"
                    @click="takeBack(item)"
                />
            </template>
        </Row>
        <RowNote>{{ t(`needs.grants.ownerWideWhen`) }}</RowNote>
    </RowGroup>
    <RowGroup v-if="rows.length > 0" :label="t(`needs.grants.title`)">
        <Row
            v-for="row in rows"
            :key="row.conversation.conversationId"
            icon="comments"
            :description="row.line"
            indent
        >
            <!-- An archived conversation's name steps back, since nothing under it is in use; its Revoke presses do not,
                 since clearing what it still holds is the one thing left to do about it. -->
            <template #title>
                <span :class="row.standing.kind === `archived` ? `text-muted` : ``">{{ row.title }}</span>
            </template>
            <template #control>
                <Button v-if="row.standing.kind !== `unknown`" size="small" tier="quiet" :as="RouterLink" :to="pageOf(row.conversation.conversationId)">
                    {{ t(`ui.action.open`) }}
                    <Icon name="arrow-up-right" class="text-2xs" />
                </Button>
                <Button
                    v-if="row.items.length > 1"
                    :label="t(`needs.grants.takeBackAll`)"
                    size="small"
                    tier="quiet"
                    tone="danger"
                    :disabled="allBusy(row.conversation.conversationId)"
                    @click="takeBackAll(row.conversation.conversationId, row.title, row.items)"
                />
            </template>
            <template #below>
                <ul class="flex flex-col" :aria-label="t(`needs.grants.itemsOf`, { title: row.title })">
                    <li v-for="item in row.items" :key="keyOf(item.grant)" class="flex items-center gap-2 py-0.5">
                        <Icon :name="item.icon" class="shrink-0 text-2xs" :class="item.wide ? `text-warning` : `text-subtle`" />
                        <span class="min-w-0 flex-1 break-words text-xs text-content">{{ item.label }}</span>
                        <Button
                            :label="t(`ui.action.revoke`)"
                            size="small"
                            tier="quiet"
                            tone="danger"
                            class="shrink-0"
                            :disabled="busyOn(item.grant)"
                            @click="takeBack(item)"
                        />
                    </li>
                </ul>
            </template>
        </Row>
        <RowNote>{{ t(`needs.grants.when`) }}</RowNote>
        <RowNote v-if="notice" variant="block"><Notice :of="notice" /></RowNote>
    </RowGroup>
</template>
