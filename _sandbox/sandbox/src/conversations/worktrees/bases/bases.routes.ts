import { basesContract } from "@intentic/sandbox-contract/contracts/bases.contract";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../../../app-env.js";
import { provenTurnOrRefuse } from "../../../auth/scope/proven-turn.js";
import { BaseRefused, type BaseCheckouts, SHELL_HOLDER } from "./base-checkouts.js";

// The base door (base-checkouts.ts): the `base` CLI on the agent token, naming its conversation by the header every
// agent CLI sends (platform/leftovers.ts workloadStamp, INTENTIC_TURN_OWNER). That name is only who holds the base: a
// base is a checkout of a commit everyone may read, so a wrong name keeps one alive longer and lends nothing. Believed
// only with its turn's proof all the same (2026-11-24): a bare name could let go of another conversation's bases. A shell
// naming none holds as the shell, which lets go of nobody else's.

// A refusal the bases worded, as the route's answer; anything else is a fault and goes through as one.
const answered = async <T>(work: Promise<T>): Promise<T> => {
    try {
        return await work;
    } catch (error) {
        if (error instanceof BaseRefused) {
            throw new ORPCError("BAD_REQUEST", { message: error.message });
        }
        throw error;
    }
};

export const createBasesRoutes = (bases: BaseCheckouts) => {
    const i = implement(basesContract).$context<OrpcContext>();
    const holderOf = (context: OrpcContext): string => {
        return provenTurnOrRefuse(context.headers) ?? SHELL_HOLDER;
    };
    return {
        ensure: i.ensure.handler(({ input, context }) => answered(bases.ensure(input, holderOf(context)))),
        list: i.list.handler(async () => ({ bases: await bases.list() })),
        drop: i.drop.handler(({ input, context }) => {
            if (input.all === true) {
                return answered(bases.release(holderOf(context), "all"));
            }
            if (input.gitDir === undefined) {
                throw new ORPCError("BAD_REQUEST", { message: "Name the repository by its git dir, or let go of every base with all." });
            }
            return answered(bases.release(holderOf(context), { gitDir: input.gitDir, head: input.head, at: input.at }));
        }),
    };
};
