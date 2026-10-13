import type { AgentProvider, Capability, RoutedAgentTurn } from "@intentic/sandbox-contract";
import {
    type AdapterHealth,
    armPlan,
    attemptProbe,
    healthReady,
    healthUnavailable,
    healthUnknown,
    type TurnArmPlan,
    type TurnContext,
} from "../../../agent/providers/adapter.js";
import type { AgentRequest, OpenCodeCredential } from "../../../agent/providers/agent-request.js";
import { withAttachments } from "../../../agent/prompt/attachment-note.js";
import { engineMissing, enginesReady } from "../../../agent/providers/provider-module.js";
import { resolveRoute, type RouteDeps, routeReadiness } from "../../../agent/providers/routes/model-routes.js";
import { releasingMounts } from "../../../agent/tools/turn-mounts.js";
import type { Services } from "../../../composition.js";
import { opt } from "../../../opt.js";
import { sharedServerRefusal } from "../../../privacy/harness-route.js";
import { doorToolsOf, type DoorToolsDeps } from "../../daemon-tools/door-tools.js";
import { openCodeRouteId } from "./opencode-routes.js";

// Another provider's model on the OpenCode loop: its route (agent/providers/routes/model-routes.ts) is one of the
// provider entries the shared server was booted with (opencode-routes.ts), and the turn names that entry. Planned the
// way a Grok turn is (grok-provider.ts): the turn's remote MCP servers and the daemon's own over the door, no gate server,
// since OpenCode asks the daemon over its own permission channel.

// What a hosted turn is planned from: the route's stores, the shared server whose providers it checks, and the loop.
export type OpenCodeHostedDeps = DoorToolsDeps & RouteDeps & Pick<Services, "grokAgent" | "openCode" | "privacyShield">;

export const planOpenCodeRouteTurn = async (
    services: OpenCodeHostedDeps,
    input: RoutedAgentTurn,
    context: TurnContext,
    granted: readonly Capability[],
): Promise<TurnArmPlan> => {
    const resolved = await resolveRoute(services, { provider: input.agent, loop: "opencode", account: input.account, model: input.model });
    if (!resolved.ok) {
        return resolved;
    }
    const { route } = resolved;
    // The shared server fixes its providers' base URLs at spawn, so a shield turned on since may not be in front yet.
    let refused: string | undefined;
    try {
        refused = await sharedServerRefusal(services.privacyShield, services.openCode.shielded, route.shield);
    } catch (error) {
        refused = error instanceof Error ? error.message : "the privacy shield's policy could not be read";
    }
    if (refused !== undefined) {
        return { ok: false, message: refused };
    }
    const credential: OpenCodeCredential = { kind: "opencode-route", providerID: openCodeRouteId(route.provider, route.account) };
    const spec = { ...context.base.spec, model: route.model };
    // A sealed request reads nothing past its prompt, so nothing is mounted for it.
    if (context.base.policy.sealed === true) {
        return armPlan(services.grokAgent, { ...context.base, spec, credential }, route.attribution);
    }
    // Leased last, once nothing can refuse the turn: only the loop it arms releases it.
    const { mounted, tools, hooks } = await doorToolsOf(services, input, context, granted, false);
    const request: AgentRequest<OpenCodeCredential> = {
        ...context.base,
        // The turn's steering queue, which the OpenCode loop sends on as steers (capabilities.steering).
        spec: { ...spec, ...opt("steering", context.steering) },
        tools,
        hooks,
        credential,
    };
    return armPlan(releasingMounts(services.grokAgent, mounted), withAttachments(request, context.attachmentPaths), route.attribution);
};

// Whether OpenCode can host this provider now: the binary in the image, and a route its turn could take.
export const openCodeRouteHealth = async (services: Pick<Services, "capabilities" | "cliProxy" | "config" | "minted">, provider: AgentProvider): Promise<AdapterHealth> => {
    const readiness = await attemptProbe(() => routeReadiness(services, provider, "opencode"));
    if (readiness === undefined) {
        return healthUnknown();
    }
    if (!readiness.ready) {
        return healthUnavailable(readiness.detail);
    }
    return (await enginesReady({ engines: ["opencode"] })) ? healthReady() : healthUnavailable(engineMissing("the OpenCode CLI", "OpenCode"));
};
