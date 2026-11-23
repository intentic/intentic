import { sandboxSlugOf } from "@intentic/sandbox-run";
import type { Services } from "../composition.js";
import type { PeerCallGate } from "../peers/peer-routes.js";
import { judgeHostCommand, programOf } from "./host-command-guard.js";
import type { HostGuardDeps } from "./host-guard-deps.js";
import { type DeviceToolCall, DeviceToolCallSchema, judgeHostRestart, restartInCall, restartInProgram } from "./host-restart-guard.js";
import type { RpcMessage } from "../agent/tools/turn-mounts.js";
import { opt } from "../opt.js";
import { type AdminAsk, type RunCall, RunCallSchema, withAdminGrant } from "./admin/host-admin-ask.js";

// THE OWNER'S POLICY ON EVERY CALL HEADED FOR THEIR COMPUTER. The bridge is the last thing to see a call while someone can
// still be asked, so two questions are put here, in this order, to the one call: does it restart the sandbox every other
// agent runs in (host-restart-guard.ts), and does it carry a program the safety policy has a view on
// (host-command-guard.ts). Which tools carry a program is the contract's one table; a restart is the device's own tool or
// the same restart spelled as a command, whichever tool carries it. A refusal is returned as a tool result the model
// reads; the machine's own scopes remain the floor under both. (2026-11-23) A run_command with `admin: true` that the
// owner approved (or the conversation's auto-approve mark did) goes on with the sandbox's signed grant for exactly its
// command added, which the computer's service runs it on (admin/host-admin-ask.ts).

/** The two judges, so the order they are asked in can be tested without a card for each. */
export interface HostJudges {
    readonly restart: typeof judgeHostRestart;
    readonly command: typeof judgeHostCommand;
}

const JUDGES: HostJudges = { restart: judgeHostRestart, command: judgeHostCommand };

// run_command's `admin: true`, with the agent's reason for the card; undefined for any other call.
const adminOf = (toolCall: DeviceToolCall): AdminAsk | undefined => {
    const args = toolCall.params.arguments;
    return toolCall.params.name === "run_command" && args?.admin === true ? { why: args.why } : undefined;
};

// An approved administrator run goes with the sandbox's signed grant for exactly its command, which is what the
// computer's service runs it on (admin/host-admin-ask.ts): signed here, after the owner's yes, and never before it. Any other
// call goes as it came.
const granted = async (services: Services, call: RunCall | undefined, admin: AdminAsk | undefined): Promise<{ readonly forward: RpcMessage } | undefined> =>
    admin === undefined || call === undefined ? undefined : { forward: await withAdminGrant(services, call) };

export const hostCallGate =
    (services: Services, guards: HostGuardDeps, judges: HostJudges = JUDGES): PeerCallGate =>
    async (payload, call) => {
        // A notification, or anything that is not a tools/call with an id, has nowhere to send a refusal: forwarded.
        const parsed = DeviceToolCallSchema.safeParse(payload);
        if (!parsed.success) {
            return undefined;
        }
        const toolCall = parsed.data;
        const program = programOf(toolCall);
        // The slug is the one docker knows this container by (self-host.ts's ownSlug, not imported: it imports host-peer).
        const container = services.config.sandbox.name;
        const slug = sandboxSlugOf(container);
        const own = container === undefined || slug === undefined ? undefined : { slug, container };
        const restart = restartInCall(toolCall, slug) ?? (program === undefined ? undefined : restartInProgram(program, own));
        if (restart !== undefined) {
            const held = await judges.restart(services, guards, { machine: call.id, call: restart, conversationId: call.conversationId });
            if (held !== undefined) {
                return held;
            }
        }
        // The restart's yes is not a yes to the rest of the command: `ic sandbox restart work; rm -rf ~` is still judged.
        if (program === undefined) {
            return undefined;
        }
        const admin = adminOf(toolCall);
        const judged = await judges.command(services, guards, {
            machine: call.id,
            command: program.commandLine,
            kind: program.kind,
            conversationId: call.conversationId,
            ...opt("admin", admin),
        });
        return judged ?? (await granted(services, RunCallSchema.safeParse(payload).data, admin));
    };
