import type { HostedOffer, HostedPlanState, SandboxSummary } from "@intentic/api-contract";
import { FREE_TIER, type HostedTierId } from "@intentic/constants";
import { messageOr } from "@intentic/ui/async";
import { t } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import type { apiClient } from "../../../lib/useApi";
import type { useSandbox } from "../../../client/sandbox/useSandbox";
import { autoSandboxName } from "../../../client/sandbox/sandboxName";
import type { HostedJourney } from "./hostedJourney";

export interface HostedStartHost {
    readonly platform: {
        readonly sandbox: Pick<typeof apiClient.sandbox, `hostedOffer`>;
        readonly hostedPlan: Pick<typeof apiClient.hostedPlan, `state` | `checkout` | `setSlots`>;
    };
    readonly sandbox: Pick<ReturnType<typeof useSandbox>, `refresh` | `create`>;
    readonly journey: HostedJourney;
    readonly enter: (id: string, tier: HostedTierId) => Promise<void>;
    readonly redirect: (url: string) => void;
    readonly exclusive: (work: () => Promise<void>) => Promise<void>;
}

export const hostedBlock = (offer: HostedOffer | undefined): string | undefined => {
    if (offer === undefined || !offer.enabled) {
        return `unavailable`;
    }
    if (!offer.startJourney) {
        return `upgrade`;
    }
    if (offer.suspended) {
        return `restricted`;
    }
    if (offer.full) {
        return `full`;
    }
    if (offer.needsGoogle) {
        return `google`;
    }
    if (offer.remaining === 0) {
        return `occupied`;
    }
    if (offer.hours?.remaining === 0) {
        return `hours`;
    }
    return undefined;
};

const enterHostedSetup = (host: HostedStartHost, rows: readonly SandboxSummary[], tier: HostedTierId): Promise<void> =>
    host.exclusive(async () => {
        const previous = host.journey.read();
        if (previous?.sandboxId !== undefined && !rows.some((entry) => entry.id === previous.sandboxId)) {
            // Confirm the row was removed before starting again. This tab's earlier list may predate a
            // creation in another tab, which still owns the same request while this lock is held.
            const current = await host.sandbox.refresh();
            if (!current.some((entry) => entry.id === previous.sandboxId)) {
                host.journey.reset();
            }
        }
        // Another tab may have created this journey's row while the lock was held. Reuse the same UUID even
        // after an ambiguous network failure; the server returns the existing row with its current identity.
        const requestId = host.journey.request();
        const row = await host.sandbox.create(autoSandboxName(rows.map((entry) => entry.name)), requestId);
        const committedTier = host.journey.read()?.tier ?? tier;
        host.journey.remember(requestId, row.id, committedTier);
        await host.enter(row.id, committedTier);
    });

const readHostedAccount = (host: HostedStartHost, tier: HostedTierId) =>
    Promise.all([host.sandbox.refresh(), host.platform.sandbox.hostedOffer({ tier }), host.platform.hostedPlan.state()]);

// This entry reads before it writes. Normal setup retains responsibility for machine progress, recovery and readiness.
export const useHostedStart = (host: HostedStartHost, initialTier: HostedTierId = FREE_TIER.id) => {
    const tier = ref(initialTier);
    const rows = ref<readonly SandboxSummary[]>([]);
    const offer = ref<HostedOffer>();
    const plan = ref<HostedPlanState>();
    const loaded = ref(false);
    const refreshing = ref(false);
    const busy = ref(false);
    const error = ref<string>();
    const owned = computed(() => rows.value.filter((row) => row.hosted !== null && row.role === `owner`));
    const shared = computed(() => rows.value.filter((row) => row.hosted !== null && row.role !== `owner`));
    const pending = computed(() =>
        rows.value.find((row) => row.id === host.journey.read()?.sandboxId && row.role === `owner` && row.lastSeenAt === null),
    );
    const block = computed(() => hostedBlock(offer.value));
    let reading = 0;
    // Retain an absolute quantity after an ambiguous response. A retry can reconcile the same purchase, rather
    // than incrementing the subscription a second time.
    const purchases = new Map<HostedTierId, number>();

    const load = async (): Promise<void> => {
        const read = ++reading;
        refreshing.value = true;
        error.value = undefined;
        try {
            const [listed, offered, billed] = await readHostedAccount(host, tier.value);
            if (read !== reading) {
                return;
            }
            rows.value = listed;
            offer.value = offered;
            plan.value = billed;
            loaded.value = true;
        } catch (failure) {
            if (read === reading) {
                loaded.value = false;
                error.value = messageOr(failure, t(`hostedStart.loadFailed`));
            }
        } finally {
            if (read === reading) {
                refreshing.value = false;
            }
        }
    };

    const chooseTier = async (next: HostedTierId): Promise<void> => {
        if (busy.value) {
            return;
        }
        loaded.value = false;
        tier.value = next;
        await load();
    };

    const create = async (): Promise<void> => {
        if (busy.value || refreshing.value || !loaded.value || block.value !== undefined) {
            return;
        }
        busy.value = true;
        error.value = undefined;
        try {
            await enterHostedSetup(host, rows.value, tier.value);
        } catch (failure) {
            error.value = messageOr(failure, t(`hostedStart.createFailed`));
        } finally {
            busy.value = false;
        }
    };

    const purchase = async (): Promise<void> => {
        if (busy.value || refreshing.value || !loaded.value || tier.value === FREE_TIER.id || !plan.value?.enabled || block.value !== `occupied`) {
            return;
        }
        busy.value = true;
        error.value = undefined;
        try {
            // Entitlement may have landed since the page was read. Re-read before offering any additional charge.
            await load();
            if (!loaded.value || block.value !== `occupied` || !plan.value?.enabled) {
                return;
            }
            if (plan.value.onPlan && !plan.value.comped) {
                const quantity = purchases.get(tier.value) ?? (plan.value.hosted?.slotsByTier[tier.value] ?? 0) + 1;
                purchases.set(tier.value, quantity);
                await host.platform.hostedPlan.setSlots({ tier: tier.value, quantity });
                await load();
            } else {
                const result = await host.platform.hostedPlan.checkout({ tier: tier.value, returnTo: `/start/hosted` });
                host.redirect(result.url);
            }
        } catch (failure) {
            error.value = messageOr(failure, t(`hostedStart.purchaseFailed`));
        } finally {
            busy.value = false;
        }
    };

    return { tier, rows, offer, plan, loaded, refreshing, busy, error, owned, shared, pending, block, load, chooseTier, create, purchase };
};
