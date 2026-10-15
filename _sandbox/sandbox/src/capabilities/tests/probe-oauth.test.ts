import { probeOAuth } from "../probe-oauth.js";

const oauth = {
    tokenUrl: "https://login.microsoftonline.com/tenant/oauth2/v2.0/token",
    form: { grant_type: "refresh_token", refresh_token: "secret" },
};
const answering =
    (body: unknown, calls: string[] = []) =>
    async (url: URL, options?: { headers?: unknown; body?: unknown }) => {
        calls.push(url.toString());
        expect(options?.headers).toEqual({ "content-type": "application/x-www-form-urlencoded" });
        expect(new URLSearchParams(String(options?.body)).get("refresh_token")).toBe("secret");
        return { status: 200, headers: {}, truncated: false, body: Buffer.from(JSON.stringify(body)) };
    };

test("the trade happens only at the token endpoint, and the bearer stays in memory", async () => {
    const calls: string[] = [];
    expect(await probeOAuth(oauth, "https://graph.microsoft.com/v1.0/me", answering({ access_token: "ephemeral" }, calls))).toEqual({
        url: "https://graph.microsoft.com/v1.0/me",
        token: "ephemeral",
    });
    expect(calls).toEqual([oauth.tokenUrl]);
});

test("the test goes to the Graph paired with the sign-in cloud, whatever host the declared URL names", async () => {
    const us = { ...oauth, tokenUrl: "https://login.microsoftonline.us/tenant/oauth2/v2.0/token" };
    expect((await probeOAuth(us, "https://graph.microsoft.com/v1.0/me", answering({ access_token: "a" }))).url).toBe(
        "https://graph.microsoft.us/v1.0/me",
    );
    expect((await probeOAuth(oauth, "https://evil.example/v1.0/me", answering({ access_token: "a" }))).url).toBe(
        "https://graph.microsoft.com/v1.0/me",
    );
});

test("an authority outside Microsoft's clouds is refused before the network, and an answer without a token is a refusal", async () => {
    const transport = async (): Promise<never> => {
        throw new Error("must not call network");
    };
    await expect(probeOAuth({ ...oauth, tokenUrl: "https://evil.example/token" }, "https://graph.microsoft.com/v1.0/me", transport)).rejects.toThrow(
        "Unsupported",
    );
    await expect(
        probeOAuth({ ...oauth, tokenUrl: "http://login.microsoftonline.com/t/token" }, "https://graph.microsoft.com/v1.0/me", transport),
    ).rejects.toThrow("Unsupported");
    await expect(probeOAuth(oauth, "https://graph.microsoft.com/v1.0/me", answering({ error: "invalid_grant" }))).rejects.toThrow("no token");
});
