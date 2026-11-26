import { apiContract, type HostedPlanState } from "@intentic/api-contract";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../../../context.js";
import { requireUser } from "../../../guards.js";
import { kickPlanChange } from "./hosted-plan-changes.js";
import { StripeError, type StripeGateway } from "./hosted-plan-stripe.js";
import { decidePlanChange, decideRelease, decideReserve, type PlanRefusal } from "./plan-change.js";
import { carryOutPlanChange, PlanRefused } from "./plan-ledger.js";

/* THE ROUTES THAT PUT SANDBOXES ON PLANS: one sandbox onto a plan, a plan reserved for a sandbox about to be made, an
 * open plan ended at renewal. plan-change.ts decides what each bills and when; plan-ledger.ts writes it. */

const os = implement(apiContract).$context<OrpcContext>();

export interface PlanChangeRouteDeps {
    readonly stripe: (context: OrpcContext) => StripeGateway;
    // The whole plan answer every write ends by reading again (hosted-plan.orpc.ts).
    readonly stateOf: (context: OrpcContext) => Promise<HostedPlanState>;
    readonly requireEnabled: (context: OrpcContext) => void;
}

/** The caller's own cloud sandbox, or a 404 that does not say whether somebody else's exists. */
export const requireOwnedMachine = async (context: OrpcContext, userId: string, sandboxId: string): Promise<void> => {
    const machine = await context.prisma.hostedMachine.findUnique({ where: { sandboxId }, select: { sandbox: { select: { ownerId: true } } } });
    if (machine === null || machine.sandbox.ownerId !== userId) {
        throw new ORPCError(`NOT_FOUND`, { message: `you have no cloud sandbox by that id` });
    }
};

// Wire status per refusal, its code riding along as `reason` so the editor can offer the way on (`checkout` opens
// Stripe's page for a first plan). No refusal has billed anything.
const PLAN_REFUSALS = {
    "unknown-tier": `BAD_REQUEST`,
    "not-on-sale": `BAD_REQUEST`,
    "too-many": `BAD_REQUEST`,
    "nothing-to-do": `CONFLICT`,
    "free-taken": `CONFLICT`,
    checkout: `PRECONDITION_FAILED`,
    card: `PRECONDITION_FAILED`,
} as const satisfies Record<PlanRefusal, string>;

type Decide = Parameters<typeof carryOutPlanChange>[5];

// Carries out one decision; its refusals and Stripe's come back in words the editor shows at the control pressed.
const planWrite = async (context: OrpcContext, gateway: StripeGateway, userId: string, sandboxId: string | undefined, decide: Decide) => {
    try {
        return await carryOutPlanChange(context.prisma, context.config, gateway, userId, sandboxId, decide);
    } catch (error) {
        if (error instanceof PlanRefused) {
            throw new ORPCError(PLAN_REFUSALS[error.code], { message: error.message, data: { reason: error.code } });
        }
        if (error instanceof StripeError) {
            throw new ORPCError(`BAD_GATEWAY`, { message: error.message });
        }
        throw error;
    }
};

export const planChangeRoutes = ({ stripe, stateOf, requireEnabled }: PlanChangeRouteDeps) => ({
    // One sandbox onto a plan: written to Stripe and its row now, its machine resized in the background when the change
    // is for now (an upgrade, a retry); a downgrade waits for the renewal date and the plan-change job.
    changePlan: os.hostedPlan.changePlan.handler(async ({ context, input }) => {
        const user = requireUser(context);
        requireEnabled(context);
        await requireOwnedMachine(context, user.id, input.sandboxId);
        const decision = await planWrite(context, stripe(context), user.id, input.sandboxId, (ledger) =>
            decidePlanChange(ledger.account, ledger.machines, input.sandboxId, input.tier, new Date()),
        );
        if (decision.resize) {
            kickPlanChange(context.prisma, context.config, context.logger, input.sandboxId);
        }
        return stateOf(context);
    }),
    // A plan for a sandbox about to be made: provisioning at that tier then lands on it (hosted.ts withHostedSlot).
    reserve: os.hostedPlan.reserve.handler(async ({ context, input }) => {
        const user = requireUser(context);
        requireEnabled(context);
        await planWrite(context, stripe(context), user.id, undefined, (ledger) => decideReserve(ledger.account, ledger.machines, input.tier));
        return stateOf(context);
    }),
    // An open plan, one no sandbox is on, ended at the renewal date.
    release: os.hostedPlan.release.handler(async ({ context, input }) => {
        const user = requireUser(context);
        requireEnabled(context);
        await planWrite(context, stripe(context), user.id, undefined, (ledger) => decideRelease(ledger.account, ledger.machines, input.tier));
        return stateOf(context);
    }),
});
