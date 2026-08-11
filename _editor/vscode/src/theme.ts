import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as vscode from "vscode";
import { jsoncParse } from "./jsonc.js";

/* THE ACTIVE COLOR THEME, AS A DOCUMENT — what the app's theme bridge takes (the web package's
 * local/hostTheme.ts → its VSCode-theme mapper). The extension API exposes only the theme's KIND
 * (light/dark), never its colors, so the document is read the way the editor itself finds it: the
 * `workbench.colorTheme` label, matched against every installed extension's contributed themes, that
 * contribution's JSON loaded with its `include` chain folded in (base themes split their colors across
 * files). Anything unreadable degrades to undefined — the panels then simply keep the app's own look. */

interface ThemeContribution {
    readonly label?: string;
    readonly id?: string;
    readonly path?: string;
    readonly uiTheme?: string;
}

const contributionFor = (label: string): { contribution: ThemeContribution; extensionPath: string } | undefined => {
    for (const extension of vscode.extensions.all) {
        const contributed = (extension.packageJSON as { contributes?: { themes?: ThemeContribution[] } }).contributes?.themes ?? [];
        for (const theme of contributed) {
            if (theme.id === label || theme.label === label) {
                return { contribution: theme, extensionPath: extension.extensionPath };
            }
        }
    }
    return undefined;
};

// Fold a theme file's `include` chain, nearest-wins for colors — the merge the editor performs itself.
const loadThemeFile = (path: string, depth = 0): Record<string, unknown> => {
    if (depth > 4) {
        return {};
    }
    const parsed = jsoncParse(readFileSync(path, "utf8"));
    const document = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    const include = document["include"];
    if (typeof include !== "string") {
        return document;
    }
    const base = loadThemeFile(join(dirname(path), include), depth + 1);
    return {
        ...base,
        ...document,
        colors: { ...(base["colors"] as object | undefined), ...(document["colors"] as object | undefined) },
        tokenColors: [
            ...(Array.isArray(base["tokenColors"]) ? (base["tokenColors"] as unknown[]) : []),
            ...(Array.isArray(document["tokenColors"]) ? (document["tokenColors"] as unknown[]) : []),
        ],
    };
};

export const activeThemeDocument = (): unknown => {
    try {
        const label = vscode.workspace.getConfiguration("workbench").get<string>("colorTheme");
        if (label === undefined || label === "") {
            return undefined;
        }
        const found = contributionFor(label);
        if (found?.contribution.path === undefined) {
            return undefined;
        }
        const document = loadThemeFile(join(found.extensionPath, found.contribution.path));
        // The mapper reads `type` for the mode; a document that omits it gets the editor's own verdict.
        if (document["type"] === undefined) {
            const kind = vscode.window.activeColorTheme.kind;
            document["type"] = kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight ? "light" : "dark";
        }
        return document;
    } catch {
        return undefined;
    }
};

// Fires with the fresh document whenever the user switches themes — the live half of the bridge.
export const watchTheme = (context: vscode.ExtensionContext, onChange: (theme: unknown) => void): void => {
    context.subscriptions.push(vscode.window.onDidChangeActiveColorTheme(() => onChange(activeThemeDocument())));
};
