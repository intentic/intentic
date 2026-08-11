import * as vscode from "vscode";
import { startEngine, type Engine } from "./engine.js";
import { registerPanels } from "./panels.js";
import { activeThemeDocument, watchTheme } from "./theme.js";

/* ACTIVATION: start the engine over this window's folder, host the three surfaces, keep their look on the
 * editor's theme. Deactivation kills the engine — agents pause with the window, by design (the engine's own
 * registry and resume schedulers make reopening land where things stood). */

let engine: Engine | undefined;

const boot = async (context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (folder === undefined) {
        output.appendLine("intentic: no folder open — the engine starts when one is.");
        return;
    }
    engine = await startEngine(context, folder.uri.fsPath, output);
    output.appendLine(`intentic: engine ready at ${engine.url} over ${folder.uri.fsPath}`);
};

export const activate = async (context: vscode.ExtensionContext): Promise<void> => {
    const output = vscode.window.createOutputChannel("Intentic Engine");
    context.subscriptions.push(output);

    const panels = registerPanels(
        context,
        () => engine?.url,
        () => activeThemeDocument(),
    );
    watchTheme(context, (theme) => panels.postTheme(theme));

    context.subscriptions.push(
        vscode.commands.registerCommand("intentic.openAgents", () => panels.openArea("agents")),
        vscode.commands.registerCommand("intentic.openAccounts", () => panels.openArea("accounts")),
        vscode.commands.registerCommand("intentic.restartEngine", async () => {
            engine?.dispose();
            engine = undefined;
            await boot(context, output);
            void vscode.window.showInformationMessage("Intentic engine restarted.");
        }),
    );

    try {
        await boot(context, output);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        output.appendLine(`intentic: engine failed to start — ${message}`);
        void vscode.window.showErrorMessage(`Intentic could not start its engine: ${message}`);
    }
};

export const deactivate = (): void => {
    engine?.dispose();
    engine = undefined;
};
