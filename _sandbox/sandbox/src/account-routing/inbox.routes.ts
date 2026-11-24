import { access } from "node:fs/promises";
import { join } from "node:path";
import { DropTakeSchema, type ReceivedDrop } from "@intentic/sandbox-contract/schemas/account-routes";
import { tierAtLeast } from "@intentic/sandbox-contract/schemas/shared";
import type { Context } from "hono";
import type { AppEnv } from "../app-env.js";
import { callerEditFence } from "../areas/area-scope.js";
import type { Services } from "../composition.js";
import { defineRawRoutes } from "../http/raw-route-server.js";
import { provesOwner } from "../seams/workload-stamp.js";
import { fenceOpens } from "../workspace/layout/workspace-fence.js";
import { resolveWorkspacePath } from "../workspace/files/workspace-files-paths.js";
import { fileDropInbox } from "./drop-inbox.js";
import { peopleFor } from "./who-asks.js";

/* THE INBOX, READ (2026-11-24, docs/architecture/account-routing.md): what other sandboxes dropped here as one of this
 * sandbox's people (drop.routes.ts), for the `inbox` command and the editor's Received list. Each drop is shown to the
 * person it names and to maintainers:
 * - a person signed in: their own drops, or every drop for a maintainer;
 * - a turn proving which it is: drops naming one of the people it acts for (the owner, when it names none);
 * - a shell naming no conversation at all: none. Reading it as a maintainer's terminal was the first cut; an agent that
 *   unsets its own variables makes the same call, and would read every person's drops (2026-11-24). A maintainer reads
 *   them all in the app, signed in.
 * Taking copies the files into the workspace; deleting lets the drop go. */

type DropReader = (drop: ReceivedDrop) => boolean;

const EVERY: DropReader = () => true;
const NONE: DropReader = () => false;

const naming =
    (people: readonly string[]): DropReader =>
    (drop) =>
        people.some((person) => person.toLowerCase() === drop.person);

/** Which drops this caller is shown. */
const dropReaderOf = async (services: Pick<Services, "agents" | "ownerEmail">, c: Context<AppEnv>): Promise<DropReader> => {
    const identity = c.get("identity");
    if (identity !== undefined) {
        return tierAtLeast(identity.tier, "maintainer") ? EVERY : naming([identity.email]);
    }
    const named = c.req.header("x-intentic-conversation");
    if (named === undefined || named === "" || !provesOwner(named, c.req.header("x-intentic-turn-proof"))) {
        return NONE;
    }
    const people = peopleFor(services, named);
    const owner = people.length === 0 ? await services.ownerEmail() : undefined;
    return naming(owner === undefined ? people : [owner]);
};

const NOT_HERE = (id: string): string => `No drop ${id} waits in this inbox for you: \`inbox\` lists what does.`;

// Where taking a drop writes, or why it cannot: inside the workspace, outside its locked state, within the caller's fence,
// and onto no file already there.
const takeTarget = async (
    services: Pick<Services, "workspace" | "areas">,
    c: Context<AppEnv>,
    dest: string,
    drop: ReceivedDrop,
): Promise<string | Response> => {
    const resolved = await resolveWorkspacePath(services.workspace.root, dest);
    if (resolved.kind !== "inside") {
        return c.json({ error: `${dest} is not a folder of this workspace a drop can be taken into` }, 400);
    }
    const fence = callerEditFence(await services.areas.list(), c.get("identity"));
    if (!fenceOpens(fence, resolved.realRel)) {
        return c.json({ error: "outside your access to this workspace" }, 403);
    }
    for (const file of drop.files) {
        // allow(silent-catch): a file that cannot be reached is one that is not there, which is what this asks.
        const there = await access(join(resolved.path, file.name)).then(() => true, () => false);
        if (there) {
            return c.json({ error: `${dest} already holds ${file.name}: take it into another folder` }, 409);
        }
    }
    return resolved.path;
};

export const inboxRawRoutes = defineRawRoutes((services: Services) => {
    const inbox = fileDropInbox(services.config.historyRoot);
    // The drop the route names, when this caller is shown it; the refusal otherwise, the same as for none at all.
    const shown = async (c: Context<AppEnv>): Promise<ReceivedDrop | Response> => {
        const id = c.req.param("id") ?? "";
        const drop = await inbox.get(id);
        return drop !== undefined && (await dropReaderOf(services, c))(drop) ? drop : c.json({ error: NOT_HERE(id) }, 404);
    };
    return {
        "GET /account/inbox": async (c: Context<AppEnv>) => {
            const reads = await dropReaderOf(services, c);
            return c.json({ drops: (await inbox.list()).filter(reads) });
        },
        "GET /account/inbox/{id}": async (c: Context<AppEnv>) => {
            const drop = await shown(c);
            return drop instanceof Response ? drop : c.json(drop);
        },
        "GET /account/inbox/{id}/files": async (c: Context<AppEnv>) => {
            const drop = await shown(c);
            if (drop instanceof Response) {
                return drop;
            }
            const files = (await inbox.files(drop.id)) ?? [];
            return c.json({ files: files.map((file) => ({ name: file.name, data: file.bytes.toString("base64") })) });
        },
        "POST /account/inbox/{id}/take": async (c: Context<AppEnv>) => {
            const drop = await shown(c);
            if (drop instanceof Response) {
                return drop;
            }
            // allow(silent-catch): a body that is not JSON reads as none, which the schema then refuses by name.
            const parsed = DropTakeSchema.safeParse(await c.req.json().catch(() => undefined));
            if (!parsed.success) {
                return c.json({ error: "name the folder to take it into: {dest}" }, 400);
            }
            const target = await takeTarget(services, c, parsed.data.dest, drop);
            if (target instanceof Response) {
                return target;
            }
            const files = (await inbox.files(drop.id)) ?? [];
            for (const file of files) {
                await services.files.write(join(target, file.name), file.bytes);
            }
            return c.json({ dest: parsed.data.dest, files: files.map((file) => file.name) });
        },
        "DELETE /account/inbox/{id}": async (c: Context<AppEnv>) => {
            const drop = await shown(c);
            if (drop instanceof Response) {
                return drop;
            }
            await inbox.remove(drop.id);
            return c.json({ ok: true as const });
        },
    };
});
