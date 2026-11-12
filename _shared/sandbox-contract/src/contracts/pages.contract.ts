import { z } from "zod";
import { procedure } from "../protocol/route-meta.js";
import { PAGE_ERROR_CHARS, PAGE_ERRORS_MAX } from "../text/pages.js";

// Pages the agent showed in a chat. The pages themselves are files the workspace already serves; the routes here are
// what an MCP server's app asks of its server while a reader uses it (`tools/call` over the bridge), carried by the
// daemon since the app's frame reaches no network of its own, what a page's own scripts threw as it drew, carried
// back to the agent that showed it, and the ticket a page's video and audio stream with.
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

export const PageErrorsSchema = z.object({
    page: z.string().min(1).describe("The stored page that threw, as a workspace path."),
    errors: z
        .array(z.string().min(1).max(PAGE_ERROR_CHARS))
        .min(1)
        .max(PAGE_ERRORS_MAX)
        .describe("Its uncaught errors as its frame caught them, each with the first line of its stack."),
});
export const PageErrorsResultSchema = z.object({
    told: z
        .boolean()
        .describe(
            "Whether the agent heard: true when the turn that showed the page was still running and took the errors. False when that turn is over, the page is an MCP server's app, or these errors were already told.",
        ),
});

export const PageMediaTicketQuerySchema = z.object({
    page: z.string().min(1).describe("The stored page whose video and audio the ticket covers, as a workspace path."),
});
export const PageMediaTicketSchema = z.object({
    ticket: z
        .string()
        .describe(
            "Put it in the page's media addresses, GET /pages/media/{ticket}/{index}. It buys exactly the files the page named when it was shown, each only while it is unchanged.",
        ),
    expiresAt: z.number().describe("When it stops working, in milliseconds, so a player can tell a dead ticket from a dead file."),
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
    reportErrors: procedure
        .route({
            method: "POST",
            path: "/pages/errors",
            summary: "Tell the agent that a page it showed threw",
            description:
                "Hands the uncaught errors a page's own scripts threw in a reader's chat to the agent that showed it, as the sandbox's notice inside that agent's running turn, so it fixes the page and draws it again. Only the turn that showed the page hears it, once per drawing, and never for an MCP server's app; afterwards nothing is said, and the reader can ask from the page's own line.",
        })
        .input(PageErrorsSchema)
        .output(PageErrorsResultSchema),
    // Mints the ticket GET /pages/media/{ticket}/{index} (a plain byte-range route a <video> talks to) requires.
    mediaTicket: procedure
        .route({
            method: "POST",
            path: "/pages/media-ticket",
            summary: "Get a pass for playing a shown page's video and audio",
            description:
                "Mints the short-lived ticket a shown page's video and audio elements stream with, since a player cannot carry an ordinary header. It covers only the files that page named when the agent showed it, and each only while it is still the file that was shown: one overwritten or removed since is refused rather than played in its place.",
        })
        // Playing a page's media is reading the page, and the ticket is narrower than the bearer.
        .meta({ floor: "viewer", guest: true })
        .input(PageMediaTicketQuerySchema)
        .output(PageMediaTicketSchema),
};
