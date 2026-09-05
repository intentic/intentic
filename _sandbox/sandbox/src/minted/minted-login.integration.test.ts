import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { createLogger } from "../logger.js";
import { memoryMintedStore } from "../route-testing.js";
import { metaLoginDriver } from "./meta-login.js";
import { cancelAllMintedLogins, cancelMintedLogin, completeMintedLogin, startMintedLogin } from "./minted-login.js";
import { zaiLoginDriver } from "./zai-login.js";

/* THE THREE SIGN-INS, END TO END, against a vendor that is not there.
 *
 * WHY THIS FILE EXISTS AT ALL. Nobody here holds a Muse Code subscription, a GLM Coding Plan or a BigModel
 * account, so the one thing that cannot be proved on this machine is the click on the vendor's approval page.
 * Everything on THIS side of that click can be, and all of it is wire detail that compiles either way: which URL
 * is asked, in what encoding, with which token in which header, what a `slow_down` does to the interval, which
 * failure is a refusal and which is a blip, and — the assertion this whole change turns on — that the key a mint
 * produced reaches the store and never reaches a caller.
 *
 * The fake vendor is a `fetch` that routes on URL and RECORDS every call, so the assertions are about the
 * conversation rather than about a mocked return value. Time is faked, because both flows poll on the vendor's
 * own interval and a real test that waited would take a minute to say nothing extra. */

const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });

const META_HOSTS = {
    deviceAuthorization: "https://auth.meta.test/oidc/device/authorization/",
    token: "https://auth.meta.test/oidc/device/token/",
    mint: "https://api.meta.test/muse-code/key",
};

const ZAI_HOSTS = {
    oauthBase: "https://zcode.test/api/v1",
    zaiBiz: "https://api.zai.test",
    bigModelBiz: "https://bigmodel.test",
    bigModelLogin: "https://bigmodel.test/login",
};

interface Call {
    readonly url: string;
    readonly method: string;
    readonly headers: Headers;
    readonly body: string;
}

