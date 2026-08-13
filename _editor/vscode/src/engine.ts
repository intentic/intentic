import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { join } from "node:path";
import * as vscode from "vscode";
import { engineEnv } from "./engineEnv.js";

/* THE ENGINE'S LIFETIME IS THE WINDOW'S — the decided product shape: agents pause when the editor closes,
 * and reopening resumes where things stood (the engine's own registry and resume schedulers carry that).
 *
 * One engine per window, serving the window's first workspace folder. Spawned as a plain child process on a
 * free loopback port; killed on deactivate. Health is the engine's own /health (which also names its boot
 * step, so the chat panel can narrate a slow start instead of showing a dead pane).
 *
 * WHAT RUNS: the engine bundled with the extension (engine/dist/main.js, the daemon's deploy tree) — or, in
 * a development checkout, whatever `intentic.engine.command` says. The override is what makes this package
 * testable against engine source without a packaging step; the bundled tree is the shipped default
 * (build-vscode-extension.sh assembles it). */

const HEALTH_INTERVAL_MS = 500;
const HEALTH_TIMEOUT_MS = 60_000;

// The origin family VSCode webviews present when they fetch (one floating label per webview session). The
// engine's allowlist takes it verbatim — see the engine's CORS family entries.
const WEBVIEW_ORIGIN_FAMILY = "https://*.vscode-webview.net";

const freePort = (): Promise<number> =>
    new Promise((resolve, reject) => {
        const probe = createServer();
        probe.once("error", reject);
        probe.listen(0, "127.0.0.1", () => {
            const address = probe.address();
            probe.close(() => {
                if (address === null || typeof address === "string") {
                    reject(new Error("no port allocated"));
                    return;
                }
                resolve(address.port);
            });
        });
    });

export interface Engine {
    readonly url: string;
    readonly dispose: () => void;
}

const waitHealthy = async (url: string, child: ChildProcess, output: vscode.OutputChannel): Promise<void> => {
    const deadline = Date.now() + HEALTH_TIMEOUT_MS;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) {
            throw new Error(`the engine exited with code ${child.exitCode} before it became healthy — see "${output.name}" for its log`);
        }
        try {
            const response = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2_000) });
            if (response.ok) {
                return;
            }
        } catch {
            // Not up yet — the loop's next probe answers.
        }
        await new Promise((resolve) => setTimeout(resolve, HEALTH_INTERVAL_MS));
    }
    throw new Error(`the engine did not answer /health within ${HEALTH_TIMEOUT_MS / 1000}s — see "${output.name}" for its log`);
};

// What to spawn: the settings override when present (a development checkout), else the bundled engine.
const engineCommand = (context: vscode.ExtensionContext): { argv: readonly string[]; cwd: string } => {
    const config = vscode.workspace.getConfiguration("intentic.engine");
    const override = config.get<string[]>("command") ?? [];
    if (override.length > 0) {
        return { argv: override, cwd: config.get<string>("cwd") ?? "" };
    }
    // The deploy tree's built entry (build-vscode-extension.sh assembles engine/ from the daemon package).
    const bundled = join(context.extensionPath, "engine", "dist", "main.js");
    // The extension host's own Node runs the bundle — no system Node required.
    return { argv: [process.execPath, bundled], cwd: join(context.extensionPath, "engine") };
};

export const startEngine = async (context: vscode.ExtensionContext, workspaceRoot: string, output: vscode.OutputChannel): Promise<Engine> => {
    const port = await freePort();
    const { argv, cwd } = engineCommand(context);
    const [command, ...args] = argv;
    if (command === undefined) {
        throw new Error("no engine command resolved");
    }
    const env = engineEnv({
        workspaceRoot,
        storageRoot: context.globalStorageUri.fsPath,
        workspaceSlug: createHash("sha256").update(workspaceRoot).digest("hex").slice(0, 16),
        port,
        webviewOrigins: [WEBVIEW_ORIGIN_FAMILY],
    });
    const child = spawn(command, args, {
        ...(cwd === "" ? {} : { cwd }),
        // ELECTRON_RUN_AS_NODE: process.execPath is the editor's Electron; this makes it plain Node for the
        // bundled engine. Harmless under the override, which names its own runtime.
        env: { ...process.env, ...env, ELECTRON_RUN_AS_NODE: "1" },
        stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk: Buffer) => output.append(chunk.toString()));
    child.stderr?.on("data", (chunk: Buffer) => output.append(chunk.toString()));
    const url = `http://127.0.0.1:${port}`;
    await waitHealthy(url, child, output);
    return {
        url,
        dispose: () => {
            child.kill("SIGTERM");
        },
    };
};
