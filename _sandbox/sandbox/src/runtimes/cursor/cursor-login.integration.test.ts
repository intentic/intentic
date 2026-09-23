import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { waitFor } from "@intentic/testing/bun";
import { createLogger } from "../../logger.js";

const sdk = { login: jest.fn() };
jest.mock("./cursor-sdk.js", () => ({ ensureCursorSdk: async () => ({ Cursor: { auth: { login: sdk.login } } }) }));

const { fileCursorStore, startCursorLogin } = await import("./cursor-credentials.js");

const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });

beforeEach(() => {
    sdk.login.mockImplementation(async (options: { onLoginUrl: (url: string) => void }) => {
        options.onLoginUrl("https://cursor.com/loginDeepControl?challenge=test");
        return { apiKey: "cursor-key", email: "dev@example.com", apiKeyExpiresAtMs: Date.now() + 60_000 };
    });
});

test("a completed login stores the account and makes its runtime pack durable", async () => {
    const store = fileCursorStore(mkdtempSync(join(tmpdir(), "cursor-login-")), logger);
    const connected = jest.fn(async () => {});

    const started = await startCursorLogin({ store, keyName: "intentic sandbox (test)", connected });

    expect(started.url).toContain("cursor.com/loginDeepControl");
    await waitFor(() => expect(connected).toHaveBeenCalledTimes(1));
    expect(await store.credentials()).toMatchObject([{ id: started.handshake, apiKey: "cursor-key", email: "dev@example.com" }]);
});
