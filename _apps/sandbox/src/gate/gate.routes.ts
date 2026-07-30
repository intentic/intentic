import { gateContract } from "@intentic/sandbox-contract";
import { implement } from "@orpc/server";
import { streamAgent } from "../agent/agent.routes.js";
import type { WakeFn } from "../automations/scheduler.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { landingGate } from "./gate.js";

// The landing gate's owner-facing surface — the Changes panel's badge and its two buttons. Every verb addresses
// the ONE gate this process has (gate/gate.ts), so none of them takes an id.
//
// `run` and `fix` both return immediately and let the panel's poll follow the work: a suite takes minutes and a
// fix turn longer, and an oRPC call held open for either would die on the first proxy timeout with the work still
// going. That is the /ci/fix pattern — start it detached, report through the state the view already polls.
export const createGateRoutes = (services: Services, wake: WakeFn = streamAgent) => {
    const i = implement(gateContract).$context<OrpcContext>();
    const gate = landingGate(services, wake);
    return {
        verdict: i.verdict.handler(() => gate.verdict()),
        run: i.run.handler(() => {
            gate.run();
            return { ok: true as const };
        }),
        cancel: i.cancel.handler(() => {
            gate.cancel();
            return { ok: true as const };
        }),
        // A fix for a verdict that is no longer red (a land moved the tree, another fix already fixed it) is not
        // an error — the gate checks the state itself and does nothing, which is what makes a stale click on a
        // panel that has since moved on harmless.
        fix: i.fix.handler(async () => {
            void gate.fix().catch((error: unknown) => services.logger.warn({ err: error }, "gate: fix turn failed"));
            return { ok: true as const };
        }),
    };
};
