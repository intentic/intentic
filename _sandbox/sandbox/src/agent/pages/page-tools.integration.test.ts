import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentReply } from "@intentic/sandbox-contract";
import type { ParkedCards } from "../../conversations/actor/parked-cards.js";
import { pageTools } from "./page-tools.js";

// The two tools as the agent calls them, without a model: what reaches the chat (the frames pushed), what is filed, and
// what the agent is told back.

type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<{ content: { type: string; text?: string }[]; isError?: boolean }>;
const handlerOf = (tools: ReturnType<typeof pageTools>, name: string): Handler =>
    (tools as unknown as { name: string; handler: Handler }[]).find((tool) => tool.name === name)!.handler;

// A card registry that answers every card with `reply` at once.
const answering = (reply: Omit<Extract<AgentReply, { kind: "page_ask" }>, "requestId">): Pick<ParkedCards, "create"> => ({
    create: ((_kind: string) => ({
        id: "card-1",
        wait: async () => ({ reply: { ...reply, requestId: "card-1" }, resolved: { kind: "resolved", requestId: "card-1", reply: { ...reply, requestId: "card-1" } } }),
    })) as unknown as ParkedCards["create"],
});

describe("the page tools", () => {
    let root: string;
    let pushed: AgentEvent[];
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "page-tools-"));
        pushed = [];
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    const tools = (cards: Pick<ParkedCards, "create"> = answering({ kind: "page_ask", cancelled: true })) =>
        pageTools({ workspaceRoot: root, cwd: root, conversationId: "conv-1", push: (event) => pushed.push(event), cards, signal: new AbortController().signal });

    it("shows a page written inline, files it, and tells the agent how to redraw it", async () => {
        const show = handlerOf(tools(), "show_page");
        const result = await show({ title: "Q3", html: "<p>q3</p>" }, {});
        expect(result.isError).toBeUndefined();
        expect(pushed).toHaveLength(1);
        const page = (pushed[0] as Extract<AgentEvent, { kind: "page" }>).page;
        expect(page).toMatchObject({ title: "Q3" });
        expect(readFileSync(join(root, page.path), "utf8")).toContain("<p>q3</p>");
        expect(result.content[0]?.text).toContain(`replaces: "${page.id}"`);

        const again = await show({ title: "Q3", html: "<p>q3 v2</p>", replaces: page.id }, {});
        expect(again.isError).toBeUndefined();
        expect((pushed[1] as Extract<AgentEvent, { kind: "page" }>).page).toMatchObject({ id: page.id, revision: 1 });
    });

    it("shows a page from a file, as it is now, and says what it left out", async () => {
        mkdirSync(join(root, "reports"));
        writeFileSync(join(root, "reports", "q3.html"), `<img src="gone.png"><script src="https://evil.example.com/x.js"></script>`);
        const result = await handlerOf(tools(), "show_page")({ title: "Q3", path: "reports/q3.html" }, {});
        expect((pushed[0] as Extract<AgentEvent, { kind: "page" }>).page.source).toBe("reports/q3.html");
        expect(result.content[0]?.text).toContain("gone.png");
        expect(result.content[0]?.text).toContain("https://evil.example.com/x.js");
    });

    it("refuses a page given both ways, or neither, and one that redraws a page never shown", async () => {
        const show = handlerOf(tools(), "show_page");
        expect((await show({ title: "x", html: "<p>", path: "a.html" }, {})).isError).toBe(true);
        expect((await show({ title: "x" }, {})).isError).toBe(true);
        expect((await show({ title: "x", html: "<p>", replaces: "0123456789" }, {})).isError).toBe(true);
        expect(pushed).toEqual([]);
    });

    it("asks on a page and hands the agent what the page sent", async () => {
        const ask = handlerOf(tools(answering({ kind: "page_ask", value: `{"pick":"B"}` })), "ask_page");
        const result = await ask({ title: "Pick one", html: "<button>B</button>" }, {});
        expect(pushed.map((event) => event.kind)).toEqual(["page_ask", "resolved"]);
        expect(result.content[0]?.text).toContain(`{"pick":"B"}`);
    });

    it("tells the agent to carry on when the page is dismissed", async () => {
        const result = await handlerOf(tools(), "ask_page")({ title: "Pick one", html: "<button>B</button>" }, {});
        expect(result.content[0]?.text).toContain("dismissed");
    });
});
