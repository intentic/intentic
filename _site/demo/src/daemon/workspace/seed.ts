import { deskEdition, freshEdition } from "../../mode";
import { workspaceEntries } from "../../fixture/workspace";

// The shop's static pages: what the storefront shows while the API is down, with its stylesheet and picture beside it,
// so a preview of a web page has a page whose addresses resolve to real files next to it.

const OFFLINE_HTML = `<!doctype html>
<html lang="en">
<head>
    <meta charset="utf-8" />
    <title>Acme Shop · back soon</title>
    <link rel="stylesheet" href="offline.css" />
</head>
<body>
    <main>
        <img src="logo.svg" alt="Acme" width="96" />
        <h1>We'll be right back</h1>
        <p>The shop is being updated. Your basket is saved; nothing you added is lost.</p>
        <p><a href="mailto:help@acme.dev">help@acme.dev</a></p>
    </main>
</body>
</html>
`;

const OFFLINE_CSS = `body {
    margin: 0;
    min-height: 100vh;
    display: grid;
    place-items: center;
    font: 16px/1.5 system-ui, sans-serif;
    color: #1c1917;
    background: #fafaf9;
}
main {
    max-width: 28rem;
    text-align: center;
}
h1 {
    color: #c2410c;
}
`;

const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><rect width="96" height="96" rx="20" fill="#c2410c"/><path d="M28 70 48 24l20 46M35 54h26" stroke="#fff" stroke-width="8" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
`;

/** Seeds the pages into the shop's tree; a desk and a fresh sandbox have none. Keeps a file already there. */
export const seedPages = (): void => {
    if (deskEdition || freshEdition) {
        return;
    }
    const table = workspaceEntries();
    for (const [path, body] of [
        [`web/public/offline.html`, OFFLINE_HTML],
        [`web/public/offline.css`, OFFLINE_CSS],
        [`web/public/logo.svg`, LOGO_SVG],
    ] as const) {
        if (!table.has(path)) {
            table.set(path, body);
        }
    }
};
