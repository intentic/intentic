<!-- The sandboxes this one follows: how far each is backed (L0–L3), how complete and witnessed what was read is, and any
     held one with why; follow a new one by address, or find one through the guides this sandbox trusts. -->
<script setup lang="ts">
import { Button, Row, RowGroup, RowNote, StatusBadge, timeAgo, ui, useNow } from "@intentic/extension-ui";
import { ref } from "vue";
import { t } from "./i18n.js";
import type { DiscoverHitView, PeerView } from "./wire";

const { peers, canWrite, busy, hits, searching } = defineProps<{
    peers: readonly PeerView[];
    canWrite: boolean;
    busy: boolean;
    hits: readonly DiscoverHitView[] | undefined;
    searching: boolean;
}>();
const emit = defineEmits<{ follow: [address: string]; release: [sourceId: string]; search: [type: string, keyword: string] }>();
const now = useNow();

const address = ref(``);
const keyword = ref(``);
const type = ref(``);

const follow = (target: string): void => {
    if (target.trim() !== ``) {
        emit(`follow`, target.trim());
        address.value = ``;
    }
};

const levelVariant = (level: PeerView[`level`]): `success` | `info` | `neutral` => (level >= 2 ? `success` : level === 1 ? `info` : `neutral`);

const describe = (peer: PeerView): string => {
    const parts = [peer.address, t(`peers.completeness`, { verified: peer.verified, declared: peer.declared })];
    if (peer.witnesses > 0) {
        parts.push(t(`peers.witnessed`, { count: peer.witnessed, of: peer.witnesses }));
    }
    if (peer.passkeyShare > 0) {
        parts.push(t(`peers.passkeyShare`, { percent: Math.round(peer.passkeyShare * 100) }));
    }
    if (peer.syncedAt !== null) {
        parts.push(t(`peers.synced`, { when: timeAgo(peer.syncedAt, { now: now.value }) }));
    }
    return parts.join(` · `);
};

const vouchWords = (peer: PeerView): string =>
    peer.vouches.map((vouch) => `${vouch.trusted ? `✓` : `·`} ${vouch.issuer}: ${Object.entries(vouch.claims).map(([key, value]) => `${key}=${value}`).join(`, `)}`).join(`\n`);
</script>

<template>
    <div class="flex flex-col gap-4">
        <RowGroup v-if="canWrite" :label="t(`peers.follow`)">
            <RowNote variant="block"><div class="flex flex-col gap-2">
                <div class="flex flex-wrap gap-2">
                    <input v-model="address" :class="ui.input({ size: `sm` }, `min-w-64 flex-1`)" :placeholder="t(`peers.addressPlaceholder`)" spellcheck="false" @keydown.enter="follow(address)" />
                    <Button :label="t(`peers.followButton`)" size="small" tier="accent" :loading="busy" :disabled="address.trim() === ``" @click="follow(address)" />
                </div>
                <p class="text-2xs text-subtle">{{ t(`peers.followHint`) }}</p>
            </div></RowNote>
        </RowGroup>

        <RowGroup :label="t(`peers.title`)">
            <Row v-for="peer in peers" :key="peer.sourceId" :title="peer.name" :description="describe(peer)" :tone="peer.state === `ok` ? undefined : `danger`">
                <template #meta>
                    <StatusBadge :variant="levelVariant(peer.level)" :label="t(`peers.level.${peer.level}`)" size="sm" />
                    <StatusBadge v-if="peer.state === `equivocation`" variant="danger" :label="t(`peers.equivocation`)" size="sm" />
                    <StatusBadge v-else-if="peer.state === `held`" variant="warning" :label="t(`peers.held`)" size="sm" />
                </template>
                <template v-if="canWrite && peer.state !== `ok`" #control>
                    <Button :label="t(`peers.release`)" size="small" tier="quiet" :disabled="busy" @click="emit(`release`, peer.sourceId)" />
                </template>
                <template v-if="peer.problem !== null || peer.vouches.length > 0" #below>
                    <p v-if="peer.problem !== null" class="text-2xs text-danger">{{ peer.problem.replace(/\.?$/u, `.`) }}{{ peer.hasEvidence ? ` ${t(`peers.evidenceKept`)}` : `` }}</p>
                    <p v-if="peer.vouches.length > 0" class="whitespace-pre-line text-2xs text-muted">{{ vouchWords(peer) }}</p>
                </template>
            </Row>
            <RowNote v-if="peers.length === 0">{{ t(`peers.empty`) }}</RowNote>
        </RowGroup>

        <RowGroup :label="t(`discover.title`)">
            <RowNote variant="block"><div class="flex flex-col gap-2">
                <div class="flex flex-wrap gap-2">
                    <select v-model="type" :class="ui.input({ size: `sm` }, `w-auto`)">
                        <option value="">{{ t(`discover.anyType`) }}</option>
                        <option value="SocialMediaPosting">{{ t(`discover.types.posts`) }}</option>
                        <option value="Article">{{ t(`discover.types.articles`) }}</option>
                        <option value="BlogPosting">{{ t(`discover.types.blogPosts`) }}</option>
                    </select>
                    <input v-model="keyword" :class="ui.input({ size: `sm` }, `min-w-48 flex-1`)" :placeholder="t(`discover.keyword`)" @keydown.enter="emit(`search`, type, keyword)" />
                    <Button :label="t(`discover.search`)" size="small" tier="quiet" :loading="searching" @click="emit(`search`, type, keyword)" />
                </div>
                <p class="text-2xs text-subtle">{{ t(`discover.hint`) }}</p>
            </div></RowNote>
            <Row v-for="hit in hits ?? []" :key="hit.address" :title="hit.name" :description="`${hit.address} · ${hit.types.join(`, `)}${hit.keywords.length ? ` · ${hit.keywords.join(`, `)}` : ``} · ${t(`discover.via`, { guide: hit.via })}`">
                <template v-if="canWrite" #control>
                    <Button :label="t(`peers.followButton`)" size="small" tier="quiet" :disabled="busy || peers.some((peer) => peer.address === hit.address)" @click="follow(hit.address)" />
                </template>
            </Row>
            <RowNote v-if="hits !== undefined && hits.length === 0">{{ t(`discover.none`) }}</RowNote>
        </RowGroup>
    </div>
</template>
