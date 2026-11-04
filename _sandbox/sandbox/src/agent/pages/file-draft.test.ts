import { WORKSPACE_ROOT } from "@intentic/constants";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { PartialJsonStrings } from "./page-draft.js";
import { FILE_DRAFT_MAX_CHARS, FileDrafts } from "./file-draft.js";

const CWD = WORKSPACE_ROOT;
const drain = (frames: Generator<AgentEvent>): AgentEvent[] => [...frames];

describe("PartialJsonStrings scalars", () => {
    it("keeps a wanted scalar's literal once it has ended, and never a string's", () => {
        const json = new PartialJsonStrings(new Set(["replace_all", "file_path"]));
        json.feed(`{"file_path":"a.md","replace_all": tr`);
        expect(json.scalar("replace_all")).toBeUndefined();
        json.feed(`ue }`);
        expect(json.scalar("replace_all")).toBe("true");
        expect(json.scalar("file_path")).toBeUndefined();
    });

    it("skips an unwanted scalar without holding it", () => {
        const json = new PartialJsonStrings(new Set(["html"]));
        json.feed(`{"height":400,"html":"<p>"}`);
        expect(json.scalar("height")).toBeUndefined();
        expect(json.value("html")).toBe("<p>");
    });
});

describe("FileDrafts", () => {
    it("streams a Write's content once its file is named, at most every so often, and the rest when the block stops", () => {
        let now = 0;
        const drafts = new FileDrafts(CWD, () => now);
        drafts.start(undefined, 1, { type: "tool_use", id: "call-1", name: "Write" });
        // No file yet: nothing to draw it over.
        expect(drain(drafts.delta(undefined, 1, `{"file_path":"${WORKSPACE_ROOT}/docs/re`))).toEqual([]);
        expect(drain(drafts.delta(undefined, 1, `port.md","content":"# Title`))).toEqual([
            { kind: "file_draft", callId: "call-1", path: "docs/report.md", op: "write", at: 0, text: "# Title" },
        ]);
        now = 50;
        expect(drain(drafts.delta(undefined, 1, `\\nBody`))).toEqual([]);
        now = 400;
        expect(drain(drafts.delta(undefined, 1, ` text`))).toEqual([
            { kind: "file_draft", callId: "call-1", path: "docs/report.md", op: "write", at: 7, text: "\nBody text" },
        ]);
        expect(drain(drafts.delta(undefined, 1, `.\\n"}`))).toEqual([]);
        expect(drain(drafts.stop(undefined, 1))).toEqual([
            { kind: "file_draft", callId: "call-1", path: "docs/report.md", op: "write", at: 17, text: ".\n" },
        ]);
        // Its result lets the draft go, once.
        expect(drain(drafts.settled("call-1"))).toEqual([{ kind: "file_draft", callId: "call-1", path: "docs/report.md", op: "write", at: 0, text: "", done: true }]);
        expect(drain(drafts.settled("call-1"))).toEqual([]);
    });

    it("sends an Edit's old text whole on its first frame, then the replacement, and replace_all once known", () => {
        let now = 0;
        const drafts = new FileDrafts(CWD, () => now);
        drafts.start(undefined, 0, { type: "tool_use", id: "e1", name: "Edit" });
        // The replacement means nothing until the text it replaces is whole.
        expect(drain(drafts.delta(undefined, 0, `{"file_path":"notes.md","old_string":"old par`))).toEqual([]);
        expect(drain(drafts.delta(undefined, 0, `t","new_string":"new`))).toEqual([
            { kind: "file_draft", callId: "e1", path: "notes.md", op: "edit", at: 0, text: "new", old: "old part" },
        ]);
        now = 200;
        expect(drain(drafts.delta(undefined, 0, ` part","replace_all":true}`))).toEqual([
            { kind: "file_draft", callId: "e1", path: "notes.md", op: "edit", at: 3, text: " part", replaceAll: true },
        ]);
        expect(drain(drafts.stop(undefined, 0))).toEqual([]);
    });

    it("drafts nothing for a file outside the workspace, nor settles one", () => {
        const drafts = new FileDrafts(CWD, () => 0);
        drafts.start(undefined, 0, { type: "tool_use", id: "out", name: "Write" });
        expect(drain(drafts.delta(undefined, 0, `{"file_path":"/etc/passwd","content":"root"}`))).toEqual([]);
        expect(drain(drafts.stop(undefined, 0))).toEqual([]);
        expect(drain(drafts.settled("out"))).toEqual([]);
    });

    it("reads nothing from any other tool's arguments", () => {
        const drafts = new FileDrafts(CWD, () => 0);
        drafts.start(undefined, 0, { type: "tool_use", id: "bash", name: "Bash" });
        drafts.start(undefined, 1, { type: "text" });
        expect(drain(drafts.delta(undefined, 0, `{"file_path":"a.md","content":"x"}`))).toEqual([]);
        expect(drain(drafts.stop(undefined, 0))).toEqual([]);
        expect(drain(drafts.settled("bash"))).toEqual([]);
    });

    it("streams the hashline tools' whole-file write by its own path key", () => {
        const drafts = new FileDrafts(CWD, () => 0);
        drafts.start(undefined, 0, { type: "tool_use", id: "h1", name: "mcp__hashline__write" });
        expect(drain(drafts.delta(undefined, 0, `{"path":"src/a.ts","content":"export {}"}`))).toEqual([
            { kind: "file_draft", callId: "h1", path: "src/a.ts", op: "write", at: 0, text: "export {}" },
        ]);
    });

    it("stops at the cap, saying so once, and streams nothing after", () => {
        let now = 0;
        const drafts = new FileDrafts(CWD, () => now);
        drafts.start(undefined, 0, { type: "tool_use", id: "big", name: "Write" });
        const big = "x".repeat(FILE_DRAFT_MAX_CHARS + 10);
        const [frame] = drain(drafts.delta(undefined, 0, `{"file_path":"big.txt","content":"${big}`));
        expect(frame).toMatchObject({ kind: "file_draft", at: 0, truncated: true });
        expect(frame !== undefined && frame.kind === "file_draft" ? frame.text.length : 0).toBe(FILE_DRAFT_MAX_CHARS);
        now = 1000;
        expect(drain(drafts.delta(undefined, 0, `more"}`))).toEqual([]);
        expect(drain(drafts.stop(undefined, 0))).toEqual([]);
        // Still ended by its result, so a viewer drops it.
        expect(drain(drafts.settled("big"))).toHaveLength(1);
    });

    it("keeps a subagent's blocks apart from the main thread's, whose indexes count from zero too", () => {
        const drafts = new FileDrafts(CWD, () => 0);
        drafts.start(undefined, 0, { type: "tool_use", id: "main", name: "Write" });
        drafts.start("task-1", 0, { type: "tool_use", id: "sub", name: "Write" });
        expect(drain(drafts.delta("task-1", 0, `{"file_path":"b.md","content":"sub"`))).toEqual([
            { kind: "file_draft", callId: "sub", path: "b.md", op: "write", at: 0, text: "sub" },
        ]);
        // A new message on the subagent's thread forgets its blocks, not the main thread's.
        drafts.reset("task-1");
        expect(drain(drafts.delta(undefined, 0, `{"file_path":"a.md","content":"main"`))).toEqual([
            { kind: "file_draft", callId: "main", path: "a.md", op: "write", at: 0, text: "main" },
        ]);
        expect(drain(drafts.delta("task-1", 0, `more`))).toEqual([]);
    });
});
