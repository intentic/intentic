import type { DocumentType } from "../formats.js";
import { signJwt } from "./jwt.js";
import type { Session } from "./sessions.js";

// The page the app frames: the document server's api.js from the same origin (this listener proxies it), and one
// signed editor config. The frame's own document, so the app's script-src never sees the editor's code.

export interface EditorConfigInput {
    readonly session: Session;
    readonly documentType: DocumentType;
    readonly fileType: string;
    readonly title: string;
    // Both reachable from the document server, not the browser: it fetches the one and posts saves to the other.
    readonly documentUrl: string;
    readonly callbackUrl: string;
    readonly secret: string;
}

// The config ONLYOFFICE's DocEditor takes, signed: `token` is the JWT over everything else in it.
export const editorConfig = (input: EditorConfigInput): Record<string, unknown> => {
    const editing = input.session.mode === "edit";
    const config: Record<string, unknown> = {
        type: "desktop",
        width: "100%",
        height: "100%",
        documentType: input.documentType,
        document: {
            fileType: input.fileType,
            key: input.session.key,
            title: input.title,
            url: input.documentUrl,
            permissions: { edit: editing, review: editing, comment: editing, fillForms: editing, download: true, print: true },
        },
        editorConfig: {
            callbackUrl: input.callbackUrl,
            mode: input.session.mode,
            lang: "en",
            user: { id: "owner", name: "Owner" },
            customization: {
                // Ctrl+S writes to the workspace at once, rather than when the last editor closes.
                forcesave: true,
                autosave: true,
                compactHeader: true,
                feedback: false,
                help: false,
                uiTheme: input.session.theme === "dark" ? "theme-dark" : "theme-light",
            },
        },
    };
    return { ...config, token: signJwt(config, input.secret) };
};

const escapeHtml = (text: string): string =>
    text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

// JSON inside a <script>: `<` escaped so no document title can close the tag.
const scriptJson = (value: unknown): string => JSON.stringify(value).replaceAll("<", "\\u003c");

export const hostPage = (config: Record<string, unknown>, title: string, theme: "light" | "dark"): string => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>html,body,#placeholder{margin:0;height:100%;width:100%;overflow:hidden;background:${theme === "dark" ? "#333333" : "#ffffff"}}#note{font:14px system-ui,sans-serif;color:#888;padding:24px}</style>
</head>
<body>
<div id="placeholder"></div>
<script src="/web-apps/apps/api/documents/api.js"></script>
<script>
(function () {
    var config = ${scriptJson(config)};
    if (!window.DocsAPI) {
        document.body.innerHTML = '<p id="note">The document server did not answer. Close this file and open it again.</p>';
        return;
    }
    new window.DocsAPI.DocEditor("placeholder", config);
})();
</script>
</body>
</html>
`;

export const endedPage = (): string => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Session ended</title></head>
<body style="font:14px system-ui,sans-serif;color:#888;padding:24px">This editor session has ended. Close this file and open it again.</body></html>
`;
