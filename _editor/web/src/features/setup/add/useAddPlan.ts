import type { HostedPlanState, SandboxSummary } from "@intentic/api-contract";
import { FREE_TIER, type HostedTierId, isHostedTierId } from "@intentic/constants";
import type { NoticeModel } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { t } from "@intentic/ui/i18n";
import { computed, type Ref, ref } from "vue";
import { ownCloudSandboxes } from "../../../models/sandbox/live/cloudSandboxes";
import { freeRefusal, newSandboxPlan } from "../../settings/hosted-plan/planChange";
import { planLadder, rungOf, rungsOnSale } from "../../settings/hosted-plan/planLadder";

/** What a new sandbox on a paid plan needs of the account's plans. */
export interface AddPlans {
    readonly state: () => HostedPlanState | undefined;
    /** A plan at `tier` held for the sandbox about to be made: an open one reused, else one added for the rest of the month. */
    readonly reserve: (tier: string) => Promise<void>;
    /** A first purchase at `tier` on Stripe's page: true once it landed (the app waits for it), false where the browser left. */
    readonly checkout: (tier: string) => Promise<boolean>;
}

/** Whether the account can buy a paid plan for a new machine of ours: the platform sells one, and its plans are read. */
export const plansSold = (plans: AddPlans | undefined): boolean => {
    const state = plans?.state();
    return state?.enabled === true && rungsOnSale(state).size > 0;
};

/**
 * THE PLAN A MACHINE OF OURS IS MADE ON (2026-11-26): Free, or a paid plan that the press reserves for it first (an account
 * already paying) or buys on Stripe's page first (everyone else). Picked in the form where the platform sells one, starting
 * on the plan the address named (pricing, or Stripe coming back), else Free. Free held by another sandbox of the reader's
 * says which, and the pick moves to the cheapest paid plan instead. `freeSpent` is the offer's older "none left".
 */
export const useAddPlan = (
    plans: AddPlans | undefined,
    sandbox: { readonly sandboxes: Readonly<Ref<readonly SandboxSummary[]>> },
    named: HostedTierId | undefined,
    freeSpent: () => boolean,
) => {
    const asked = ref<HostedTierId>(named ?? FREE_TIER.id);
    const ladder = computed(() => planLadder(plans?.state()));
    const rungs = computed(() => ladder.value.filter((rung) => rung.free || rung.onSale));
    const refused = computed<Readonly<Record<string, string>>>(() => {
        const free = ladder.value.find((rung) => rung.free);
        if (free === undefined) {
            return {};
        }
        // The platform names the sandbox holding Free; an older one only says, in its offer, that none is left.
        const holder = ownCloudSandboxes(sandbox.sandboxes.value)[0];
        const spent = freeSpent() ? (holder === undefined ? t(`settings.plans.freeUsed`) : t(`settings.plans.freeUsedBy`, { name: holder.name })) : undefined;
        const why = freeRefusal(plans?.state(), ladder.value, undefined) ?? spent;
        return why === undefined ? {} : { [free.id]: why };
    });
    const tier = computed<HostedTierId>({
        get: () => {
            if (refused.value[asked.value] === undefined) {
                return asked.value;
            }
            const open = rungs.value.find((rung) => refused.value[rung.id] === undefined)?.id;
            return isHostedTierId(open) ? open : asked.value;
        },
        set: (next) => {
            asked.value = next;
        },
    });
    const sold = computed(() => plansSold(plans));
    // What the press does on that plan: its words, its sentence about money, and whether it pays.
    const offer = computed(() => (sold.value ? newSandboxPlan(plans?.state(), rungOf(ladder.value, tier.value), Date.now()) : undefined));
    // The plan the machine is asked for: none on Free, so it is made exactly as it was before plans.
    const laneTier = (): HostedTierId | undefined => (rungOf(ladder.value, tier.value).free ? undefined : tier.value);

    // The paid plan settled before anything is made: Stripe's page for an account paying for nothing yet (the browser
    // leaves for it; the app waits for it and carries on), then a plan reserved for it. False where the press stops here,
    // with its refusal handed to `refuse`.
    const payFirst = async (refuse: (notice: NoticeModel) => void): Promise<boolean> => {
        const paid = laneTier();
        const press = offer.value;
        if (paid === undefined || press === undefined || plans === undefined) {
            return true;
        }
        try {
            if (press.act === `checkout` && !(await plans.checkout(paid))) {
                return false;
            }
            await plans.reserve(paid);
            return true;
        } catch (err) {
            refuse(noticeFrom(err, t(`settings.plans.newSandbox.couldntReserve`)));
            return false;
        }
    };

    return { tier, rungs, refused, sold, offer, laneTier, payFirst };
};

export type AddPlan = ReturnType<typeof useAddPlan>;
