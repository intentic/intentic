import { freshImport } from "@intentic/testing/bun";

// What the workspace's page tells the app about the sandbox it shows (desktopShown.ts): the link the app's folder setup
// waits on before it calls a folder ready, once per sandbox, and nothing at all outside the app.

const load = async (inApp: boolean): Promise<{ readonly announce: (id: string) => void; readonly sent: string[] }> => {
    const sent: string[] = [];
    // The page's globals as the module reads them: the app's mark on its window, a loaded document, and where links go.
    Object.assign(globalThis, {
        window: inApp ? { __INTENTIC_DESKTOP__: { version: `1.350.0`, installId: `i`, update: null } } : {},
        document: { readyState: `complete` },
        location: {
            set href(link: string) {
                sent.push(link);
            },
        },
    });
    const { announceWorkspaceShown } = await freshImport<typeof import("./desktopShown")>("./desktopShown", import.meta.url);
    return { announce: announceWorkspaceShown, sent };
};

test(`the page says once which sandbox it shows, and again when it comes to show another`, async () => {
    const { announce, sent } = await load(true);
    announce(`cmvjklu9p000201oznem6o5e3`);
    announce(`cmvjklu9p000201oznem6o5e3`);
    await new Promise((resolve) => setTimeout(resolve, 400));
    announce(`other`);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(sent).toEqual([`intentic://window?do=shown&sandbox=cmvjklu9p000201oznem6o5e3`, `intentic://window?do=shown&sandbox=other`]);
});

test(`a page outside the app says nothing`, async () => {
    const { announce, sent } = await load(false);
    announce(`cmvjklu9p000201oznem6o5e3`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sent).toEqual([]);
});
