import { expect, test } from "vitest";
import { appHtml } from "./appHtml.js";

const DIST_HTML = `<!doctype html>
<html>
<head>
<script src="/assets/js/env.js"></script>
<script type="module" crossorigin src="/assets/index-CAfe12.js"></script>
<link rel="stylesheet" crossorigin href="/assets/index-Bee4.css">
</head>
<body><div id="app"></div></body>
</html>`;

const PARAMS = {
    distHtml: DIST_HTML,
    assetBase: "vscode-resource://ext/media/app",
    nonce: "n0nce",
    env: { engineUrl: "http://127.0.0.1:8890", view: "chat" as const, label: "my-project" },
};

test("asset references move onto the webview scheme, and the deployed env script is replaced whole", () => {
    const html = appHtml(PARAMS);
    expect(html).toContain(`src="vscode-resource://ext/media/app/assets/index-CAfe12.js"`);
    expect(html).toContain(`href="vscode-resource://ext/media/app/assets/index-Bee4.css"`);
    // One env writer: the inline declaration replaced env.js rather than joining it.
    expect(html).not.toContain(`env.js`);
    expect(html).toContain(`window.env = `);
    expect(html).toContain(`"engineUrl":"http://127.0.0.1:8890"`);
    expect(html).toContain(`"view":"chat"`);
});

test("the CSP admits only the assets and the engine, and the env script carries the nonce", () => {
    const html = appHtml(PARAMS);
    expect(html).toContain(`Content-Security-Policy`);
    expect(html).toContain(`connect-src http://127.0.0.1:8890 vscode-resource://ext/media/app`);
    expect(html).toContain(`script-src vscode-resource://ext/media/app 'nonce-n0nce'`);
    expect(html).toContain(`<script nonce="n0nce">`);
});

test("a theme document rides the env, with script-closing text defused", () => {
    const html = appHtml({ ...PARAMS, env: { ...PARAMS.env, theme: { name: "x</script><script>alert(1)" } } });
    expect(html).toContain(`"theme":`);
    expect(html).not.toContain(`</script><script>alert(1)`);
});

test("the bridge bootstrap wires the app's host contract, guarded for hosts that provide no api", () => {
    const html = appHtml(PARAMS);
    expect(html).toContain(`typeof acquireVsCodeApi === "function"`);
    expect(html).toContain(`window.intenticHost = { post:`);
});
