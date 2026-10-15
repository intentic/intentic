import { bindingOf, deviceLogin, MICROSOFT_SCOPES, mintAccessToken, OAuthRefusedError, tokenUrl } from "./oauth.js";

const microsoft = {
    username: "sekretariat@urzad.example.org",
    oauthProvider: "microsoft",
    oauthTenant: "tenant",
    oauthClientId: "client",
    oauthRefreshToken: "rt-1",
};

const answering = (answers: { status?: number; body: unknown }[]) => {
    const calls: { url: string; form: URLSearchParams }[] = [];
    const http = async (url: string, init?: RequestInit): Promise<Response> => {
        calls.push({ url, form: new URLSearchParams(String(init?.body)) });
        const answer = answers.shift();
        if (answer === undefined) {
            throw new Error(`unexpected call to ${url}`);
        }
        return new Response(JSON.stringify(answer.body), { status: answer.status ?? 200 });
    };
    return { http, calls };
};

test("Exchange Online: one token for IMAP and SMTP, minted from the card's refresh token, a rotation stored first", async () => {
    const { http, calls } = answering([{ body: { access_token: "at", refresh_token: "rt-2" } }]);
    const saved: string[][] = [];
    expect(await mintAccessToken(microsoft, { http, save: async (token, previous) => void saved.push([token, previous]) })).toBe("at");
    expect(calls[0]!.url).toBe("https://login.microsoftonline.com/tenant/oauth2/v2.0/token");
    expect(calls[0]!.form.get("scope")).toBe(MICROSOFT_SCOPES);
    expect(calls[0]!.form.get("refresh_token")).toBe("rt-1");
    expect(calls[0]!.form.get("client_secret")).toBeNull();
    expect(saved).toEqual([["rt-2", "rt-1"]]);
});

test("Gmail: Google's token endpoint with the client secret, and no scope (the consent fixed it)", async () => {
    const google = { ...microsoft, oauthProvider: "google", oauthClientSecret: "cs" };
    const { http, calls } = answering([{ body: { access_token: "gmail-at" } }]);
    expect(await mintAccessToken(google, { http })).toBe("gmail-at");
    expect(calls[0]!.url).toBe("https://oauth2.googleapis.com/token");
    expect(calls[0]!.form.get("client_secret")).toBe("cs");
    expect(calls[0]!.form.get("scope")).toBeNull();
    expect(tokenUrl(google)).toBe("https://oauth2.googleapis.com/token");
});

test("a ready access token is used as it is; a refusal is fatal and never quotes the authority's body", async () => {
    expect(await mintAccessToken({ username: "u", oauthProvider: "token", accessToken: "given" })).toBe("given");
    await expect(mintAccessToken({ username: "u", oauthProvider: "token" })).rejects.toBeInstanceOf(OAuthRefusedError);
    const { http } = answering([{ status: 400, body: { error: "invalid_grant", error_description: "rt-1 revoked" } }]);
    const refused = mintAccessToken(microsoft, { http });
    await expect(refused).rejects.toThrow("run `imap login` again");
    await expect(mintAccessToken({ ...microsoft, oauthRefreshToken: "" })).rejects.toThrow("Nobody has signed in");
    await expect(mintAccessToken({ ...microsoft, oauthTenant: "a/b" })).rejects.toThrow("tenant");
});

test("Exchange Online device sign-in prints only Microsoft's page and code and stores the token on the card", async () => {
    const { http } = answering([
        {
            body: {
                device_code: "dc",
                user_code: "WXYZ",
                verification_uri: "https://microsoft.com/devicelogin",
                expires_in: 60,
                interval: 1,
                message: "do something else",
            },
        },
        { status: 400, body: { error: "authorization_pending" } },
        { body: { access_token: "at-secret", refresh_token: "rt-secret" } },
    ]);
    const lines: string[] = [];
    const saved: unknown[] = [];
    let now = 0;
    await deviceLogin(
        { ...microsoft, oauthRefreshToken: "" },
        async (...args) => void saved.push(args),
        (line) => lines.push(line),
        {
            http,
            pause: async (ms) => {
                now += ms;
            },
            now: () => now,
        },
    );
    expect(saved).toEqual([["rt-secret", "", true]]);
    const printed = lines.join("\n");
    expect(printed).toContain("WXYZ");
    for (const secret of ["rt-secret", "at-secret", "dc", "do something else"]) {
        expect(printed).not.toContain(secret);
    }
    await expect(
        deviceLogin(
            { ...microsoft, oauthProvider: "google" },
            async () => {},
            () => {},
        ),
    ).rejects.toThrow("Gmail");
    expect(bindingOf(microsoft)).toEqual({
        oauthProvider: "microsoft",
        oauthTenant: "tenant",
        oauthClientId: "client",
        username: "sekretariat@urzad.example.org",
    });
});
