import { errorMessage } from "@intentic/base/errors";
import { deploysContract } from "@intentic/sandbox-contract/contracts/deploys.contract";
import type { DeployRecord } from "@intentic/sandbox-contract/schemas/deploys";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../app-env.js";
import { noteAudit } from "../audit/audit-http.js";
import { ensureRight } from "../auth/owner-gates.js";
import { provenTurnOrRefuse } from "../auth/scope/proven-turn.js";
import type { Services } from "../composition.js";
import { opt } from "../opt.js";
import { provenTurnOf } from "../seams/workload-stamp.js";
import { deployEnvironments } from "./deploy-environments.js";

// THE MANAGED ENVIRONMENTS' DOOR (contracts/deploys.contract.ts), over the engine (deploys-engine.ts). Reads, deploys,
// rollbacks and promotions reach the agent token too (the `deploys` CLI): a fix turn ships its fix. Granting a stack
// secrets is the owner's: the contract keeps `grant` and `revoke` off every machine credential, and each handler holds
// its caller to the Secrets right again, as `setGate` does, so no token a route's grants admit can lift its own limit.
// An agent asks for a grant on a card instead (`requestGrant`, a `deploy` need).

export type DeploysRoutesDeps = Pick<Services, "deploys" | "needs" | "hostHub" | "workspace" | "capabilities" | "auth">;

// Who asked, for the record's one line: the reason they gave, the person, or the conversation the agent works in.
const askedBy = (context: OrpcContext, reason: string | undefined): string | undefined => {
    if (reason !== undefined && reason.trim() !== "") {
        return reason.trim();
    }
    if (context.identity !== undefined) {
        return `by ${context.identity.email}`;
    }
    const turn = provenTurnOf((name) => context.headers.get(name) ?? undefined);
    return "conversationId" in turn && turn.conversationId !== undefined ? `from conversation ${turn.conversationId}` : undefined;
};

export const createDeploysRoutes = (services: DeploysRoutesDeps) => {
    const i = implement(deploysContract).$context<OrpcContext>();
    const { deploys } = services;
    // The record as queued, or once the engine is done with it when the caller waits.
    const answered = async (record: DeployRecord, wait: boolean | undefined, signal: AbortSignal | undefined): Promise<{ record: DeployRecord }> => ({
        record: wait === true ? await deploys.settled(record.id, signal) : record,
    });
    return {
        environments: i.environments.handler(() =>
            deployEnvironments({
                root: services.workspace.root,
                device: services,
                deviceCards: () => services.capabilities.list(),
                records: () => deploys.records(),
                grants: () => deploys.grants(),
                stackState: deploys.stackState,
                secretsChanged: deploys.secretsChanged,
                forgeProblem: deploys.forgeProblem,
            }),
        ),
        history: i.history.handler(async ({ input }) => ({ records: [...(await deploys.history(input, input.limit))] })),
        deploy: i.deploy.handler(async ({ input, context, signal }) => {
            noteAudit({ target: `${input.repo}:${input.stack}` });
            const trigger = { kind: "manual" as const, ...opt("detail", askedBy(context, input.reason)) };
            return answered(await deploys.enqueue({ repo: input.repo, stack: input.stack, commit: input.commit, trigger }), input.wait, signal);
        }),
        rollback: i.rollback.handler(async ({ input, context, signal }) => {
            noteAudit({ target: `${input.repo}:${input.stack}` });
            return answered(await deploys.rollback(input, askedBy(context, undefined)), input.wait, signal);
        }),
        promote: i.promote.handler(async ({ input, context, signal }) => {
            noteAudit({ target: `${input.repo}:${input.to}` });
            return answered(await deploys.promote(input.repo, input.from, input.to, askedBy(context, undefined)), input.wait, signal);
        }),
        // Names only. Unreadable is an error here, not an empty list: "nothing granted" is a claim this cannot make.
        grants: i.grants.handler(async () => {
            try {
                return { grants: [...(await deploys.grants())] };
            } catch (error) {
                throw new ORPCError("INTERNAL_SERVER_ERROR", { message: errorMessage(error) });
            }
        }),
        // A card in the asking conversation, answered by the owner: a `deploy` need (needs/kinds/deploy-need.ts).
        requestGrant: i.requestGrant.handler(({ input, context, signal }) =>
            services.needs.ask({
                raise: { ask: { kind: "deploy", repo: input.repo, stack: input.stack }, ...opt("why", input.why) },
                conversationId: provenTurnOrRefuse(context.headers),
                signal: signal ?? new AbortController().signal,
            }),
        ),
        grant: i.grant.handler(async ({ input, context }) => {
            await ensureRight(services, context.headers, "secrets");
            noteAudit({ target: `${input.repo}:${input.stack}` });
            await deploys.grant(input, context.identity?.email);
            return { grants: [...(await deploys.grants())] };
        }),
        revoke: i.revoke.handler(async ({ input, context }) => {
            await ensureRight(services, context.headers, "secrets");
            noteAudit({ target: `${input.repo}:${input.stack}` });
            if (!(await deploys.revoke(input))) {
                throw new ORPCError("NOT_FOUND", { message: `"${input.stack}" in "${input.repo}" has no grant to take back.` });
            }
            return { ok: true } as const;
        }),
    };
};
