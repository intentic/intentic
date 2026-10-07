import { readFile, stat } from "node:fs/promises";
import { undefinedIfMissing } from "@intentic/base/errors";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
    type AgentEvent,
    type Page,
    PAGE_LAYOUT_GUIDE,
    PAGE_MAX_HEIGHT,
    PAGE_MIN_HEIGHT,
    PAGE_THEME_GUIDE,
    PAGE_TITLE_MAX,
    PAGE_VALUE_MAX,
} from "@intentic/sandbox-contract";
import { toolAnnotations } from "@intentic/sandbox-contract/peer-mcp-server";
import { z } from "zod";
import { sdk } from "../../engines/claude-sdk.js";
import type { ParkedCards } from "../../conversations/actor/parked-cards.js";
import { inWorktree, type WorktreeMapping } from "../../workload/worktree-paths.js";
import { carryPage, type CarriedPage, PAGE_CDN_HOSTS } from "./page-assets.js";
import { checkPage, type PageCheck } from "./page-check.js";
import { ASK_PAGE_TOOL, SHOW_PAGE_TOOL } from "./page-names.js";
import { PageNotFoundError, publishPage } from "./page-store.js";

// The agent's way to answer with a page rather than prose: `show_page` draws one inline in the chat, `ask_page` draws one
// as a card and waits for what the page sends back. Both read the page (written inline, or a file the agent built),
// carry everything it names inside it, optionally lay it out headless first so the agent sees what the reader will, and
// file it under the conversation's records (page-store.ts). Mounted on the `ui` server beside `ask`, where the turn's
// event stream and its parked cards already are.

// A page longer than this is a document, not a reply: it should be a file the agent shows by path.
const MAX_INLINE_CHARS = 1_000_000;

const CDN_LIST = [...PAGE_CDN_HOSTS].join(", ");

const PAGE_RULES =
    "Write one self-contained HTML document with inline <style> and <script> as `html`, or pass `path` to show an HTML file " +
    "you built in the workspace. Pictures, stylesheets and scripts it names on disk (relative to the file, or absolute paths, " +
    `screenshots included) and libraries it names on ${CDN_LIST} are carried into the page when it is shown; the page itself ` +
    "reaches no network, so nothing else loads. Its scripts run, sealed off from the chat. " +
    `${PAGE_LAYOUT_GUIDE} ${PAGE_THEME_GUIDE}`;

const CHECK_RULE =
    "Set `check: true` the first time you show anything with scripts or a chart: the page is laid out first in a headless " +
    "browser, inside a frame like the chat's at the chat's width, and you get back a picture of it, its height and its " +
    "console. A page whose scripts throw is not shown, so read the errors, fix, and call again. What its scripts throw later " +
    "in the reader's own chat is told to you while this turn runs.";

const SHOW_DESCRIPTION =
    "Show the user a page right in the chat, drawn inline where your reply continues: a chart, a table, a diagram, a " +
    "comparison of options, a mock-up, an image collage, whenever it would say more than prose. Call it before the words " +
    "that go with it. The user already sees the page, so do not announce, describe or restate it: say only what it does not. " +
    `${PAGE_RULES} ${CHECK_RULE} To change a page you showed, call again with \`replaces\` set to its id: the earlier one folds ` +
    "away, so iterating leaves one page behind. Inside the page, `window.intentic.send(text)` sends the chat a message as the " +
    'user, after their own click: use it for buttons like "Build this one" on a set of mock-ups. Charts are a claim: build ' +
    "them from real data you read, never from numbers you guessed, and say where the numbers came from. A mock-up may " +
    "hold sample content, labelled as sample on the page, so it never reads as measured.";

const ASK_DESCRIPTION =
    "Ask the user something a page answers better than a list of options: pick one of several mock-ups, tune values with " +
    "sliders, fill a short form, select or rank rows of a table, mark up a layout. The page is drawn as a card and this call " +
    "waits; the page calls `window.intentic.submit(value)` with any JSON when the user is done (from a button they press), and " +
    "that value is what you get back. Make the submit control obvious and the value self-describing (names, not indexes). " +
    "The page is written exactly as for show_page (its rules, theme variables and `check` apply here too), and a button press " +
    "is the only thing that sends. The user may dismiss the card instead, and then you get no value: carry on with sensible " +
    "defaults and say what you assumed. For plain multiple choice, AskUserQuestion is cheaper.";

