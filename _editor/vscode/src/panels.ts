import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import * as vscode from "vscode";
import { appHtml, type AppEnvironment } from "./appHtml.js";

/* The inbound half of the app's host bridge (its local/hostBridge.ts vocabulary): a file link opens a REAL
 * editor document — the whole point of hosting these panels where the user's own editor already is — and the
 * attention count becomes the chat view's badge, the editor's native "something needs you". */
const onBridgeMessage = (message: unknown, badge: (count: number) => void): void => {
    if (typeof message !== "object" || message === null) {
        return;
    }
    const { type } = message as { type?: unknown };
    if (type === "intentic:open-file") {
        const { path, line } = message as { path?: unknown; line?: unknown };
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (typeof path !== "string" || path === "" || folder === undefined) {
            return;
        }
        const target = vscode.Uri.joinPath(folder.uri, path);
        const options: vscode.TextDocumentShowOptions =
            typeof line === "number" && Number.isFinite(line) ? { selection: new vscode.Range(Math.max(0, line - 1), 0, Math.max(0, line - 1), 0) } : {};
        void vscode.window.showTextDocument(target, options);
        return;
    }
    if (type === "intentic:attention") {
        const { count } = message as { count?: unknown };
        if (typeof count === "number" && Number.isFinite(count) && count >= 0) {
            badge(count);
        }
    }
};

/* THE THREE SURFACES, AS THE EDITOR HOSTS THEM: chat docked in the activity-bar view, the agents board and
 * accounts as editor tabs. Every panel loads the SAME built app (media/app, the web package's dist) in its
 * local posture; the only difference between them is the `view` the injected env declares. Chat retains its
 * context when hidden — a streaming turn must ride a sidebar switch, exactly as the web app's popped-out
 * panel rides navigation. */

const APP_DIR = "media/app";

const html = (context: vscode.ExtensionContext, webview: vscode.Webview, env: AppEnvironment): string => {
    const distHtml = readFileSync(join(context.extensionPath, APP_DIR, "index.html"), "utf8");
    const assetBase = webview.asWebviewUri(vscode.Uri.file(join(context.extensionPath, APP_DIR))).toString();
    return appHtml({ distHtml, assetBase, nonce: randomBytes(16).toString("base64url"), env });
};

const workspaceLabel = (): string => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder === undefined ? "This machine" : basename(folder.uri.fsPath);
};

const webviewOptions = (context: vscode.ExtensionContext): vscode.WebviewOptions => ({
    enableScripts: true,
    localResourceRoots: [vscode.Uri.file(join(context.extensionPath, APP_DIR))],
});

export interface Panels {
    readonly postTheme: (theme: unknown) => void;
    readonly openArea: (view: "agents" | "accounts") => void;
}

export const registerPanels = (context: vscode.ExtensionContext, engineUrl: () => string | undefined, initialTheme: () => unknown): Panels => {
    const live = new Set<vscode.Webview>();

    const environment = (view: AppEnvironment["view"]): AppEnvironment | undefined => {
        const url = engineUrl();
        if (url === undefined) {
            return undefined;
        }
        return { engineUrl: url, view, label: workspaceLabel(), theme: initialTheme() };
    };

    const track = (webview: vscode.Webview, dispose: { onDidDispose: (listener: () => void) => void }): void => {
        live.add(webview);
        dispose.onDidDispose(() => live.delete(webview));
    };

    // Chat: the activity-bar view, resolved by the editor whenever the user opens the container. Its badge is
    // the attention count — visible even while the panel itself is hidden behind the editor's own work.
    let chatView: vscode.WebviewView | undefined;
    const badge = (count: number): void => {
        if (chatView !== undefined) {
            chatView.badge = count === 0 ? undefined : { value: count, tooltip: count === 1 ? "1 agent needs you" : `${count} agents need you` };
        }
    };
    const provider: vscode.WebviewViewProvider = {
        resolveWebviewView: (view) => {
            chatView = view;
            const env = environment("chat");
            view.webview.options = webviewOptions(context);
            view.webview.html =
                env === undefined
                    ? `<html><body><p>The Intentic engine is not running — open a folder, or run "Intentic: Restart Engine".</p></body></html>`
                    : html(context, view.webview, env);
            track(view.webview, view);
            view.webview.onDidReceiveMessage((message: unknown) => onBridgeMessage(message, badge));
            view.onDidDispose(() => {
                chatView = undefined;
            });
        },
    };
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider("intentic.chat", provider, { webviewOptions: { retainContextWhenHidden: true } }),
    );

    // Board and accounts: editor tabs, one panel each, revealed rather than duplicated on a second open.
    const open = new Map<string, vscode.WebviewPanel>();
    const openArea = (view: "agents" | "accounts"): void => {
        const existing = open.get(view);
        if (existing !== undefined) {
            existing.reveal();
            return;
        }
        const env = environment(view);
        if (env === undefined) {
            void vscode.window.showWarningMessage("The Intentic engine is not running — open a folder first.");
            return;
        }
        const title = view === "agents" ? "Intentic Agents" : "Intentic Accounts";
        const panel = vscode.window.createWebviewPanel(`intentic.${view}`, title, vscode.ViewColumn.Active, {
            ...webviewOptions(context),
            retainContextWhenHidden: true,
        });
        panel.webview.html = html(context, panel.webview, env);
        open.set(view, panel);
        track(panel.webview, panel);
        panel.webview.onDidReceiveMessage((message: unknown) => onBridgeMessage(message, badge));
        panel.onDidDispose(() => open.delete(view));
    };

    return {
        // The live-theme half of the app's host channel (the web app's local/hostTheme.ts).
        postTheme: (theme: unknown) => {
            for (const webview of live) {
                void webview.postMessage({ type: "intentic:theme", theme });
            }
        },
        openArea,
    };
};
