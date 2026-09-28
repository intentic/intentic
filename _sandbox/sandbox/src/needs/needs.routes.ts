import { needsContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../app-env.js";
import type { Caller } from "../auth/auth.js";
import { NeedRefusal, type Needs } from "./needs.js";
import { revokeGrant, standingGrants, type StandingGrantsDeps } from "./standing-grants.js";

// The needs door (docs/architecture/needs.md): the agent's CLIs raise and withdraw on the agent token, naming their
// conversation by the header every agent CLI sends; a person lists and answers what they may see of the fleet.

export interface NeedsRoutesDeps {
    readonly needs: Needs;
    // The yeses those needs left standing, reviewed and taken back from Needs you.
    readonly grants: StandingGrantsDeps;
    // Whether this caller may see a conversation, by the fleet's own rule (auth/fleet-scope.ts).
    readonly visible: (caller: Caller | undefined, conversationId: string) => boolean;
}

// The header an agent CLI names its conversation by (platform/leftovers.ts workloadStamp, INTENTIC_TURN_OWNER).
const CONVERSATION_HEADER = "x-intentic-conversation";

const STATUS: Readonly<Record<NeedRefusal["code"], "NOT_FOUND" | "FORBIDDEN" | "CONFLICT" | "BAD_REQUEST">> = {
    not_found: "NOT_FOUND",
    not_yours: "FORBIDDEN",
    forbidden: "FORBIDDEN",
    closed: "CONFLICT",
    invalid: "BAD_REQUEST",
};

// A refusal the needs service worded, as the route's answer; anything else is a fault and goes through as one.
const answered = async <T>(work: Promise<T>): Promise<T> => {
    try {
        return await work;
    } catch (error) {
        if (error instanceof NeedRefusal) {
            throw new ORPCError(STATUS[error.code], { message: error.message });
        }
        throw error;
    }
};

export const createNeedsRoutes = ({ needs, grants, visible }: NeedsRoutesDeps) => {
    const i = implement(needsContract).$context<OrpcContext>();
    const conversationOf = (context: OrpcContext): string | undefined => context.headers.get(CONVERSATION_HEADER) ?? undefined;
    // A need of a conversation the caller cannot see reads as no need at all, as that conversation does.
    const seen = async (id: string, context: OrpcContext): Promise<void> => {
        const need = await needs.get(id);
        if (need === undefined || !visible(context.identity, need.conversationId)) {
            throw new ORPCError("NOT_FOUND", { message: `No need is named "${id}".` });
        }
    };
    return {
        ask: i.ask.handler(({ input, context, signal }) =>
            needs.ask({ raise: input, conversationId: conversationOf(context), signal: signal ?? new AbortController().signal }),
        ),
        mine: i.mine.handler(async ({ context }) => ({ needs: [...(await needs.mine(conversationOf(context)))] })),
        withdraw: i.withdraw.handler(({ input, context }) => answered(needs.withdraw(input.id, conversationOf(context)))),
        list: i.list.handler(async ({ input, context }) => ({
            needs: (await needs.list(input)).filter((need) => visible(context.identity, need.conversationId)),
        })),
        answer: i.answer.handler(async ({ input, context }) => {
            await seen(input.id, context);
            return answered(needs.answer(input.id, input.answer, { email: context.identity?.email }));
        }),
        provideSecret: i.provideSecret.handler(async ({ input, context }) => {
            await seen(input.id, context);
            return answered(needs.provide(input.id, input.value, { email: context.identity?.email }));
        }),
        // As visible as the conversations they widened, like the needs that made them.
        grants: i.grants.handler(async ({ context }) => {
            const { conversations } = await standingGrants(grants);
            return { conversations: conversations.filter((conversation) => visible(context.identity, conversation.conversationId)) };
        }),
        revokeGrant: i.revokeGrant.handler(async ({ input, context }) => {
            if (!visible(context.identity, input.conversationId) || !(await revokeGrant(grants, input))) {
                throw new ORPCError("NOT_FOUND", { message: `Nothing like that is allowed to this conversation: "${input.what}" is not one of its ${input.kind} grants.` });
            }
            return { ok: true } as const;
        }),
    };
};
