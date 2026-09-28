import { CONFIG_ELEMENT_ID, type EditorPageConfig } from "../protocol.js";
import { escapeHtml, scriptJson } from "./host-page.js";

// The page the app frames for a browser-engine session: the bundle's api.js, this extension's editor page script, and
// the config the script reads. Served on the listener's origin, like the document server's page, so none of the
// editor's code runs on the app's.

export interface BrowserPageInput {
    readonly config: EditorPageConfig;
    // Where the verified bundle and the page build are served: "/bundle/<pin>/", "/page/<hash>/".
    readonly bundlePath: string;
    readonly pagePath: string;
}

export const browserPage = ({ config, bundlePath, pagePath }: BrowserPageInput): string => `<!doctype html>
<html lang="${escapeHtml(config.lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(config.title)}</title>
<style>html,body,#placeholder{margin:0;height:100%;width:100%;overflow:hidden;background:${config.theme === "dark" ? "#333333" : "#ffffff"}}#note{font:14px system-ui,sans-serif;color:#888;padding:24px}</style>
</head>
<body>
<div id="placeholder"></div>
<script id="${CONFIG_ELEMENT_ID}" type="application/json">${scriptJson(config)}</script>
<script src="${escapeHtml(bundlePath)}web-apps/apps/api/documents/api.js"></script>
<script src="${escapeHtml(pagePath)}editor.js"></script>
</body>
</html>
`;
