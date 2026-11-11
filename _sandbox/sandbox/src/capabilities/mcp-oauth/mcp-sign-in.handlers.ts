import { capabilitiesContract } from "@intentic/sandbox-contract/contracts/capabilities.contract";
import type { McpSignInStart, McpSignInWait } from "@intentic/sandbox-contract/schemas/mcp-sign-in";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../../app-env.js";
import { opt } from "../../opt.js";
import type { SecretStash } from "../credentials/secret-stash.js";
import { encodeMcpSession } from "./mcp-session.js";
import { McpSignInRefusal, type McpSignIns, type McpSignInInput } from "./mcp-sign-ins.js";

// The capability routes' MCP sign-in procedures, kept beside the sign-in they drive and merged into the `capabilities`
// group by capabilities.routes.ts. A finished sign-in's session goes into that group's own stash, the one a generated
// SSH key waits in, so the browser holds only a token for it and the add that saves the connection installs it once.

const startMcpSignIn = async (signIns: Pick<McpSignIns, "begin">, input: McpSignInInput): Promise<McpSignInStart> => {
    try {
        return await signIns.begin(input);
    } catch (error) {
        // The server's or its authorization server's answer, in the form's words: the form's to act on, so a 400.
        if (error instanceof McpSignInRefusal) {
            throw new ORPCError("BAD_REQUEST", { message: error.message });
        }
        throw error;
    }
};

export const waitMcpSignIn = async (
    signIns: Pick<McpSignIns, "wait">,
    stash: Pick<SecretStash, "put">,
    flow: string,
    signal?: AbortSignal,
): Promise<McpSignInWait> => {
    const outcome = await signIns.wait(flow, signal);
    if (outcome.state !== "done") {
        return outcome;
    }
    const { session } = outcome;
    const token = stash.put({ kind: "mcp", field: "token", value: encodeMcpSession(session) });
    return {
        state: "done",
        token,
        server: session.server,
        ...opt("account", session.account),
        ...opt("scope", session.scope),
    };
};

export const createMcpSignInRoutes = (signIns: Pick<McpSignIns, "check" | "begin" | "wait">, stash: Pick<SecretStash, "put">) => {
    const i = implement(capabilitiesContract).$context<OrpcContext>();
    return {
        mcpAuth: i.mcpAuth.handler(({ input }) => signIns.check(input.url)),
        mcpSignIn: i.mcpSignIn.handler(({ input }) => startMcpSignIn(signIns, input)),
        mcpSignInWait: i.mcpSignInWait.handler(({ input, signal }) => waitMcpSignIn(signIns, stash, input.flow, signal)),
    };
};
