import { oneLine } from "@intentic/base/one-line";
import { WEBEXT_TICKET_TOOL } from "@intentic/sandbox-contract/webext-links";
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

// The calls whose sentence takes nothing from their arguments.
const FIXED = new Map([
    ["describe", "Checked what it may do here"],
    ["snapshot", "Looked over the page"],
    ["read", "Read the page"],
    ["screenshot", "Took a screenshot"],
    // Its one argument is a ticket, spent by then and meaningless to a person: what they want to know is that a secret
    // went in.
    [WEBEXT_TICKET_TOOL, "Typed a stored secret into the field in focus"],
]);

// One tool call as a sentence ("Typed 86 characters and submitted"), so the popup's list reads as what happened, not
// as the call's arguments. Nothing typed into a page is kept: `fill` is recorded by length only.
export const describeCall = (tool: string, args: Record<string, unknown>): string => {
    const fixed = FIXED.get(tool);
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
