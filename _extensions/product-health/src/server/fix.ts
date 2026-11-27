import { errorMessage } from "@intentic/base/errors";
import type { ExtensionCaller } from "@intentic/extension-api";
import { clipTitle } from "@intentic/sandbox-contract/ids/conversation-ids";
import { planFixAttempt } from "@intentic/sandbox-contract/state/fix-attempt-plan";
import type { Finding, FixRequest } from "../wire.js";
import { type BriefContext, briefOf, nudgeOf, titleOf } from "./brief.js";
import type { AgentRun, HealthDaemon } from "./daemon.js";
import { fixBase } from "./snapshot.js";

/* PUTTING AN AGENT ON A FINDING: one failure, many attempts, one live answer, as the Pipelines board does it and with the
   contract's own plan (state/fix-attempt-plan.ts), so a second press continues the attempt in play rather than opening
   a rival, and "Start over" files the last one away first. The turn runs as whoever pressed (`asCaller`), held to their
   access, in an isolated worktree, as this extension's `product-health-fix` job, and marked as carrying outside words:
   part of every brief came from users' browsers. */

// The job its turns run as, this extension's own (`contributes.modelRoles`).
const PRODUCT_HEALTH_FIX = `product-health-fix`;

export type FixOutcome =
    | { readonly kind: `started`; readonly conversationId: string; readonly attempt: number }
    // The latest attempt is still in play, or a turn took the conversation between the plan and the start.
    | { readonly kind: `busy`; readonly conversationId: string; readonly reason: string };

// The earlier attempt would not be filed away, or the daemon refused the start; carries its reason.
export class FixRefused extends Error {}

export type FixDaemon = Pick<HealthDaemon, `roster` | `archivedIds` | `say` | `stop` | `archive`>;

// What the plan's opening says: a continued attempt the nudge under the title it has, one turned away the whole brief
// under the title it has, a fresh one the whole brief under a title numbered past attempt 1.
const openingOf = (kind: `new` | `continue` | `resend` | `start-over`, attempt: number, finding: Finding, ctx: BriefContext): Pick<AgentRun, `prompt` | `title`> => {
    if (kind === `continue`) {
        return { prompt: nudgeOf(finding) };
    }
    if (kind === `resend`) {
        return { prompt: briefOf(finding, ctx) };
    }
    return { prompt: briefOf(finding, ctx), title: clipTitle(attempt > 1 ? `${titleOf(finding)} (attempt ${attempt})` : titleOf(finding)) };
};

const turnOf = (request: FixRequest, conversationId: string, opening: Pick<AgentRun, `prompt` | `title`>): AgentRun => {
    const turn: AgentRun = { ...request.pick, ...opening, conversationId, isolated: true, job: PRODUCT_HEALTH_FIX, outsideWake: `PostHog` };
    if (request.sendAt !== undefined) {
        turn.sendAt = request.sendAt;
    }
    if (request.sendAtReopen === true) {
        turn.sendAtReopen = true;
    }
    return turn;
};

/** Starts, continues or declines an attempt at a finding. */
export const startFindingFix = async (
    daemon: FixDaemon,
    finding: Finding,
    request: FixRequest,
    ctx: BriefContext & { readonly caller?: ExtensionCaller | undefined },
): Promise<FixOutcome> => {
    const roster = await daemon.roster();
    const known = [...roster.map((agent) => agent.id), ...(await daemon.archivedIds())];
    const plan = planFixAttempt(fixBase(finding.id), roster, known, request.mode);
    if (plan.kind === `busy`) {
        return { kind: `busy`, conversationId: plan.conversationId, reason: plan.stance.hint };
    }
    if (plan.kind === `start-over`) {
        if (plan.stopFirst) {
            await daemon.stop(plan.retire);
        }
        const refused = await daemon.archive(plan.retire);
        if (refused !== undefined) {
            throw new FixRefused(`The earlier attempt could not be set aside: ${refused}`);
        }
    }
    const turn = turnOf(request, plan.conversationId, openingOf(plan.kind, plan.attempt, finding, ctx));
    let delivered: string;
    try {
        delivered = (await daemon.say(turn, ctx.caller)).delivered;
    } catch (error) {
        throw new FixRefused(errorMessage(error));
    }
    if (delivered === `steered`) {
        return { kind: `busy`, conversationId: plan.conversationId, reason: `An agent is already working on this.` };
    }
    return { kind: `started`, conversationId: plan.conversationId, attempt: plan.attempt };
};
