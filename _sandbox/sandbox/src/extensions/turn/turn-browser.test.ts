import type { ToolGrantAccount } from "@intentic/sandbox-contract/extension-protocol";
import { z } from "zod";
import type { InProcessServer, RpcMessage } from "../../agent/tools/turn-mounts.js";
import { scopedBrowserCall } from "./turn-browser.js";

// (2026-11-26) An extension tool driving an account's browser through the turn's own router: the page's own tools only,
// and only on the account's own sites, a call that leaves them handing back nothing of what it saw.

const CHATGPT: ToolGrantAccount = { id: "chatgpt", kind: "browser", sites: ["chatgpt.com", "openai.com"] };

const CallSchema = z.object({ name: z.string(), arguments: z.looseObject({ account: z.string(), url: z.string().optional() }) });

// A router whose one page is at `address`: a navigation moves it, a click may (`clickTo`), and an evaluate of
// `location.href` reads it, as @playwright/mcp answers one (`### Result` and its JSON).
const router = (start: string, clickTo?: string) => {
    let address = start;
    const sent: { readonly name: string; readonly account: string }[] = [];
    const text = (body: string, id: RpcMessage["id"]): RpcMessage => ({ jsonrpc: "2.0", id: id ?? null, result: { content: [{ type: "text", text: body }] } });
    const server: InProcessServer = {
        handle: async (message) => {
            const call = CallSchema.parse(message.params);
            sent.push({ name: call.name, account: call.arguments.account });
            if (call.name === "browser_navigate") {
                address = call.arguments.url ?? address;
            }
            if (call.name === "browser_click" && clickTo !== undefined) {
                address = clickTo;
            }
            return text(call.name === "browser_evaluate" ? `### Result\n${JSON.stringify(address)}` : `### Page\n- Page URL: ${address}\nsecret inbox`, message.id);
        },
        close: () => undefined,
    };
    return { server, sent, at: () => address };
};

const call = (tool: string, args: Readonly<Record<string, string>> = {}) => ({ tool, args });
const signal = new AbortController().signal;

test("a page tool on the account's site runs as the granted account, whatever account its arguments name", async () => {
    const page = router("https://chatgpt.com/c/1");
    expect(await scopedBrowserCall(page.server, CHATGPT, call("browser_snapshot", { account: "me" }), signal)).toEqual({
        result: { content: [{ type: "text", text: "### Page\n- Page URL: https://chatgpt.com/c/1\nsecret inbox" }] },
    });
    // Where the page is, read before and after the call itself.
    expect(page.sent).toEqual([
        { name: "browser_evaluate", account: "chatgpt" },
        { name: "browser_snapshot", account: "chatgpt" },
        { name: "browser_evaluate", account: "chatgpt" },
    ]);
});

test.each(["browser_run_code_unsafe", "browser_network_requests", "browser_tabs", "chatgpt_send"])("%s is refused before anything is sent", async (tool) => {
    const page = router("https://chatgpt.com/");
    expect(await scopedBrowserCall(page.server, CHATGPT, call(tool), signal)).toEqual({ refusal: expect.stringContaining(`${tool} is not a browser tool an extension may call`) });
    expect(page.sent).toEqual([]);
});

test("a navigation goes only to the account's sites and their subdomains", async () => {
    const page = router("about:blank");
    expect(await scopedBrowserCall(page.server, CHATGPT, call("browser_navigate", { url: "https://mail.google.com/" }), signal)).toEqual({
        refusal: 'account "chatgpt" signs in on chatgpt.com or openai.com; https://mail.google.com/ is not on them. Nothing was sent.',
    });
    expect(await scopedBrowserCall(page.server, CHATGPT, call("browser_navigate", { url: "https://chatgpt.com.evil.example/" }), signal)).toMatchObject({
        refusal: expect.stringContaining("is not on them"),
    });
    expect(page.sent).toEqual([]);
    expect(await scopedBrowserCall(page.server, CHATGPT, call("browser_navigate", { url: "https://auth.openai.com/log-in" }), signal)).toMatchObject({ result: {} });
    expect(page.at()).toBe("https://auth.openai.com/log-in");
});

test("a page left on another site is acted on only once it is navigated back", async () => {
    const page = router("https://mail.google.com/mail/u/0/");
    expect(await scopedBrowserCall(page.server, CHATGPT, call("browser_click", { target: "e12" }), signal)).toEqual({
        refusal: 'account "chatgpt"\'s page is on mail.google.com, outside its sites (chatgpt.com or openai.com): navigate to one of them first. Nothing was done.',
    });
    // Only where the page is was read.
    expect(page.sent.map((each) => each.name)).toEqual(["browser_evaluate"]);
});

test("a call that takes the page off the account's sites has its answer withheld", async () => {
    const page = router("https://chatgpt.com/", "https://mail.google.com/");
    expect(await scopedBrowserCall(page.server, CHATGPT, call("browser_click", { target: "e3" }), signal)).toEqual({
        refusal: 'account "chatgpt"\'s page went to mail.google.com during browser_click, outside its sites (chatgpt.com or openai.com), so its answer is withheld: navigate back to one of them.',
        withheld: true,
    });
});

test("a blank page holds nothing signed in, and an account with no site on record is driven nowhere", async () => {
    const blank = router("about:blank");
    expect(await scopedBrowserCall(blank.server, CHATGPT, call("browser_snapshot"), signal)).toMatchObject({ result: {} });
    const nowhere = router("https://chatgpt.com/");
    expect(await scopedBrowserCall(nowhere.server, { ...CHATGPT, sites: [] }, call("browser_snapshot"), signal)).toEqual({
        refusal: 'nothing on record names a site account "chatgpt" signs in on, so an extension drives its browser nowhere.',
    });
    expect(nowhere.sent).toEqual([]);
});
