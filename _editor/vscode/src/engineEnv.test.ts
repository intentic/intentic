import { expect, test } from "vitest";
import { engineEnv } from "./engineEnv.js";

test("the engine env pins the local contract: loopback, no platform, storage off the user's folder", () => {
    const env = engineEnv({
        workspaceRoot: "/home/dev/project",
        storageRoot: "/data/intentic",
        workspaceSlug: "abc123",
        port: 8891,
        webviewOrigins: ["https://*.vscode-webview.net"],
    });
    expect(env["SANDBOX_PROFILE"]).toBe("local");
    expect(env["SANDBOX_HOST"]).toBe("127.0.0.1");
    expect(env["WORKSPACE_ROOT"]).toBe("/home/dev/project");
    // History and credentials live under the extension's storage — never the project, never HOME.
    expect(env["HISTORY_ROOT"]).toBe("/data/intentic/workspaces/abc123/history");
    expect(env["AGENT_AUTH_DIR"]).toBe("/data/intentic/auth");
    expect(env["WEB_ORIGIN"]).toBe("https://*.vscode-webview.net");
    // The floor's variables are spelled empty so an inherited shell value can never re-platform the engine.
    for (const name of ["CONNECT_TOKEN", "SANDBOX_PUBLIC_URL", "PLATFORM_URL", "GOOGLE_CLIENT_ID"]) {
        expect(env[name]).toBe("");
    }
});
