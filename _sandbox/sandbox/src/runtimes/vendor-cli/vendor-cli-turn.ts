import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import type { RoutedAgentTurn } from "@intentic/sandbox-contract/schemas/agent";
import {
    type AgentAdapter,
    armPlan,
    attemptProbe,
    healthReady,
    healthUnavailable,
    healthUnknown,
    type TurnArmPlan,
    type TurnContext,
} from "../../agent/providers/adapter.js";
import { withAttachments } from "../../sessions/vocabulary/attachment-note.js";
import { releasingMounts } from "../../agent/tools/turn-mounts.js";
import { turnToolsOf, type TurnToolsDeps } from "../../agent/tools/turn-tools.js";
import type { Services } from "../../composition.js";
import { opt } from "../../opt.js";
import { turnPersona } from "../../personas/personas.js";
import { assertAgentExecutionContext } from "../../workload/agent-execution.js";
import { type DaemonServersDeps, daemonServersFor } from "../daemon-tools/daemon-servers.js";
import { CLI_OWN_PICK } from "./vendor-cli-catalog.js";
import type { CliParts } from "./vendor-cli-slice.js";
import { type CliStore, liveCliAccounts } from "./vendor-cli-store.js";
import { cliAgentId, cliBinary, cliMissing, type VendorCli } from "./vendor-cli.js";

// A turn on a vendor CLI's loop: the account's own warm `acp` process (its home is its sign-in), the turn's model where
// the account's list offers it, and the same remote MCP set and daemon servers the ACP floor mounts. Beyond an installed
// ACP agent, the account, its sign-in and its model are the daemon's to choose, as Devin's are.

type CliReadiness =
    { readonly ok: true; readonly binary: string } | { readonly ok: false; readonly detail: string; readonly code?: "subscription-required" };

// One answer to whether the CLI can serve a turn, read by the turn's refusal and the health probe alike, in the order
// that names the right fix: no account (connect), every sign-in refused (connect again), no program (install).
export const cliReadiness = async (cli: VendorCli, store: Pick<CliStore, "accounts">): Promise<CliReadiness> => {
    const accounts = await store.accounts();
    if (accounts.length === 0) {
        return { ok: false, code: "subscription-required", detail: `Sign in to ${cli.name} in Sandbox ▸ Models to run it here.` };
    }
    if (!accounts.some((account) => account.refusedAt === undefined)) {
        return { ok: false, detail: `${cli.name} could no longer renew this sandbox's sign-in. Sign in to it again in Sandbox ▸ Models.` };
    }
    const binary = await cliBinary(cli);
    return binary === undefined ? { ok: false, detail: cliMissing(cli) } : { ok: true, binary };
};

// A turn the CLI refused as signed out: its sign-in could not be renewed, so the row is marked for a new one and the
// turn says where that is, rather than the installed-agent advice to run a login command.
async function* refusedSignIn(cli: VendorCli, store: CliStore, accountId: string, events: AsyncIterable<AgentEvent>): AsyncGenerator<AgentEvent> {
    for await (const event of events) {
        if (event.kind === "error" && event.code === "acp-auth-required") {
            const stored = await store.read(accountId);
            if (stored !== undefined) {
                await store.write({ ...stored, refusedAt: Date.now() });
            }
            yield { kind: "error", message: `${cli.name} could no longer renew this account's sign-in. Sign in again in Sandbox ▸ Models.`, own: true };
            continue;
        }
        yield event;
    }
}

// What a CLI turn is planned from: the ACP runtime that serves it, and the seams its MCP tools and browsers are mounted from.
export type CliTurnDeps = TurnToolsDeps &
    DaemonServersDeps &
    Pick<Services, "acpAgent" | "capabilities" | "config" | "files" | "workspace" | "sandboxSettings">;

export const planCliTurn = async (
    cli: VendorCli,
    parts: CliParts,
    services: CliTurnDeps,
    input: RoutedAgentTurn,
    context: TurnContext,
    granted: readonly Capability[],
): Promise<TurnArmPlan> => {
    const readiness = await cliReadiness(cli, parts.store);
    if (!readiness.ok) {
        return { ok: false, ...opt("code", readiness.code), message: readiness.detail };
    }
    // The pinned account while it can still serve; a pin naming none of this CLI's accounts names the provider's other
    // credential (the turn moved loops), so the first connected one serves, the default where nothing else decides.
    const accounts = await liveCliAccounts(parts.store);
    const account = accounts.find((entry) => entry.id === input.account) ?? accounts[0];
    if (account === undefined) {
        return { ok: false, message: `That ${cli.name} account is no longer connected. Pick another one, or sign in again in Sandbox ▸ Models.` };
    }
    // The pinned model while the account offers it, else the account's own default. A model picked from the provider's
    // other list that the CLI does not offer runs on its default rather than failing: the init frame names what ran.
    const catalog = await parts.models.models();
    const model = input.model !== undefined && catalog.models.some((entry) => entry.id === input.model) ? input.model : catalog.default;
    // A warm session keeps the MCP config it was opened with, so its turns share the conversation's bearer.
    const mounted = await turnToolsOf(services, granted, {
        conversationId: input.conversationId,
        anonymousBrowser: context.persona?.powers.browser ?? true,
        shell: context.persona?.powers.shell ?? true,
        extensions: context.persona?.powers.extensions,
        warmSession: true,
    });
    // The daemon's own servers on the same lease, as the ACP floor mounts them (acp-adapter.ts).
    const persona = context.persona ?? turnPersona({ personas: [], actsAs: undefined, unattended: false });
    const settings = context.settings ?? (await services.sandboxSettings.get());
    const daemon = daemonServersFor(services, { input, context, persona, granted, settings, mounted, gate: false });
    const launch = cli.launch(readiness.binary, parts.store.homeOf(account.id));
    const options = model === CLI_OWN_PICK ? {} : { model };
    const tools = [...mounted.tools, ...daemon.tools];
    return armPlan(
        releasingMounts(
            (request) => refusedSignIn(cli, parts.store, account.id, services.acpAgent(cliAgentId(cli, account.id), launch, request, options)),
            mounted,
        ),
        withAttachments(
            {
                ...context.base,
                spec: { ...context.base.spec, model },
                tools: { ...context.base.tools, ...opt("remote", tools.length > 0 ? tools : undefined), diagnostics: daemon.diagnostics },
                hooks: { ...context.base.hooks, relay: daemon.relay },
                credential: { kind: "container" },
            },
            context.attachmentPaths,
        ),
        // The real account id, so usage and refusal frames name the connection that served.
        account.id,
    );
};

// The adapter a CLI's loop is served by, under the runtime name its capability record carries.
export const cliAdapter = <R extends VendorCli["runtime"], D extends CliTurnDeps>(
    cli: VendorCli & { readonly runtime: R },
    partsOf: (services: D) => CliParts,
): AgentAdapter<R, D> => ({
    runtime: cli.runtime,
    preflight: (services, input, context, granted) => planCliTurn(cli, partsOf(services), services, input, context, granted),
    health: async (services) => {
        const readiness = await attemptProbe(() => cliReadiness(cli, partsOf(services).store));
        if (readiness === undefined) {
            return healthUnknown();
        }
        return readiness.ok ? healthReady() : healthUnavailable(readiness.detail);
    },
    // Always true, as on the ACP floor: a session lives in the CLI's own store under the account's home, which the warm
    // process is asked at resume time (acp-agent.ts); answering "gone" here would retire every session blindly.
    holdsSession: async (_services, _sessionId, execution) => {
        assertAgentExecutionContext(execution);
        return true;
    },
});
