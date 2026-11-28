import { type ConversationReader, personReader, registryProvenance } from "../../auth/scope/conversation-reader.js";
import type { Services } from "../../composition.js";
import { opt } from "../../opt.js";
import type { CallCaller, CallHandlers } from "../../s2s/calls/call-door.js";
import { createOperator, type OperateParty, type Operator, personShellPlace } from "../link-operate.js";
import { fleetReadAs, recordsDiagnostics, sandboxReader } from "../link-records.js";
import { takingCodeOf } from "./contact-tasks.js";
import { type TakingDeps, watchContactTask } from "./taking.js";

/* WHAT A CONTACT'S CALLS ANSWER, the callee's methods (2026-11-27, docs/architecture/messages.md "Calls"), registered on
 * the calls door (s2s/calls/call-door.ts), which has already checked the session, the method's grant and, for a
 * person-scoped contact, its person's floor. Each is what the link doors answer, by the same code:
 * - `records.*`: the fleet's reads and a diagnostics query (links/link-records.ts), read as this sandbox's own tools read
 *   for a sandbox-scoped contact, and cut to what its person may read (`personReader`) for a person-scoped one;
 * - `operate.*`: a command, its status and stop, a file read and written, where a person's shell runs here
 *   (links/link-operate.ts), each command read and stopped by the contact that started it alone;
 * - `task.watch`: one of the contact's tasks' live status, held until it moves (links/contacts/taking.ts). */

export interface ContactCallDeps {
    // Every Services member the fleet's reads reach: they are this sandbox's `agents` command's own.
    readonly services: Services;
    readonly operator: Operator;
    readonly taking: Pick<TakingDeps, "link" | "person">;
}

const NO_SUCH_TASK = "This sandbox holds no task by that id that your sandbox handed it.";

// Whose eyes a contact reads with: this sandbox's own tools' for its own contact, its person's for a person's, and nothing
// for a person no longer on the roster (the door refuses them first).
const readerFor = (services: Services, caller: CallCaller): ConversationReader => {
    if (caller.row.scope.kind === "sandbox") {
        return sandboxReader(services);
    }
    return caller.person === undefined ? () => false : personReader(caller.person, registryProvenance(services.agents));
};

const partyOf = (caller: CallCaller): OperateParty => ({ kind: "contact", id: caller.row.id, label: caller.row.name ?? caller.row.document.name });

/** `records.*`: this daemon's fleet reads and diagnostics, as the link doors answer them. */
export const recordsCallHandlers = (services: Services): CallHandlers => ({
    "records.fleet": async (input, caller) => fleetReadAs(services, readerFor(services, caller), { query: { ...input.query, ...opt("q", input.q) } }),
    "records.show": async (input, caller) => fleetReadAs(services, readerFor(services, caller), { handle: input.handle, query: input.query }),
    "records.bundle": async (input, caller) => fleetReadAs(services, readerFor(services, caller), { handle: input.handle, bundle: true }),
    "records.diagnostics": async (input) => ({ status: 200, body: await recordsDiagnostics(services, input) }),
});

/** `operate.*`: the operator the link doors run on, each command the calling contact's own. */
export const operateCallHandlers = (operator: Operator): CallHandlers => ({
    "operate.exec": async (input, caller, signal) => operator.exec(partyOf(caller), input, signal),
    "operate.status": async (input, caller, signal) => operator.status(partyOf(caller), input.id, input.waitS ?? 0, signal),
    "operate.stop": async (input, caller, signal) => operator.stop(partyOf(caller), input.id, signal),
    "operate.read": async (input, caller) => operator.read(partyOf(caller), input),
    "operate.write": async (input, caller) => operator.write(partyOf(caller), input),
});

/** `task.watch`: one of the calling contact's tasks, its live status. */
export const taskCallHandlers = (taking: Pick<TakingDeps, "link" | "person">): CallHandlers => ({
    "task.watch": async (input, caller, signal) => {
        const status = await watchContactTask(taking, caller.row, input.task, { after: input.after, waitS: input.waitS }, signal);
        return status === undefined ? { status: 404, body: { error: NO_SUCH_TASK } } : { status: 200, body: status };
    },
});

/** The handlers of every call method, over this daemon's records, operator and contact task books. */
const contactCallHandlers = ({ services, operator, taking }: ContactCallDeps): CallHandlers => ({
    ...recordsCallHandlers(services),
    ...operateCallHandlers(operator),
    ...taskCallHandlers(taking),
});

/** Serves every call method on this daemon's calls door; answers their removal. */
export const startContactCalls = (services: Services): (() => void) =>
    services.s2s.calls.door.serve(
        contactCallHandlers({
            services,
            operator: createOperator({ logger: services.logger, root: services.workspace.root, place: personShellPlace(services) }),
            taking: takingCodeOf(services),
        }),
    );
