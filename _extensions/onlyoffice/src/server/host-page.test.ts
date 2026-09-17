import { describe, expect, it } from "vitest";
import { editorConfig, hostPage } from "./host-page.js";
import { verifyJwt } from "./jwt.js";
import type { Session } from "./sessions.js";

const session = (mode: `edit` | `view`): Session => ({
    token: `t`,
    key: `k`,
    path: `docs/<brief>.docx`,
    agent: undefined,
    mode,
    theme: `dark`,
    expiresAt: 0,
});

const input = (mode: `edit` | `view`): Parameters<typeof editorConfig>[0] => ({
    session: session(mode),
    documentType: `word`,
    fileType: `docx`,
    title: `<brief>.docx`,
    documentUrl: `http://host.docker.internal:1/doc/k`,
    callbackUrl: `http://host.docker.internal:1/callback/k`,
    secret: `s`,
});

describe(`editor config`, () => {
    it(`is signed over everything but the token itself`, () => {
        const config = editorConfig(input(`edit`));
        const { token, ...rest } = config;
        expect(verifyJwt(token as string, `s`)).toEqual(rest);
        expect(verifyJwt(token as string, `other`)).toBeUndefined();
    });

    it(`grants editing only to an edit session, and saves on Ctrl+S`, () => {
        expect(editorConfig(input(`edit`))).toMatchObject({
            documentType: `word`,
            document: { key: `k`, fileType: `docx`, permissions: { edit: true, download: true } },
            editorConfig: {
                mode: `edit`,
                callbackUrl: `http://host.docker.internal:1/callback/k`,
                customization: { forcesave: true, uiTheme: `theme-dark` },
            },
        });
        expect(editorConfig(input(`view`))).toMatchObject({
            document: { permissions: { edit: false, review: false } },
            editorConfig: { mode: `view` },
        });
    });
});

describe(`host page`, () => {
    it(`loads api.js from its own origin and hands the config to DocEditor with no way to close the script`, () => {
        const page = hostPage({ document: { title: `</script><script>alert(1)</script>` } }, `</title><b>x</b>`, `light`);
        expect(page).toContain(`<script src="/web-apps/apps/api/documents/api.js"></script>`);
        expect(page).toContain(`new window.DocsAPI.DocEditor("placeholder", config)`);
        expect(page).not.toContain(`</script><script>alert`);
        expect(page).toContain(`\\u003c/script>\\u003cscript>alert(1)`);
        expect(page).toContain(`<title>&lt;/title&gt;&lt;b&gt;x&lt;/b&gt;</title>`);
    });

    it(`paints the frame in the editor's own theme before api.js arrives`, () => {
        expect(hostPage({}, `t`, `dark`)).toContain(`background:#333333`);
        expect(hostPage({}, `t`, `light`)).toContain(`background:#ffffff`);
    });
});
