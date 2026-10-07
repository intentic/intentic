import type { AgentEvent } from "@intentic/sandbox-contract";
import { PageDrafts, PartialJsonStrings } from "./page-draft.js";

// Feeds text one piece at a time, the way input_json_delta arrives: at any split, however awkward.
const fedInPieces = (text: string, size: number): PartialJsonStrings => {
    const json = new PartialJsonStrings(new Set(["html", "title"]));
    for (let at = 0; at < text.length; at += size) {
        json.feed(text.slice(at, at + size));
    }
    return json;
};

describe("PartialJsonStrings", () => {
    const args = { title: 'Q3 "final"', height: 400, nested: { html: "not this one", list: [1, "}"] }, html: '<p class="a">é\n\t\\</p>☃' };
    const text = JSON.stringify(args);

    it("reads a whole object's strings, escapes and all, at every split", () => {
        for (const size of [1, 2, 3, 7, 64]) {
            const json = fedInPieces(text, size);
            expect(json.value("html")).toBe(args.html);
            expect(json.value("title")).toBe(args.title);
            expect(json.closed("html")).toBe(true);
        }
    });

    it("holds a string so far, and a half-arrived escape back until it is whole", () => {
        const json = new PartialJsonStrings(new Set(["html"]));
        json.feed(`{"html":"<b>a\\u26`);
        expect(json.value("html")).toBe("<b>a");
        expect(json.closed("html")).toBe(false);
        json.feed(`03</b`);
        expect(json.value("html")).toBe("<b>a☃</b");
    });

    it("never reads a key nested inside another value", () => {
        const json = fedInPieces(`{"meta":{"html":"inner"},"html":"outer"}`, 3);
        expect(json.value("html")).toBe("outer");
    });
});

describe("PageDrafts", () => {
    const isPageTool = (name: string): boolean => name === "mcp__ui__show_page";
    const drain = (frames: Generator<AgentEvent>): AgentEvent[] => [...frames];

    it("says each new stretch once, at most every so often, and the rest when the block stops", () => {
        let now = 0;
        const drafts = new PageDrafts(isPageTool, () => now);
        drafts.start(1, { type: "tool_use", id: "call-1", name: "mcp__ui__show_page" });
        const first = drain(drafts.delta(1, `{"title":"Chart","html":"<div>`));
        expect(first).toEqual([{ kind: "page_draft", callId: "call-1", at: 0, text: "<div>", title: "Chart" }]);
        now = 50;
        // Too soon: held for the next frame.
        expect(drain(drafts.delta(1, `hello`))).toEqual([]);
        now = 400;
        expect(drain(drafts.delta(1, ` there`))).toEqual([{ kind: "page_draft", callId: "call-1", at: 5, text: "hello there" }]);
        expect(drain(drafts.delta(1, `</div>"}`))).toEqual([]);
        expect(drain(drafts.stop(1))).toEqual([{ kind: "page_draft", callId: "call-1", at: 16, text: "</div>" }]);
        // Its result lets the draft go, once.
        expect(drain(drafts.settled("call-1"))).toEqual([{ kind: "page_draft", callId: "call-1", at: 0, text: "", done: true }]);
        expect(drain(drafts.settled("call-1"))).toEqual([]);
    });

    it("reads nothing from any other tool's arguments", () => {
        const drafts = new PageDrafts(isPageTool, () => 0);
        drafts.start(0, { type: "tool_use", id: "call-2", name: "Write" });
        expect(drain(drafts.delta(0, `{"html":"<p>secret</p>"}`))).toEqual([]);
        expect(drain(drafts.stop(0))).toEqual([]);
        expect(drain(drafts.settled("call-2"))).toEqual([]);
    });

    it("counts a new message's blocks from zero again", () => {
        const drafts = new PageDrafts(isPageTool, () => 0);
        drafts.start(0, { type: "tool_use", id: "call-3", name: "mcp__ui__show_page" });
        drafts.reset();
        expect(drain(drafts.delta(0, `{"html":"<p>"}`))).toEqual([]);
    });
});
