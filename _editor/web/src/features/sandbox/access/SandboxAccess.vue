<script setup lang="ts">
import { SegmentedControl } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useRole } from "../../../client/sandbox/useRole";
import { ACCESS_PARTS, type AccessPart, LINKED_SANDBOXES_ANCHOR, MEMBER_ACCESS_PARTS } from "../../../models/sandbox/sandboxNav";
import AccessAllowed from "./parts/AccessAllowed.vue";
import AccessPeople from "./parts/AccessPeople.vue";
import AccessPrograms from "./parts/AccessPrograms.vue";
import AccessSignIn from "./parts/AccessSignIn.vue";
import { useWaitingLinkTasks } from "../../../models/sandbox/useInboundLinks";
import { useStandingGrants } from "./useStandingGrants";

// ACCESS: everything about getting into this sandbox, in four parts drawn as tabs, underlined as Agent's and Activity's
// are: who may come in (People), how they prove it (Sign-in), what reaches the box with nobody signing in (Programs), and
// what conversations were allowed past their fences (Allowed). Until 2026-10-19 these were ten groups on one page, read
// top to bottom: an owner come to mint a token scrolled past the roster, the AI notice and every passkey, and a standing
// "allow everything" sat at the very foot, under the people who happened to be online.
//
// The part lives in the query, so a link lands on it (sandboxNav.ts `accessPath`, a search answer's `?section=`); People,
// the first, writes no param. A member below maintainer is drawn their own card and their own passkeys, the two parts the
// daemon answers them. Each part mounts only while it is open, so the door counts are read only by whoever asks for them.

const { open = undefined } = defineProps<{
    // A person a link names (`?open=<email>`), handed down by the hub so a reload lands on them.
    open?: string;
}>();

const t = useT();
const route = useRoute();
const router = useRouter();
const { canShip } = useRole();

const parts = computed<readonly AccessPart[]>(() => (canShip.value ? ACCESS_PARTS : MEMBER_ACCESS_PARTS));
const first = computed<AccessPart>(() => parts.value[0] ?? `people`);

// Two parts carry a count, so what waits on them is seen from whichever part the reader came for: Programs the tasks a
// linked sandbox handed over that wait for the owner's yes, Allowed what stands past a persona or an area.
const waitingTasks = useWaitingLinkTasks(canShip);
const { conversations, ownerWide } = useStandingGrants(canShip);
const allowedCount = computed(() => conversations.value.length + ownerWide.value.length);
const COUNTS = computed<Partial<Record<AccessPart, number>>>(() => ({ programs: waitingTasks.value, allowed: allowedCount.value }));

const LABELS = computed<Record<AccessPart, string>>(() => ({
    people: t(`sandbox.sandboxAccess.partPeople`),
    "sign-in": t(`sandbox.sandboxAccess.partSignIn`),
    programs: t(`sandbox.sandboxAccess.partPrograms`),
    allowed: t(`sandbox.sandboxAccess.partAllowed`),
}));
// A tab's chip is drawn only above zero, so the parts with nothing to count carry none.
const options = computed(() => parts.value.map((value) => ({ label: LABELS.value[value], value, badge: COUNTS.value[value] ?? 0 })));

// Two addresses made before the parts had names land on the one that holds Linked sandboxes: a waiting linked task's row
// (sandboxNav.ts `linkedSandboxesHref`) named only the section's anchor, and a daemon's push about a task waiting for its
// owner's yes names `?section=links` (sandbox links/link-tasks.ts, until it says `programs`).
const legacy = (): AccessPart | undefined =>
    route.hash === `#${LINKED_SANDBOXES_ANCHOR}` || route.query[`section`] === `links` ? parts.value.find((entry) => entry === `programs`) : undefined;

// Pushed, not replaced, so Back returns to the part before.
const part = computed<AccessPart>({
    get: () => parts.value.find((entry) => entry === route.query[`section`]) ?? legacy() ?? first.value,
    set: (value) => void router.push({ query: { ...route.query, section: value === first.value ? undefined : value }, hash: `` }),
});
</script>

<template>
    <!-- `@container`: every part thins against this pane, which the docked chat can leave a third of the window's width. -->
    <div class="@container flex flex-col gap-6">
        <SegmentedControl v-model="part" :options="options" variant="underline" :aria-label="t(`sandbox.sandboxAccess.parts`)" />

        <AccessPeople v-if="part === `people`" :open="open" />
        <AccessSignIn v-else-if="part === `sign-in`" />
        <AccessPrograms v-else-if="part === `programs`" />
        <AccessAllowed v-else />
    </div>
</template>
