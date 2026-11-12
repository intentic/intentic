import { oneLine } from "@intentic/base/one-line";
import { WEBEXT_TICKET_TOOL, WEBEXT_UPLOAD_TOOL } from "@intentic/sandbox-contract/webext-links";
import { siteOf } from "./policy.js";

// Tool calls as sentences a person reads in the popup's activity list. Its own module, apart from audit.ts, because
// the popup renders older entries through it too, and audit.ts reaches the store, whose contract import would pull
// zod into the popup's bundle.

const text = (value: unknown): string => (typeof value === "string" ? value : "");

// A URL the agent passed, as a person would say it: host and path, no scheme, no query string.
const place = (url: string): string => {
    try {
        const parsed = new URL(url.includes("://") ? url : `https://${url}`);
        return oneLine(`${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`, 60);
    } catch {
        return oneLine(url, 60);
    }
};

// Where a saved file came from, as a person would say it: the ref aimed at, else the address without its query; a
// blob: or data: address is the page's own and means nothing read out.
const savedFrom = (args: CallArgs): string => {
    const url = text(args["url"]);
    if (url === "") {
        return text(args["ref"]);
    }
    return /^(?:blob|data):/iu.test(url) ? "a file the page made" : place(url);
};

// The last part of a sandbox path: the file's name, which is what the person is asked about too.
const fileName = (path: string): string => oneLine(path.split("/").pop() ?? "", 60) || "a file";

// The calls whose sentence takes nothing from their arguments.
const FIXED = new Map([
    ["describe", "Checked what it may do here"],
    ["snapshot", "Looked over the page"],
    ["read", "Read the page"],
    ["screenshot", "Took a screenshot"],
    // Its one argument is a ticket, spent by then and meaningless to a person: what they want to know is that a secret
    // went in.
    [WEBEXT_TICKET_TOOL, "Typed a stored secret into the field in focus"],
    ["scripts", "Listed the scripts in this browser"],
    ["script_try", "Tried a script it is writing on the page"],
    ["script_remove", "Removed one of its scripts"],
    ["script_logs", "Read one of its scripts' logs"],
]);

// A script's @name, read from its source the way header.ts does, for a sentence; never more of the source than that.
const scriptName = (source: string): string => {
    const name = /^\s*\/\/\s*@name\s+(.+?)\s*$/m.exec(source)?.[1];
    return name === undefined ? "a script" : `“${oneLine(name, 60)}”`;
};

type CallArgs = Parameters<typeof describeCall>[1];

// The script and file tools, whose sentence reads their arguments. Nothing of a script's source but its name ever
// reaches the list, and never upload_file's ticket, spent by then and meaningless to a person: the file's name instead,
// as they were asked about it.
const ARGUED_CALLS = new Map<string, (args: CallArgs) => string>([
    ["script_install", (args) => `Asked to install ${scriptName(text(args["source"]))}`],
    ["script_update", (args) => `Asked to update ${scriptName(text(args["source"]))}`],
    ["script_toggle", (args) => (args["on"] === true ? "Turned one of its scripts on" : "Turned one of its scripts off")],
    ["save_media", (args) => `Saved ${savedFrom(args)} into its sandbox`],
    [WEBEXT_UPLOAD_TOOL, (args) => `Attached “${fileName(text(args["path"]))}” from its sandbox to ${text(args["ref"])}`],
    ["chatgpt_image", (args) => `Asked ChatGPT for an image: “${oneLine(text(args["prompt"]), 60)}”`],
]);

// One tool call as a sentence ("Typed 86 characters and submitted"), so the popup's list reads as what happened, not
// as the call's arguments. Nothing typed into a page is kept: `fill` is recorded by length only.
export const describeCall = (tool: string, args: Record<string, unknown>): string => {
    const fixed = FIXED.get(tool) ?? ARGUED_CALLS.get(tool)?.(args);
    if (fixed !== undefined) {
        return fixed;
    }
    switch (tool) {
        case "tabs":
            return args["select"] === undefined ? "Listed your tabs" : `Switched to tab ${String(args["select"])}`;
        case "open":
            return `Opened ${place(text(args["url"]))}${args["tab"] === "new" ? " in a new tab" : ""}`;
        case "click":
            return `Clicked ${text(args["ref"])}`;
        case "fill":
            return `Typed ${text(args["text"]).length} characters into ${text(args["ref"])}${args["submit"] === true ? " and submitted" : ""}`;
        case "select_option":
            return `Chose ${oneLine(Array.isArray(args["values"]) ? args["values"].map(String).join(", ") : "", 40)} in ${text(args["ref"])}`;
        case "key":
            return `Pressed ${text(args["key"])}`;
        case "scroll":
            return `Scrolled ${text(args["direction"]) || "down"}`;
        case "wait_for":
            return args["text"] === undefined
                ? `Waited for “${oneLine(text(args["textGone"]), 40)}” to go`
                : `Waited for “${oneLine(text(args["text"]), 40)}”`;
        case "ask_access":
            return `Asked for ${siteOf(text(args["origin"]))}`;
        case "connect_site":
            return `Sent this site's sign-in to ${text(args["account"])}`;
        case "lend_site":
            return `Borrowed ${text(args["account"])}'s sign-in`;
        default:
            return oneLine(`${tool} ${JSON.stringify(args)}`, 120);
    }
};
