import { DiagnosticsAskSchema } from "@intentic/sandbox-contract/schemas/diagnostics";
import type { Context } from "hono";
import type { AppEnv } from "../app-env.js";
import type { Services } from "../composition.js";
import { soleLiveConversation } from "../conversations/actor/conversation-holdings.js";
import { turnStandingOf } from "../conversations/actor/turn-standing.js";
import { defineRawRoutes } from "../http/raw-route-server.js";
import { relayDiagnostics } from "../links/link-records-relay.js";
import { provesOwner } from "../seams/workload-stamp.js";
import { runDiagnosticsQuery } from "./diagnostics-queries.js";

// THE `diagnostics` COMMAND'S DOOR: one read-only query of this daemon's records (diagnostics-queries.ts), the same
// answer the `diagnostics` tools give a Claude turn, for every runtime with a shell and for a person in a terminal. With
// `on`, the same query of a linked sandbox's records, relayed through its link (links/link-records-relay.ts).

// The turn a shell call is for, when it proves which: the tools are withheld from a turn whose persona keeps it off the
// sandbox's files (harness-servers.ts), and the command is held to the same.
const provenTurn = (services: Pick<Services, "conversations">, c: Context<AppEnv>): string | undefined => {
    const named = c.req.header("x-intentic-conversation");
    return named !== undefined && named !== "" && provesOwner(named, c.req.header("x-intentic-turn-proof")) ? named : soleLiveConversation(services.conversations);
};

export const diagnosticsRawRoutes = defineRawRoutes((services: Services) => ({
    "POST /diagnostics": async (c: Context<AppEnv>): Promise<Response> => {
        // allow(silent-catch): a body that is not JSON reads as none, which the schema then refuses by name.
        const parsed = DiagnosticsAskSchema.safeParse(await c.req.json().catch(() => undefined));
        if (!parsed.success) {
            const issue = parsed.error.issues[0];
            const where = issue === undefined || issue.path.length === 0 ? "" : `${issue.path.join(".")}: `;
            return c.json({ ok: false, message: `${where}${issue?.message ?? "not a diagnostics query"}` }, 400);
        }
        const { on, ...query } = parsed.data;
        if (on !== undefined) {
            return relayDiagnostics(services, c, on, query);
        }
        const turn = c.get("identity") === undefined ? provenTurn(services, c) : undefined;
        if (turn !== undefined && turnStandingOf(services.conversations, turn)?.powers.files === "none") {
            return c.json({ ok: false, message: "This turn's persona keeps it off the sandbox's files, and its records with them." }, 403);
        }
        return c.json({ text: await runDiagnosticsQuery({ historyRoot: services.config.historyRoot, usage: services.usage }, query) });
    },
}));
