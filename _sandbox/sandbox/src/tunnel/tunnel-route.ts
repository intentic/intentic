import { errorMessage } from "@intentic/base/errors";
import type { IntenticLine } from "@intentic/sandbox-contract";
import { ORPCError } from "@orpc/server";
import type { CapabilitiesStore } from "../capabilities/capabilities-store.js";
import { tunnelEntry, type TunnelKindName } from "./tunnel-links.js";

// A route's tunnel by id, or the 404 it answers; one of another kind under that id is as absent as none.
export const tunnelEntryOr404 = async <K extends TunnelKindName>(capabilities: Pick<CapabilitiesStore, "get">, kind: K, id: string) => {
    const entry = await tunnelEntry(capabilities, kind, id);
    if (entry === undefined) {
        throw new ORPCError("NOT_FOUND", { message: `no ${kind} capability with that id` });
    }
    return entry;
};

/* ONE MOVE PER TUNNEL AT A TIME, streamed. */
export async function* heldStream(
    held: Set<string>,
    id: string,
    verb: string,
    run: () => AsyncGenerator<IntenticLine>,
    terminal: () => Promise<string>,
): AsyncGenerator<IntenticLine> {
    if (held.has(id)) {
        throw new ORPCError("CONFLICT", { message: `"${id}" is already ${verb}, wait for it to finish` });
    }
    held.add(id);
    try {
        yield* run();
        yield { kind: "log", message: await terminal() };
        yield { kind: "result", ok: true };
    } catch (error) {
        const message = errorMessage(error);
        yield { kind: "error", message };
        throw new ORPCError("INTERNAL_SERVER_ERROR", { message });
    } finally {
        held.delete(id);
    }
}
