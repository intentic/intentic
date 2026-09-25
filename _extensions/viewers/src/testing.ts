import type { WorkerCallRequest, WorkerCallResponse, WorkerPort } from "@intentic/extension-ui/worker";
import { strToU8, zipSync } from "fflate";

// Fixture builder: the smallest Word document docx-preview accepts, built in code rather than committed as a binary,
// so what a test compares is reviewable in a diff. The same rule fileq's fixtures follow.

const xmlEscape = (text: string): string => text.replaceAll(`&`, `&amp;`).replaceAll(`<`, `&lt;`).replaceAll(`>`, `&gt;`);

/** One run of a paragraph: its text and whether it is bold, the one property the fixtures need to tell runs apart. */
export interface FixtureRun {
    readonly text: string;
    readonly bold?: boolean;
}

/** One paragraph: runs, or a string for one plain run; `style` names a paragraph style the document defines. */
export type FixtureParagraph = string | { readonly runs: readonly FixtureRun[]; readonly style?: string };

const runXml = (run: FixtureRun): string => `<w:r>${run.bold === true ? `<w:rPr><w:b/></w:rPr>` : ``}<w:t xml:space="preserve">${xmlEscape(run.text)}</w:t></w:r>`;

const paragraphXml = (paragraph: FixtureParagraph): string => {
    const { runs, style } = typeof paragraph === `string` ? { runs: [{ text: paragraph }] } : paragraph;
    return `<w:p>${style === undefined ? `` : `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>`}${runs.map(runXml).join(``)}</w:p>`;
};

// A4 with 1-inch margins, so the page is a shape a word processor would have made.
const SECTION = `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>`;

const STYLES = `<?xml version="1.0" encoding="UTF-8"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="36"/></w:rPr></w:style>
</w:styles>`;

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;

const PACKAGE_RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

const DOCUMENT_RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

/** A Word document with these paragraphs, as the bytes a viewer parses. */
export const docxBytes = (paragraphs: readonly FixtureParagraph[]): Uint8Array =>
    zipSync({
        "[Content_Types].xml": strToU8(CONTENT_TYPES),
        "_rels/.rels": strToU8(PACKAGE_RELS),
        "word/_rels/document.xml.rels": strToU8(DOCUMENT_RELS),
        "word/styles.xml": strToU8(STYLES),
        "word/document.xml": strToU8(
            `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs.map(paragraphXml).join(``)}${SECTION}</w:body></w:document>`,
        ),
    });

/** A worker stand-in the viewers' suites share: answers each call with `answer` a microtask later, or dies when it says
 * `crash`. `sent` and `transferred` record what the page posted; `terminated` whether it was ended. */
export const fakeWorkerPort = <Args, Result>(
    answer: (request: WorkerCallRequest<Args>) => WorkerCallResponse<Result> | `crash`,
): WorkerPort<Args, Result> & { readonly sent: WorkerCallRequest<Args>[]; readonly transferred: (Transferable[] | undefined)[]; terminated: boolean } => {
    const listeners: { message?: (event: MessageEvent<WorkerCallResponse<Result>>) => void; error?: (event: ErrorEvent) => void } = {};
    return {
        sent: [],
        transferred: [],
        terminated: false,
        postMessage(request, transfer) {
            this.sent.push(request);
            this.transferred.push(transfer);
            queueMicrotask(() => {
                const reply = answer(request);
                if (reply === `crash`) {
                    listeners.error?.({ message: `worker died` } as ErrorEvent);
                } else {
                    listeners.message?.({ data: reply } as MessageEvent<WorkerCallResponse<Result>>);
                }
            });
        },
        addEventListener: ((type: `message` | `error`, listener: never) => {
            listeners[type] = listener;
        }) as WorkerPort<Args, Result>[`addEventListener`],
        terminate() {
            this.terminated = true;
        },
    };
};
