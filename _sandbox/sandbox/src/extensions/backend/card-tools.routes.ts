import { envSuffix } from "@intentic/sandbox-contract/policy/capability-env";
import type { Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../../app-env.js";
import { maskDeep, maskTargets } from "../../agent/tools/agent-redaction.js";
import type { MountTarget, RpcMessage } from "../../agent/tools/turn-mounts.js";
import type { MountEndpoints } from "../../agent/tools/turn-mounts.routes.js";
import type { Services } from "../../composition.js";
import { readBoundedJson } from "../../http/bounded-body.js";
import { opt } from "../../opt.js";
import { defineRawRoutes } from "../../http/raw-route-server.js";
import { turnClaimOf, unprovenTurnWords } from "../../seams/workload-stamp.js";
import { createExtensionToolsEndpoint } from "./extension-mcp.js";

// A CARD'S TOOLS FROM THE TURN'S OWN SHELL (2026-11-26), `POST /tools/<card>`: the server the turn's MCP door already
// mounted for a card (`contributes.tools.perCard`, answered by the extension's backend from `api.tools.serve`), reached by
// that card's own command-line tool instead of the model. It is how `imap` and `m365` keep their commands while the
// card's credential stays in the backend: the CLI sends what it read from the workspace, the backend uses the
// credential, and the owner's rules are decided at the daemon's outward-action door (capabilities/broker/outward-door.ts).
// The rule the devices door holds to (hosts/device-door.routes.ts): the conversation a shell names is believed only with
// its turn's proof, and must have a live turn holding that card's tools, so a role or a person's reach that withholds the
// card withholds this too, and nothing outlives the turn. The conversation goes to the backend from here, never from
// what the request says.

// A send carries its attachments' bytes, base64: far above any mail a provider takes, and a bound on what one request
// may make the daemon hold.
const MAX_REQUEST_BYTES = 64 * 1024 * 1024;

type ToolsTarget = Extract<MountTarget, { readonly kind: "tools" }>;

// One JSON-RPC request: an id to answer and a method; the backend host refuses a method it does not serve.
const RequestSchema = z.object({
    jsonrpc: z.literal("2.0").optional(),
    id: z.union([z.string(), z.number()]),
    method: z.string().min(1),
    params: z.record(z.string(), z.unknown()).optional(),
});

// The card's tools under `name` among what the conversation's live turns hold: by the card's id, or by the id its
// environment suffix spells, which is all a CLI knows of a card (`IMAP_HOST_OFFICE` for `office`).
export const cardToolsIn = (mounted: ReadonlyMap<string, MountTarget>, name: string): ToolsTarget | undefined => {
    const exact = mounted.get(name);
    const found =
        exact?.kind === "tools" && exact.card !== undefined
            ? exact
            : [...mounted.values()].find((target) => target.kind === "tools" && target.card !== undefined && envSuffix(target.card) === envSuffix(name));
    return found?.kind === "tools" ? found : undefined;
};

export type CardToolsDeps = Pick<Services, "turnMounts" | "secretRegistry">;

export const createCardToolsRoute =
    (deps: CardToolsDeps, tools: MountEndpoints["tools"]) =>
    async (c: Context<AppEnv>): Promise<Response> => {
        const name = c.req.param("mount") ?? "";
        const claim = turnClaimOf((header) => c.req.header(header));
        if (claim.kind === "none") {
            return c.json({ error: "no conversation named: a card's tools are reached from an agent's shell, whose turn mounted them" }, 400);
        }
        if (claim.kind === "unproven") {
            return c.json({ error: unprovenTurnWords(claim.named) }, 403);
        }
        const target = cardToolsIn(deps.turnMounts.mountedIn(claim.conversationId), name);
        if (target === undefined) {
            return c.json(
                { error: `this conversation's turn has no tools for a card called "${name}": the card is not connected, or this turn was not given it` },
                403,
            );
        }
        const body = await readBoundedJson(c.req.raw, MAX_REQUEST_BYTES);
        if (body.kind === "tooLarge") {
            return c.json({ error: `a request to a card's tools carries ${MAX_REQUEST_BYTES / 1024 / 1024} MiB at most` }, 413);
        }
        const message = RequestSchema.safeParse(body.kind === "ok" ? body.value : undefined);
        if (!message.success) {
            return c.json({ error: "one JSON-RPC request with an id (tools/call or tools/list)" }, 400);
        }
        const { id, method, params } = message.data;
        const request: RpcMessage = { jsonrpc: "2.0", id, method, ...opt("params", params) };
        const turn = deps.turnMounts.holdingIn(claim.conversationId);
        const answered = await tools(target, request, { name, conversationId: claim.conversationId, signal: c.req.raw.signal, ...opt("turn", turn) });
        if (answered === undefined) {
            return c.body(null, 202);
        }
        // What the MCP door masks for the model, masked for the shell too: a stored secret's value never comes back.
        const masked = answered.result === undefined ? answered : { ...answered, result: maskDeep(answered.result, maskTargets(await deps.secretRegistry())) };
        return c.json(masked);
    };

export const cardToolsRawRoutes = defineRawRoutes((services: Services) => ({
    "POST /tools/{mount}": createCardToolsRoute(services, createExtensionToolsEndpoint(services)),
}));
