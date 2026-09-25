import { siteOf } from "./policy.js";

// Tool calls as sentences a person reads in the popup's activity list. Its own module, apart from audit.ts, because
// the popup renders older entries through it too, and audit.ts reaches the store, whose contract import would pull
// zod into the popup's bundle.

const text = (value: unknown): string => (typeof value === "string" ? value : "");

const clip = (value: string, max: number): string => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

// A URL the agent passed, as a person would say it: host and path, no scheme, no query string.
const place = (url: string): string => {
    try {
        const parsed = new URL(url.includes("://") ? url : `https://${url}`);
        return clip(`${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`, 60);
    } catch {
        return clip(url, 60);
    }
};

// One tool call as a sentence ("Typed 86 characters and submitted"), so the popup's list reads as what happened, not
// as the call's arguments. Nothing typed into a page is kept: `fill` is recorded by length only.
export const describeCall = (tool: string, args: Record<string, unknown>): string => {
    switch (tool) {
        case "describe":
            return "Checked what it may do here";
        case "tabs":
            return args["select"] === undefined ? "Listed your tabs" : `Switched to tab ${String(args["select"])}`;
        case "open":
            return `Opened ${place(text(args["url"]))}${args["tab"] === "new" ? " in a new tab" : ""}`;
        case "snapshot":
            return "Looked over the page";
        case "read":
            return "Read the page";
        case "click":
            return `Clicked ${text(args["ref"])}`;
        case "fill":
            return `Typed ${text(args["text"]).length} characters into ${text(args["ref"])}${args["submit"] === true ? " and submitted" : ""}`;
        case "select_option":
            return `Chose ${clip(Array.isArray(args["values"]) ? args["values"].map(String).join(", ") : "", 40)} in ${text(args["ref"])}`;
        case "key":
            return `Pressed ${text(args["key"])}`;
        case "scroll":
            return `Scrolled ${text(args["direction"]) || "down"}`;
        case "wait_for":
            return args["text"] === undefined
                ? `Waited for “${clip(text(args["textGone"]), 40)}” to go`
                : `Waited for “${clip(text(args["text"]), 40)}”`;
        case "screenshot":
            return "Took a screenshot";
        case "ask_access":
            return `Asked for ${siteOf(text(args["origin"]))}`;
        case "connect_site":
            return `Sent this site's sign-in to ${text(args["account"])}`;
        case "lend_site":
            return `Borrowed ${text(args["account"])}'s sign-in`;
        default:
            return clip(`${tool} ${JSON.stringify(args)}`, 120);
    }
};
