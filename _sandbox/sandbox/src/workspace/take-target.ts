import { access } from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "hono";
import type { AppEnv } from "../app-env.js";
import { callerEditFence } from "../areas/area-scope.js";
import type { Services } from "../composition.js";
import { resolveWorkspacePath } from "./files/workspace-files-paths.js";
import { fenceOpens } from "./layout/workspace-fence.js";

// Where taking files another sandbox handed this one writes them (a drop's, account-routing/inbox.routes.ts; a
// message's, s2s/messages/messages.routes.ts), or why it cannot: inside the workspace, outside its locked state, within the caller's
// fence, and onto no file already there. Copying never overwrites: a name already in the folder refuses the whole take.

export const takeTarget = async (
    services: Pick<Services, "workspace" | "areas">,
    c: Context<AppEnv>,
    dest: string,
    names: readonly string[],
    what: string,
): Promise<string | Response> => {
    const resolved = await resolveWorkspacePath(services.workspace.root, dest);
    if (resolved.kind !== "inside") {
        return c.json({ error: `${dest} is not a folder of this workspace ${what} can be taken into` }, 400);
    }
    const fence = callerEditFence(await services.areas.list(), c.get("identity"));
    if (!fenceOpens(fence, resolved.realRel)) {
        return c.json({ error: "outside your access to this workspace" }, 403);
    }
    for (const name of names) {
        // allow(silent-catch): a file that cannot be reached is one that is not there, which is what this asks.
        const there = await access(join(resolved.path, name)).then(() => true, () => false);
        if (there) {
            return c.json({ error: `${dest} already holds ${name}: take it into another folder` }, 409);
        }
    }
    return resolved.path;
};
