import { errorMessage } from "@intentic/base/errors";
import type { IntenticLine } from "@intentic/sandbox-contract";
import { ORPCError } from "@orpc/server";

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