// A vendor that answers by URL. Handlers are consumed in order per URL where a route answers differently on
// successive calls (a poll that is pending and then ready), which is the whole shape of a device flow.
const fakeVendor = (routes: Record<string, (call: Call) => unknown>) => {
    const calls: Call[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
        const call: Call = {
            url: String(url),
            method: init?.method ?? "GET",
            headers: new Headers(init?.headers),
            body: typeof init?.body === "string" ? init.body : "",
        };
        calls.push(call);
        const route = Object.entries(routes).find(([prefix]) => call.url.startsWith(prefix));
        if (route === undefined) {
            return new Response("not found", { status: 404 });
        }
        const answer = route[1](call);
        if (answer instanceof Response) {
            return answer;
        }
        return new Response(JSON.stringify(answer), { headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
};

// The `{code, data}` envelope both Z.ai roots answer in. Business errors ride an HTTP 200, which is exactly why
// the driver unwraps rather than trusting a status.
const envelope = (data: unknown) => ({ code: 0, msg: "", data });

const connected = (store: ReturnType<typeof memoryMintedStore>) => store.credentials();

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    // A sign-in whose poll is still running would tick into the next test's fake clock.
    cancelAllMintedLogins();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

/* --- Meta: RFC 8628 device flow, then the exchange that makes the token usable --------------------------- */

const metaVendor = (options: { tokenAnswers: ((call: Call) => unknown)[]; mint?: (call: Call) => unknown }) => {
    const answers = [...options.tokenAnswers];
    return fakeVendor({
        [META_HOSTS.deviceAuthorization]: () => ({
            device_code: "dev-code-1",
            user_code: "WDJB-MJHT",
            verification_uri: "https://meta.test/device",
            verification_uri_complete: "https://meta.test/device?user_code=WDJB-MJHT",
            expires_in: 600,
            interval: 5,
        }),
        [META_HOSTS.token]: (call) => (answers.length > 1 ? answers.shift()!(call) : answers[0]!(call)),
        [META_HOSTS.mint]: options.mint ?? (() => ({ api_key: "LLM|minted-key", user_email: "someone@example.com", is_subs_active: true })),
    });
};

const startMeta = async (vendor: ReturnType<typeof fakeVendor>) => {
    const store = memoryMintedStore("Meta");
    const forgotten = vi.fn();
    const started = await startMintedLogin({
        provider: "meta",
        driver: metaLoginDriver(META_HOSTS),
        store,
        logger,
        onConnected: forgotten,
        fetchImpl: vendor.fetchImpl,
    });
    return { store, forgotten, started };
};

test("Meta's sign-in hands back the vendor's page and code before anybody has approved anything", async () => {
    const vendor = metaVendor({ tokenAnswers: [() => ({ error: "authorization_pending" })] });
    const { started, store } = await startMeta(vendor);

    // The complete URL, not the bare one: it carries the code, so the page the user lands on is already filled
    // in and the code on the card is a confirmation rather than something to type.
    expect(started.url).toBe("https://meta.test/device?user_code=WDJB-MJHT");
    expect(started.code).toBe("WDJB-MJHT");
    expect(started.flow).toBe("device");
    // Nothing to paste back, so nothing to recognise a paste by.
    expect(started.state).toBe("");
    expect(started.variant).toBe("meta");
    expect(started.expiresAt).toBe(Date.now() + 600_000);
    // The answer is a card, not a credential: `start` returns before the user has done anything at all.
    expect(JSON.stringify(started)).not.toContain("LLM|");
    expect(await connected(store)).toEqual([]);

    // Form-encoded with the vendor's own client id: this endpoint is the terminal sign-in road, and it answers
    // a request that looks like one.
    const [begin] = vendor.calls;
    expect(begin?.method).toBe("POST");
    expect(begin?.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(new URLSearchParams(begin?.body ?? "").get("client_id")).toBe("1031625952748946");

    cancelMintedLogin("meta", started.handshake);
});

test("Meta's approval mints the vendor's own key and stores it, and only it", async () => {
    const vendor = metaVendor({
        tokenAnswers: [() => ({ error: "authorization_pending" }), () => ({ access_token: "dca:device-token" })],
    });
    const { store, forgotten } = await startMeta(vendor);

    // Two ticks at the vendor's advertised five seconds: pending, then granted.
    await vi.advanceTimersByTimeAsync(11_000);

    const stored = await connected(store);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.apiKey).toBe("LLM|minted-key");
    // Whose it is, from the mint rather than from anything the user typed: a minted key says nothing about
    // itself, so this is the only thing that can name the row.
    expect(stored[0]?.email).toBe("someone@example.com");
    expect(stored[0]?.variant).toBe("meta");
    // The catalog is read with a connected account's key, so a connect has to drop the cached answer.
    expect(forgotten).toHaveBeenCalledTimes(1);

    /* THE DEVICE TOKEN IS NOT THE CREDENTIAL, which is the fact this whole mechanism exists for: Meta's model
     * endpoint refuses `dca:` tokens, so a sign-in that stored one would connect a row whose every turn is a
     * 401. The mint is what turns it into a key, and it is addressed with the device token as a bearer. */
    const mint = vendor.calls.find((call) => call.url === META_HOSTS.mint);
    expect(mint?.headers.get("authorization")).toBe("Bearer dca:device-token");
    expect(JSON.parse(mint?.body ?? "{}")).toEqual({ dca_token: "dca:device-token" });
    expect(stored[0]?.apiKey).not.toBe("dca:device-token");
});

/* A `slow_down` IS AN INSTRUCTION, not an error. RFC 8628 says the client widens its interval and keeps going;
 * a client that treated it as a failure would abandon a sign-in the user is still completing, and one that
 * ignored it would keep being told off. */
test("Meta's slow_down widens the poll interval instead of ending the sign-in", async () => {
    const vendor = metaVendor({
        tokenAnswers: [() => ({ error: "slow_down" }), () => ({ access_token: "dca:device-token" })],
    });
    const { store } = await startMeta(vendor);

    // First tick at 5s says slow down. The second must NOT come at 10s.
    await vi.advanceTimersByTimeAsync(9_000);
    const afterFirst = vendor.calls.filter((call) => call.url === META_HOSTS.token).length;
    expect(afterFirst, "the first tick did not happen at the advertised interval").toBe(1);

    // 5s + the slow_down step: the second tick lands at 15s, not 10s.
    await vi.advanceTimersByTimeAsync(3_000);
    expect(vendor.calls.filter((call) => call.url === META_HOSTS.token).length, "the interval did not widen").toBe(1);
    await vi.advanceTimersByTimeAsync(4_000);
    expect(await connected(store)).toHaveLength(1);
});

test("a Meta sign-in declined on the page connects nothing", async () => {
    const vendor = metaVendor({ tokenAnswers: [() => ({ error: "access_denied" })] });
    const { store } = await startMeta(vendor);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(await connected(store)).toEqual([]);
    // And the poll STOPS: a declined sign-in that kept asking would spend the next ten minutes being declined.
    const asked = vendor.calls.filter((call) => call.url === META_HOSTS.token).length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(vendor.calls.filter((call) => call.url === META_HOSTS.token).length).toBe(asked);
});

/* AN ACCOUNT WITH NO LIVE PLAN IS NOT A CONNECTION. Meta issues a key and says `require_payment`; storing it
 * would draw a connected row whose every turn is refused, with the reason living only in the refusal. */
test("a Meta account with no active plan is refused rather than stored", async () => {
    const vendor = metaVendor({
        tokenAnswers: [() => ({ access_token: "dca:device-token" })],
        mint: () => ({ api_key: "LLM|useless", user_email: "someone@example.com", require_payment: true }),
    });
    const { store } = await startMeta(vendor);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(await connected(store)).toEqual([]);
});

test("cancelling a Meta sign-in stops its poll", async () => {
    const vendor = metaVendor({ tokenAnswers: [() => ({ error: "authorization_pending" })] });
    const { store, started } = await startMeta(vendor);
    await vi.advanceTimersByTimeAsync(6_000);
    const asked = vendor.calls.filter((call) => call.url === META_HOSTS.token).length;

    cancelMintedLogin("meta", started.handshake);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(vendor.calls.filter((call) => call.url === META_HOSTS.token).length, "a cancelled sign-in kept polling").toBe(asked);
    expect(await connected(store)).toEqual([]);
});

/* --- Z.ai international: the mediated flow, polled to completion ----------------------------------------- */

const KEYS_PATH = "/api/biz/v1/organization/org-1/projects/proj-1/api_keys";

// The four provisioning calls both estates share, hung off whichever business host the estate uses.
const zaiBusinessRoutes = (host: string): Record<string, (call: Call) => unknown> => ({
    [`${host}/api/biz/customer/getCustomerInfo`]: () =>
        envelope({
            organizations: [{ organizationId: "org-1", organizationName: "默认机构", projects: [{ projectId: "proj-1", projectName: "默认项目" }] }],
        }),
    [`${host}${KEYS_PATH}/copy/`]: () => envelope({ secretKey: "sk-secret" }),
    [`${host}${KEYS_PATH}`]: (call) => (call.method === "POST" ? envelope({ apiKey: "ak-made" }) : envelope([])),
});

test("Z.ai's international sign-in polls to completion and provisions the plan's key", async () => {
    const polls = [
        () => envelope({ status: "pending" }),
        () => envelope({ status: "ready", token: "zc-token", user: { email: "plan@example.com", name: "" }, zai: { access_token: "z-access" } }),
    ];
    const vendor = fakeVendor({
        [`${ZAI_HOSTS.oauthBase}/oauth/cli/init`]: () =>
            envelope({ flow_id: "flow-1", poll_token: "server-poll-token", authorize_url: "https://z.ai/authorize?flow=1", poll_interval_sec: 2 }),
        [`${ZAI_HOSTS.oauthBase}/oauth/cli/poll/`]: () => (polls.length > 1 ? polls.shift()!() : polls[0]!()),
        [`${ZAI_HOSTS.zaiBiz}/api/auth/z/login`]: () => envelope({ access_token: "biz-token" }),
        ...zaiBusinessRoutes(ZAI_HOSTS.zaiBiz),
    });
    const store = memoryMintedStore("Z.ai");
    const started = await startMintedLogin({
        provider: "zai",
        variant: "zai",
        driver: zaiLoginDriver(ZAI_HOSTS),
        store,
        logger,
        onConnected: () => {},
        fetchImpl: vendor.fetchImpl,
    });

    expect(started.url).toBe("https://z.ai/authorize?flow=1");
    // Mediated: the page is already addressed to this attempt, so there is no code and nothing to paste.
    expect(started.flow).toBe("device");
    expect(started.code).toBe("");
    expect(started.state).toBe("");

    await vi.advanceTimersByTimeAsync(5_000);

    const stored = await connected(store);
    /* THE CREDENTIAL IS THE PAIR, and that is a fact about this endpoint rather than a formatting choice: the
     * international Anthropic surface wants `<apiKey>.<secretKey>` and refuses either half alone. */
    expect(stored[0]?.apiKey).toBe("ak-made.sk-secret");
    expect(stored[0]?.email).toBe("plan@example.com");
    expect(stored[0]?.variant).toBe("zai");

    // The poll is bearer'd with the SERVER's copy of the poll token, not the one this client generated: the
    // server's is authoritative where it sends one.
    const poll = vendor.calls.find((call) => call.url.includes("/oauth/cli/poll/"));
    expect(poll?.headers.get("authorization")).toBe("Bearer server-poll-token");
    // Internationally the OAuth token is swapped for a console session before anything is provisioned.
    expect(vendor.calls.some((call) => call.url === `${ZAI_HOSTS.zaiBiz}/api/auth/z/login`)).toBe(true);
    expect(vendor.calls.find((call) => call.url.endsWith(KEYS_PATH))?.headers.get("authorization")).toBe("Bearer biz-token");
});

/* --- Z.ai mainland: the redirect that dead-ends, and comes back through the user ------------------------- */

const startBigModel = async (vendor: ReturnType<typeof fakeVendor>) => {
    const store = memoryMintedStore("Z.ai");
    const started = await startMintedLogin({
        provider: "zai",
        variant: "bigmodel",
        driver: zaiLoginDriver(ZAI_HOSTS),
        store,
        logger,
        onConnected: () => {},
        fetchImpl: vendor.fetchImpl,
    });
    return { store, started };
};

const bigModelVendor = (exchange?: (call: Call) => unknown) =>
    fakeVendor({
        [`${ZAI_HOSTS.oauthBase}/oauth/token`]:
            exchange ?? (() => envelope({ token: "bm-token", user: { email: "mainland@example.com", name: "" }, bigmodel: { access_token: "bm-access" } })),
        ...zaiBusinessRoutes(ZAI_HOSTS.bigModelBiz),
    });

test("Z.ai's mainland sign-in sends the browser somewhere it can identify the answer from", async () => {
    const vendor = bigModelVendor();
    const { started } = await startBigModel(vendor);

    expect(started.flow).toBe("redirect");
    expect(started.variant).toBe("bigmodel");
    const url = new URL(started.url);
    expect(url.origin + url.pathname).toBe(ZAI_HOSTS.bigModelLogin);
    // The state on the card is the one in the address the vendor will send back, which is what lets the panel
    // recognise a pasted address as this attempt's before sending it anywhere.
    expect(url.searchParams.get("state")).toBe(started.state);
    expect(started.state).not.toBe("");
    // A loopback redirect nothing binds: the page dead-ends by design, which is the state the panel draws.
    expect(url.searchParams.get("redirect")).toContain("127.0.0.1");
    // Nothing has been asked of the vendor yet: this flow's first call happens when the grant comes back.
    expect(vendor.calls).toEqual([]);
});

test("the pasted address finishes a mainland sign-in and provisions its key", async () => {
    const vendor = bigModelVendor();
    const { store, started } = await startBigModel(vendor);

    completeMintedLogin({
        provider: "zai",
        handshake: started.handshake,
        // BigModel names the grant `authCode`, which is the one word this whole paste-back turns on.
        redirectUrl: `http://127.0.0.1:8317/callback?authCode=grant-abc&state=${started.state}`,
    });
    await vi.advanceTimersByTimeAsync(100);

    const stored = await connected(store);
    expect(stored[0]?.apiKey).toBe("ak-made.sk-secret");
    expect(stored[0]?.variant).toBe("bigmodel");
    expect(stored[0]?.email).toBe("mainland@example.com");

    const exchanged = vendor.calls.find((call) => call.url === `${ZAI_HOSTS.oauthBase}/oauth/token`);
    expect(JSON.parse(exchanged?.body ?? "{}")).toMatchObject({ provider: "bigmodel", code: "grant-abc", state: started.state });
    // The mainland OAuth token authorizes the business API directly: no console swap, and the token rides
    // verbatim rather than under a Bearer this side invented.
    expect(vendor.calls.some((call) => call.url.endsWith("/api/auth/z/login"))).toBe(false);
    expect(vendor.calls.find((call) => call.url.endsWith(KEYS_PATH))?.headers.get("authorization")).toBe("bm-access");
});

/* THE STATE IS CHECKED AGAINST OUR OWN COPY. An address from a second tab or an old paste carries somebody
 * else's grant, and redeeming it would attach that grant to this attempt. */
test("an address from a different sign-in is refused and redeems nothing", async () => {
    const vendor = bigModelVendor();
    const { store, started } = await startBigModel(vendor);

    expect(() =>
        completeMintedLogin({
            provider: "zai",
            handshake: started.handshake,
            redirectUrl: "http://127.0.0.1:8317/callback?authCode=grant-abc&state=some-other-attempt",
        }),
    ).toThrow(/different sign-in/);
    await vi.advanceTimersByTimeAsync(100);
    expect(vendor.calls).toEqual([]);
    expect(await connected(store)).toEqual([]);
});

test("an address carrying the vendor's error fails the sign-in in the vendor's words", async () => {
    const vendor = bigModelVendor();
    const { store, started } = await startBigModel(vendor);

    expect(() =>
        completeMintedLogin({
            provider: "zai",
            handshake: started.handshake,
            redirectUrl: "http://127.0.0.1:8317/callback?error=access_denied&error_description=You%20declined%20it",
        }),
    ).toThrow("You declined it");
    await vi.advanceTimersByTimeAsync(100);
    expect(await connected(store)).toEqual([]);
});

test("an address with no grant in it is refused before anything is sent", async () => {
    const vendor = bigModelVendor();
    const { started } = await startBigModel(vendor);
    expect(() => completeMintedLogin({ provider: "zai", handshake: started.handshake, redirectUrl: "https://bigmodel.test/login" })).toThrow(
        /no authorization code/,
    );
    expect(vendor.calls).toEqual([]);
});

/* A DEVICE SIGN-IN HAS NOTHING TO PASTE BACK, and saying so is better than silence: a caller doing this has
 * confused two flows, and without the refusal they would be told nothing while the poll carried on regardless. */
test("pasting an address at a device sign-in says so rather than being ignored", async () => {
    const vendor = metaVendor({ tokenAnswers: [() => ({ error: "authorization_pending" })] });
    const { started } = await startMeta(vendor);
    expect(() =>
        completeMintedLogin({ provider: "meta", handshake: started.handshake, redirectUrl: "http://127.0.0.1:8317/callback?code=x" }),
    ).toThrow(/nothing to paste back/);
    cancelMintedLogin("meta", started.handshake);
});

test("an estate the provider does not have is refused rather than defaulted", async () => {
    const vendor = bigModelVendor();
    await expect(
        startMintedLogin({
            provider: "zai",
            variant: "not-an-estate",
            driver: zaiLoginDriver(ZAI_HOSTS),
            store: memoryMintedStore("Z.ai"),
            logger,
            onConnected: () => {},
            fetchImpl: vendor.fetchImpl,
        }),
    ).rejects.toThrow(/no "not-an-estate" sign-in/);
    // Refused before the vendor is touched: signing somebody into the wrong estate mints a key their turns
    // cannot use, and the failure would arrive as an authentication error they cannot act on.
    expect(vendor.calls).toEqual([]);
});

// A handshake that has already landed or expired is a no-op, not an error: both are the state the caller was
// asking for, and a 500 on "stop waiting" would be the card reporting a problem that is not one.
test("cancelling a sign-in nobody is waiting on is a no-op", () => {
    expect(() => cancelMintedLogin("meta", "never-existed")).not.toThrow();
});
