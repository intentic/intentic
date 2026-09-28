// SPDX-License-Identifier: AGPL-3.0-only
// Ported from ranuts/document lib/onlyoffice/guards/about-source.ts at 1301bb8b (AGPL-3.0); see editor/NOTICE. Changed:
// the notice names this build's two sources, the editor page and the bundle it runs.

// The source offer and the "not an official product" line, added to the editor's own About pane. The pane already
// carries what the ONLYOFFICE terms ask for (product logo, version, copyright). What it cannot carry is what is true of
// this build and not of theirs: that it is a modified version, and where its corresponding source is (AGPL-3.0 section
// 13), and that the mark above is not Intentic's (section 7(e)). Additive only: nothing the vendor renders is touched.

const NOTICE_ID = `oo-source-notice`;
// The About panels already watched: one per editor document.
const watched = new WeakSet<HTMLElement>();

const SOURCES: readonly { readonly label: string; readonly url: string }[] = [
    { label: `Editor page`, url: `https://github.com/intentic/intentic/tree/main/_extensions/onlyoffice/editor` },
    { label: `Editor bundle`, url: `https://github.com/ranuts/document/tree/1301bb8bdac9092c4eb88a6f2f4ff5080cec68bd` },
];

const renderNotice = (doc: Document, panel: HTMLElement): void => {
    // The pane is filled the first time it is opened; until then there is nothing to append to.
    if (panel.children.length === 0 || doc.getElementById(NOTICE_ID) !== null) {
        return;
    }
    const box = doc.createElement(`div`);
    box.id = NOTICE_ID;
    box.style.cssText = `padding:12px 0;font-size:11px;line-height:1.6;opacity:0.75;`;
    const line = doc.createElement(`div`);
    line.textContent =
        `This is a modified version of the ONLYOFFICE editors, running in your browser without a document server. ` +
        `It is not an official ONLYOFFICE product. ONLYOFFICE is a trademark of Ascensio System SIA.`;
    box.append(line);
    for (const source of SOURCES) {
        const row = doc.createElement(`div`);
        row.textContent = `${source.label} source code (AGPL-3.0): `;
        const link = doc.createElement(`a`);
        link.href = source.url;
        link.target = `_blank`;
        link.rel = `noopener noreferrer`;
        link.textContent = source.url;
        row.append(link);
        box.append(row);
    }
    panel.append(box);
};

export const installAboutSourceNotice = (doc: Document): boolean => {
    const panel = doc.getElementById(`about-menu-panel`);
    if (panel === null) {
        return false;
    }
    if (watched.has(panel)) {
        return true;
    }
    watched.add(panel);
    renderNotice(doc, panel);
    const View = doc.defaultView?.MutationObserver;
    if (View !== undefined) {
        new View(() => renderNotice(doc, panel)).observe(panel, { childList: true });
    }
    return true;
};
