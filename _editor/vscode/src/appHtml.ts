/* The webview document, derived from the app's own built index.html — PURE, so it is testable without an
 * editor. The web build is the single source of what scripts/styles the app needs (hashed filenames change
 * every build); this rewrites those references onto the webview's resource scheme and replaces the deployed
 * env.js with an inline declaration of the LOCAL posture (environments/posture.ts in the web app): which
 * engine to talk to, which of the three areas this panel shows, and the host's initial theme document.
 *
 * The CSP is the panel's whole outbound surface, written explicitly rather than inherited: scripts and styles
 * only from the extension's own assets (plus the one nonce'd inline env script), connections only to the
 * loopback engine — which must allow http: because the engine serves plain HTTP on 127.0.0.1, a spelling
 * webview roots never cover. */
export interface AppEnvironment {
    readonly engineUrl: string;
    readonly view: "chat" | "agents" | "accounts";
    readonly label: string;
    readonly theme?: unknown;
}

export interface AppHtmlParams {
    // The web build's index.html, verbatim.
    readonly distHtml: string;
    // What the webview turns the dist folder into (webview.asWebviewUri(...)), no trailing slash.
    readonly assetBase: string;
    // Per-document random nonce for the inline env script (the host supplies randomness; this stays pure).
    readonly nonce: string;
    readonly env: AppEnvironment;
}

const envScript = (env: AppEnvironment, nonce: string): string => {
    const local = { engineUrl: env.engineUrl, view: env.view, label: env.label, ...(env.theme === undefined ? {} : { theme: env.theme }) };
    const declaration = {
        production: true,
        api: { url: "" },
        auth: { googleClientId: "" },
        analytics: { posthogKey: "", posthogHost: "" },
        local,
    };
    // </script> inside a theme string would end the block early; the escape keeps the document intact.
    const json = JSON.stringify(declaration).replaceAll("</", "<\\/");
    /* The bridge bootstrap is the ONE place editor-specific API touches the app's world: the app's generic
     * `window.intenticHost.post(...)` contract (its local/hostBridge.ts) is wired to this webview's message
     * channel here, in extension-owned injected code — the app itself stays host-agnostic. Guarded: on the
     * dev server there is no acquireVsCodeApi and no bridge, and every post is the app's silent no-op. */
    const bridge =
        `if (typeof acquireVsCodeApi === "function") {` +
        ` const api = acquireVsCodeApi();` +
        ` window.intenticHost = { post: (message) => api.postMessage(message) };` +
        ` }`;
    return `<script nonce="${nonce}">window.env = ${json};\n${bridge}</script>`;
};

export const appHtml = ({ distHtml, assetBase, nonce, env }: AppHtmlParams): string => {
    const csp = [
        `default-src 'none'`,
        `img-src ${assetBase} ${env.engineUrl} data: blob:`,
        `media-src ${assetBase} ${env.engineUrl} blob:`,
        `script-src ${assetBase} 'nonce-${nonce}'`,
        `style-src ${assetBase} 'unsafe-inline'`,
        `font-src ${assetBase}`,
        `connect-src ${env.engineUrl} ${assetBase}`,
        `worker-src blob:`,
    ].join("; ");
    return (
        distHtml
            // Root-absolute asset references (the app builds under base "/") move onto the webview scheme.
            .replaceAll(`src="/`, `src="${assetBase}/`)
            .replaceAll(`href="/`, `href="${assetBase}/`)
            // The deployment env script is REPLACED, not accompanied — two window.env writers would race.
            .replace(/<script[^>]*\/assets\/js\/env\.js[^>]*><\/script>/, envScript(env, nonce))
            .replace(`<head>`, `<head>\n<meta http-equiv="Content-Security-Policy" content="${csp}">`)
    );
};
