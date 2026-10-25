import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import { z } from "zod";
import { accountCovering, accountHostsOf, bareHost, signedInDoor } from "./account-hosts.js";
import { withSignedInDoor } from "./browser-router.js";

// Which signed-in account a page belongs to, and the door the two wrong browsers name instead of opening it blind.

const account = (id: string, platform: string): Capability => ({ id, kind: "browser", config: { platform } });
const SIGN_IN = new Map<string, readonly string[]>([
    ["x", ["https://x.com/i/flow/login", "https://x.com/home"]],
    ["reddit-work", ["https://www.reddit.com/login/", "https://www.reddit.com/"]],
]);
const signInUrls = async (capability: Capability): Promise<readonly string[]> => SIGN_IN.get(capability.id) ?? [];
const ContentSchema = z.object({ content: z.array(z.object({ text: z.string() })) });

test("a page's host is read the way an account's site is written", () => {
    expect(bareHost("https://www.Reddit.com/r/selfhosted")).toBe("reddit.com");
    expect(bareHost("x.com")).toBe("x.com");
    expect(bareHost("not a url at all")).toBeUndefined();
});

test("a granted account claims the hosts its sign-in and home pages are on, and only browser accounts do", async () => {
    const identity: Capability = { id: "radarsuspam", kind: "identity", config: { email: "a@b.cd", openAccounts: "off" } };
    expect(await accountHostsOf([account("x", "x"), account("reddit-work", "reddit"), identity], signInUrls)).toEqual({ "x.com": "x", "reddit.com": "reddit-work" });
});

test("a subdomain belongs to its site's account, a lookalike does not", () => {
    const hosts = { "x.com": "x" };
    expect(accountCovering(hosts, "https://mobile.x.com/notifications")).toEqual({ account: "x", host: "x.com" });
    expect(accountCovering(hosts, "https://notx.com")).toBeUndefined();
    expect(accountCovering(hosts, "https://github.com")).toBeUndefined();
});

// 2026-10-25: a run met X's login wall in the `web` browser and went on to ask the owner's own browser for x.com.
test("the anonymous browser's navigation to a covered site opens with the account's own door", () => {
    const answer = { jsonrpc: "2.0" as const, id: 1, result: { content: [{ type: "text", text: "### Page\n- Page URL: https://x.com/i/flow/login" }] } };
    const steered = withSignedInDoor({ "x.com": "x" }, { name: "browser_navigate", arguments: { url: "https://x.com/notifications" } }, answer);
    const { content } = ContentSchema.parse(steered.result);
    expect(content[0]?.text).toContain("WRONG BROWSER");
    expect(content[0]?.text).toContain('`account: "x"`');
    expect(content[1]?.text).toContain("Page URL");
    // Anywhere else, and any other verb, passes as it came.
    expect(withSignedInDoor({ "x.com": "x" }, { name: "browser_navigate", arguments: { url: "https://github.com" } }, answer)).toBe(answer);
    expect(withSignedInDoor({ "x.com": "x" }, { name: "browser_snapshot", arguments: {} }, answer)).toBe(answer);
    expect(withSignedInDoor(undefined, { name: "browser_navigate", arguments: { url: "https://x.com" } }, answer)).toBe(answer);
});

test("the door names the server, the tool and the account, and what a login page there means", () => {
    const door = signedInDoor("x", "x.com");
    expect(door).toContain("`browser` server");
    expect(door).toContain("mcp__browser__browser_navigate");
    expect(door).toContain('`account: "x"`');
    expect(door).toContain("request_help");
});
