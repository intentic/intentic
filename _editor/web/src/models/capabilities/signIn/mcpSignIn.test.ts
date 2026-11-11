import { CAPABILITY_CATALOG } from "@intentic/capability-catalog";
import { type CapabilitySummary, stashedMarker } from "@intentic/sandbox-contract/schemas/capabilities";
import type { McpAuthCheck, McpSignInWait } from "@intentic/sandbox-contract/schemas/mcp-sign-in";
import { nextTick, ref } from "vue";
import { inSetup } from "../../../testing/inSetup";
import { grantedScopes, type McpSignInCalls, signsInToMcp, storedSignIn, useMcpAuth, useMcpSignIn } from "./mcpSignIn";

const custom = CAPABILITY_CATALOG.find((entry) => entry.id === `custom`)!;
const tokenField = custom.fields.find((field) => field.key === `token`)!;
const urlField = custom.fields.find((field) => field.key === `url`)!;
const OAUTH: McpAuthCheck = { auth: `oauth`, server: `mcp.linear.app`, registers: true };

const signedIn = (config: Record<string, string | boolean>): CapabilitySummary => ({
    id: `linear`,
    kind: `mcp`,
    status: { state: `active` },
    config: { url: `https://mcp.linear.app/mcp`, hasToken: true, ...config },
    secrets: [`token`],
});

it(`stands in for the token box only while the address names a sign-in or the connection holds one`, () => {
    expect(signsInToMcp(custom, tokenField, { check: OAUTH, pasting: false }, undefined)).toBe(true);
    expect(signsInToMcp(custom, urlField, { check: OAUTH, pasting: false }, undefined)).toBe(false);
    // A server that takes a pasted token, or one not yet asked about, keeps the box; so does the person choosing it.
    expect(signsInToMcp(custom, tokenField, { check: { auth: `token` }, pasting: false }, undefined)).toBe(false);
    expect(signsInToMcp(custom, tokenField, { check: undefined, pasting: false }, undefined)).toBe(false);
    expect(signsInToMcp(custom, tokenField, { check: OAUTH, pasting: true }, undefined)).toBe(false);
    // Editing a signed-in connection shows its sign-in even before the address has been asked about again.
    const linear = signedIn({ signedIn: true, signInServer: `mcp.linear.app` });
    expect(signsInToMcp(custom, tokenField, { check: undefined, pasting: false }, linear)).toBe(true);
    // Another kind's token field is none of its business.
    const plugin = CAPABILITY_CATALOG.find((entry) => entry.id === `plugin`)!;
    expect(signsInToMcp(plugin, plugin.fields.find((field) => field.key === `token`)!, { check: OAUTH, pasting: false }, undefined)).toBe(false);
});

it(`reads a connection's sign-in off its echo, and its grant without the sandbox's own housekeeping`, () => {
    expect(storedSignIn(signedIn({ signedIn: true, signInServer: `Notion MCP`, account: `ada@example.com`, scope: `default offline_access` }))).toEqual({
        server: `Notion MCP`,
        account: `ada@example.com`,
        scope: `default offline_access`,
        url: `https://mcp.linear.app/mcp`,
    });
    // A pasted token is no sign-in.
    expect(storedSignIn(signedIn({}))).toBeUndefined();
    expect(grantedScopes(`read write offline_access openid email`)).toBe(`read, write`);
    expect(grantedScopes(`offline_access openid`)).toBeUndefined();
    expect(grantedScopes(undefined)).toBeUndefined();
});

it(`asks about an address once it settles, and answers only for the address the form holds now`, async () => {
    jest.useFakeTimers();
    try {
        const asked: string[] = [];
        const address = ref(`https://mcp.linear.app/m`);
        const { result, stop } = inSetup(() =>
            useMcpAuth(() => address.value, {
                check: async (url) => {
                    asked.push(url);
                    return OAUTH;
                },
            }),
        );
        jest.advanceTimersByTime(300);
        address.value = `https://mcp.linear.app/mcp`;
        await nextTick();
        jest.advanceTimersByTime(600);
        await Promise.resolve();
        await Promise.resolve();
        // The half-typed address was never asked about.
        expect(asked).toEqual([`https://mcp.linear.app/mcp`]);
        expect(result.check.value).toEqual(OAUTH);
        result.pasting.value = true;
        address.value = `https://mcp.sentry.dev/mcp`;
        await nextTick();
        // A new address forgets the old answer and the choice to paste.
        expect(result.check.value).toBeUndefined();
        expect(result.pasting.value).toBe(false);
        stop();
    } finally {
        jest.useRealTimers();
    }
});

// A window the sign-in opens, as the test sees it: where it was sent, and how often it was closed.
const fakeWindow = () => {
    const shown = { location: { href: `` }, closes: 0, close: () => {} };
    shown.close = () => {
        shown.closes += 1;
    };
    return shown;
};

it(`opens the window in the press, sends it to the authorization server, and hands the form the sandbox's marker`, async () => {
    const opened = fakeWindow();
    const waits: McpSignInWait[] = [{ state: `waiting` }, { state: `done`, token: `tok-1`, server: `Linear`, account: `ada@example.com`, scope: `read write` }];
    const calls: McpSignInCalls = {
        check: async () => OAUTH,
        start: async () => ({ flow: `f1`, authorizeUrl: `https://mcp.linear.app/authorize?state=s`, redirectUri: `https://sbx/oauth/mcp/callback`, server: `Linear` }),
        wait: async () => waits.shift()!,
    };
    const { result, stop } = inSetup(() => useMcpSignIn(calls, () => opened));
    const grant = await result.begin({ url: `https://mcp.linear.app/mcp` });
    expect(opened.location.href).toBe(`https://mcp.linear.app/authorize?state=s`);
    expect(grant).toEqual({ marker: stashedMarker(`tok-1`), server: `Linear`, account: `ada@example.com`, scope: `read write`, url: `https://mcp.linear.app/mcp` });
    expect(result.phase.value).toBe(`idle`);
    stop();
});

it(`says a blocked window, a refused start and a failed sign-in in words, and leaves the form as it was`, async () => {
    const failing: McpSignInCalls = {
        check: async () => OAUTH,
        start: async () => {
            throw new Error(`mcp.linear.app refused to register this sandbox as a client (invalid_redirect_uri)`);
        },
        wait: async () => ({ state: `failed`, message: `The sign-in was cancelled at Linear.` }),
    };
    const blocked = inSetup(() => useMcpSignIn(failing, () => null));
    expect(await blocked.result.begin({ url: `https://mcp.linear.app/mcp` })).toBeUndefined();
    expect(blocked.result.problem.value).toBe(`The browser blocked the sign-in window. Allow pop-ups for this page, then press Sign in again.`);

    const opened = fakeWindow();
    const refused = inSetup(() => useMcpSignIn(failing, () => opened));
    expect(await refused.result.begin({ url: `https://mcp.linear.app/mcp` })).toBeUndefined();
    expect(refused.result.problem.value).toBe(`mcp.linear.app refused to register this sandbox as a client (invalid_redirect_uri)`);
    expect(opened.closes).toBe(1);

    const cancelled = inSetup(() =>
        useMcpSignIn({ ...failing, start: async () => ({ flow: `f`, authorizeUrl: `https://a/authorize`, redirectUri: `https://sbx/cb`, server: `Linear` }) }, fakeWindow),
    );
    expect(await cancelled.result.begin({ url: `https://mcp.linear.app/mcp` })).toBeUndefined();
    expect(cancelled.result.problem.value).toBe(`The sign-in was cancelled at Linear.`);
    for (const each of [blocked, refused, cancelled]) {
        each.stop();
    }
});
