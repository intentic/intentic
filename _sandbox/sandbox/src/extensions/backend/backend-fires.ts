import type { AutomationFire } from "@intentic/extension-api/runtime";
import { ExtensionFireSchema } from "@intentic/sandbox-contract/extension-protocol";
import { z } from "zod";

// The wire between the daemon's automations engine and the backend host's `POST /fires/<id>` door (2026-11-26): one
// automation's fire in, for the handler its target names (`api.automations.onFire`). Both ends parse with this, so the
// host (a child process that must not load the daemon's services) and the engine cannot drift on the shape.

const FireRequestSchema = z.object({ fire: ExtensionFireSchema });

// The fire a request to the door carries, or undefined for a body that is not one.
export const extensionFireIn = async (request: Request): Promise<AutomationFire | undefined> => {
    // allow(silent-catch): a body that is not JSON is no fire, which the door answers with a 400
    const body: unknown = await request.json().catch(() => undefined);
    return FireRequestSchema.safeParse(body).data?.fire;
};

export const fireRequestBody = (fire: AutomationFire): string => JSON.stringify(FireRequestSchema.parse({ fire }));