const pageShape = {
    title: z.string().min(1).max(PAGE_TITLE_MAX).describe("A short name for the page."),
    html: z.string().min(1).max(MAX_INLINE_CHARS).optional().describe("The whole page: one self-contained HTML document."),
    path: z
        .string()
        .min(1)
        .optional()
        .describe("Instead of `html`: an HTML file in the workspace to show, as it is now (later edits to the file do not change what was shown)."),
    height: z
        .number()
        .int()
        .min(PAGE_MIN_HEIGHT)
        .max(PAGE_MAX_HEIGHT)
        .optional()
        .describe("The tallest the frame may grow, in pixels; past it the page scrolls inside the frame. Leave it out to fit the whole page."),
    check: z.boolean().optional().describe("Lay the page out in a headless browser first and get back a picture of it and its console."),
};

type PageArgs = {
    readonly title: string;
    readonly html?: string | undefined;
    readonly path?: string | undefined;
    readonly height?: number | undefined;
    readonly check?: boolean | undefined;
};

export interface PageToolsDeps {
    // Where pages are filed (the daemon's own view of the workspace).
    readonly workspaceRoot: string;
    // The turn's working folder as the agent sees it, which a relative `path` is read from.
    readonly cwd: string;
    // How the agent's paths map to the daemon's, for an isolated turn.
    readonly placement?: WorktreeMapping | undefined;
    readonly conversationId?: string | undefined;
    readonly push: (event: AgentEvent) => void;
    readonly cards: Pick<ParkedCards, "create">;
    readonly signal: AbortSignal;
    // What follows an answer the agent then acts on (the ask tool's rebase), so both cards keep one rule.
    readonly answered?: (answered: boolean) => Promise<void>;
}

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
const text = (value: string): Content => ({ type: "text", text: value });

// The page's markup and where its relative references are read from, as the agent named it.
const sourceOf = async (args: PageArgs, deps: PageToolsDeps): Promise<{ html: string; baseDir: string; source?: string } | { refused: string }> => {
    if ((args.html === undefined) === (args.path === undefined)) {
        return { refused: "Give the page either as `html` or as a `path` to an HTML file, exactly one of the two." };
    }
    const agentRoot = deps.placement?.root ?? deps.workspaceRoot;
    if (args.html !== undefined) {
        return { html: args.html, baseDir: inWorktree(deps.cwd, deps.placement) };
    }
    const agentPath = isAbsolute(args.path!) ? args.path! : resolve(deps.cwd, args.path!);
    const file = inWorktree(agentPath, deps.placement);
    const info = await stat(file).catch(undefinedIfMissing);
    if (info === undefined || !info.isFile()) {
        return { refused: `There is no file at ${args.path}.` };
    }
    if (info.size > MAX_INLINE_CHARS * 2) {
        return { refused: `${args.path} is ${Math.round(info.size / 1024)} KB, too large to show as a page.` };
    }
    const rel = relative(agentRoot, agentPath);
    return {
        html: await readFile(file, "utf8"),
        baseDir: dirname(file),
        ...(rel.startsWith("..") || isAbsolute(rel) ? {} : { source: rel.split("\\").join("/") }),
    };
};

// What carrying left out, said so the agent fixes it now rather than the reader finding a hole.
const carriedNotes = (carried: CarriedPage): string[] => [
    ...(carried.fetched.length === 0 ? [] : [`Carried in from the CDN: ${carried.fetched.join(", ")}.`]),
    ...(carried.missing.length === 0
        ? []
        : [`Not found or not readable, so missing from the page: ${carried.missing.join(", ")}. Use paths to files that exist in the workspace.`]),
    ...(carried.leftOut.length === 0
        ? []
        : [
              `Left out, and will not load in the chat: ${carried.leftOut.join(", ")}. Only ${CDN_LIST} are fetched; inline anything else, or save it in the workspace and name the file.`,
          ]),
];

const checkNotes = (check: PageCheck): string[] => [
    `Laid out at ${check.width}px wide: ${check.contentHeight}px tall${check.contentHeight > check.capturedHeight ? ` (the picture shows the top ${check.capturedHeight}px)` : ""}.`,
    ...(check.contentHeight < 24 ? ["The page laid out almost empty: check that its content is in the body and that its scripts ran."] : []),
    ...(check.followsFrame
        ? [
              "Its height follows its frame's rather than its content's (100vh, or height:100% on html or body), so the chat cannot fit the frame to it: size it by its content.",
          ]
        : []),
    ...(check.errors.length === 0 ? [] : [`Uncaught errors:\n${check.errors.map((error) => `- ${error}`).join("\n")}`]),
    ...(check.messages.length === 0 ? [] : [`Console:\n${check.messages.map((message) => `- [${message.level}] ${message.text}`).join("\n")}`]),
];

