import { z } from "zod";
import { procedure } from "../protocol/route-meta.js";

// Pages the agent showed in a chat. The pages themselves are files the workspace already serves; the one route here is
// what an MCP server's app asks of its server while a reader uses it (`tools/call` over the bridge), carried by the
// daemon since the app's frame reaches no network of its own.
export const PageAppCallSchema = z.object({
    page: z.string().min(1).describe("The stored page the app is drawn from, as a workspace path; it names the server and the tool the app belongs to."),
    name: z.string().min(1).describe("The tool the app asks to call, on its own server."),
    arguments: z.record(z.string(), z.unknown()).optional().describe("What the app passes it."),
    pressed: z
        .boolean()
        .optional()
        .describe(
            "Whether the reader had just pressed something in the app when it asked. Without a press, only a tool its server marks read-only is called: an app's own script cannot make a change nobody asked for.",
        ),
});
export const PageAppCallResultSchema = z.object({
    result: z.unknown().describe("The server's answer, as the MCP call result it sent (`content`, `structuredContent`, `isError`)."),
});

export const pagesContract = {
    appCall: procedure
        .route({
            method: "POST",
            path: "/pages/app-call",
            summary: "Call a tool for an MCP app shown in a chat",
            description:
                "Calls one tool of the connected MCP server whose app a chat is showing, on behalf of a reader using that app. Only a tool the server marks as callable by its app is answered, and only on the server the page was shown for. The answer goes back to the app, not to the agent.",
        })
        .input(PageAppCallSchema)
        .output(PageAppCallResultSchema),
};