// Read, carried, checked when asked, filed: the page, and what to tell the agent about it; or why it was not shown.
const preparePage = async (
    args: PageArgs,
    deps: PageToolsDeps,
    replaces: string | undefined,
): Promise<{ readonly page: Page; readonly notes: string[]; readonly picture?: Content } | { readonly refused: Content[] }> => {
    const source = await sourceOf(args, deps);
    if ("refused" in source) {
        return { refused: [text(source.refused)] };
    }
    const roots = [deps.workspaceRoot, ...(deps.placement === undefined ? [] : [deps.placement.worktree]), "/tmp"];
    const carried = await carryPage(source.html, { baseDir: source.baseDir, roots });
    const notes = carriedNotes(carried);
    let measured: number | undefined;
    let picture: Content | undefined;
    if (args.check === true) {
        const checked = await checkPage(carried.html, { cap: args.height });
        if (checked.ok) {
            measured = checked.check.contentHeight;
            picture = { type: "image", data: checked.check.png, mimeType: "image/png" };
            notes.push(...checkNotes(checked.check));
            if (checked.check.errors.length > 0) {
                return {
                    refused: [
                        text(["The page was NOT shown: its scripts threw. Fix them and call again.", ...notes].join("\n\n")),
                        picture,
                    ],
                };
            }
        } else {
            notes.push(`Not checked: ${checked.reason}.`);
        }
    }
    try {
        const page = await publishPage({
            workspaceRoot: deps.workspaceRoot,
            conversationId: deps.conversationId,
            title: args.title,
            html: carried.html,
            height: args.height,
            measured,
            source: source.source,
            replaces,
        });
        return { page, notes, ...(picture === undefined ? {} : { picture }) };
    } catch (error) {
        if (error instanceof PageNotFoundError) {
            return { refused: [text(error.message)] };
        }
        throw error;
    }
};

const showPageTool = (deps: PageToolsDeps) =>
    sdk().tool(
        SHOW_PAGE_TOOL,
        SHOW_DESCRIPTION,
        {
            ...pageShape,
            replaces: z
                .string()
                .min(1)
                .optional()
                .describe("The id of a page you already showed in this conversation, to draw this one in its place."),
        },
        async (args) => {
            const prepared = await preparePage(args, deps, args.replaces);
            if ("refused" in prepared) {
                return { content: prepared.refused, isError: true };
            }
            const { page, notes, picture } = prepared;
            deps.push({ kind: "page", page });
            const said = [
                `Shown to the user inline as "${page.title}" (page id "${page.id}"${page.revision === undefined ? "" : `, redraw ${page.revision}`}). ` +
                    "They see it now: do not describe or restate it, say only what it does not. To change it, call show_page again with " +
                    `replaces: "${page.id}".`,
                ...notes,
            ];
            return { content: [text(said.join("\n\n")), ...(picture === undefined ? [] : [picture])] };
        },
        { annotations: toolAnnotations("read") },
    );

const askPageTool = (deps: PageToolsDeps) =>
    sdk().tool(
        ASK_PAGE_TOOL,
        ASK_DESCRIPTION,
        pageShape,
        async (args) => {
            const prepared = await preparePage(args, deps, undefined);
            if ("refused" in prepared) {
                return { content: prepared.refused, isError: true };
            }
            const { page, notes, picture } = prepared;
            // Named with its conversation, like the question card, so a dismissal reaches it.
            const { id, wait } = deps.cards.create("page_ask", { kind: "page_ask", requestId: "", cancelled: true }, deps.conversationId);
            deps.push({ kind: "page_ask", requestId: id, page });
            const { reply, resolved } = await wait(deps.signal);
            // The answer belongs in the frame log too: a replayed transcript freezes the card with it.
            deps.push(resolved);
            const answered = reply.cancelled !== true && reply.value !== undefined;
            await deps.answered?.(answered);
            const value = reply.value === undefined ? undefined : reply.value.slice(0, PAGE_VALUE_MAX);
            const said = answered
                ? `The user answered on the page "${page.title}":\n${value}`
                : `The user dismissed the page "${page.title}" without answering. Carry on with sensible defaults, and say what you assumed.`;
            return { content: [text([said, ...notes].join("\n\n")), ...(picture === undefined ? [] : [picture])] };
        },
        // The answer changes the conversation's tree (deps.answered), so the call must not run beside reads.
        { annotations: toolAnnotations("write") },
    );

// The two tools, for the `ui` server's list.
export const pageTools = (deps: PageToolsDeps) => [showPageTool(deps), askPageTool(deps)];
