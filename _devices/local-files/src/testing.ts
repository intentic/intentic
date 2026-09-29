import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import type { LocalOffice } from "@intentic/ext-onlyoffice/local-office";
import { unstubbed } from "@intentic/testing";
import { DerivedTexts } from "./derived.js";
import type { Grants } from "./grants.js";
import { createLocalFilesServer, type LocalFilesServer, type ServerDeps } from "./server.js";
import type { Ask as AppAsk } from "./tree-verbs.js";
import { Watches } from "./watch.js";

// The HTTP face stood up the way cli.ts stands it up, for suites that drive it as the editor does, and the documents
// its quick look reads, built in code so a fixture's content reads in a diff.

export const PORT = 47001;
export const APP = `tauri://localhost`;

// Office routes are the extension's own (onlyoffice/src/server/local-office.ts); all a suite here reaches of it is the
// release of a window's editor when its grant goes.
const office = unstubbed<LocalOffice>(`office`, { release: async () => undefined });

// An app that answers no ask: a suite that deletes stands up its own.
const NO_APP: AppAsk = async () => {
    throw new Error(`no app answers asks in this suite`);
};

export interface LocalServerOverrides {
    readonly writeCap?: ServerDeps[`writeCap`];
    // What the app answers when asked to move something to the trash.
    readonly ask?: AppAsk;
    // Where documents' text is kept; a suite that renders one names its own temp dir.
    readonly derived?: DerivedTexts;
}

export const localServer = (grants: Grants, overrides: LocalServerOverrides = {}): LocalFilesServer =>
    createLocalFilesServer({
        grants,
        office,
        context: {
            watches: new Watches(() => undefined),
            build: `test`,
            startedAt: 0,
            ask: overrides.ask ?? NO_APP,
            derived: overrides.derived ?? new DerivedTexts({ dir: join(tmpdir(), `local-files-derived-unused`), log: () => undefined }),
        },
        origins: new Set([APP]),
        log: () => undefined,
        writeCap: overrides.writeCap,
    });

export interface Ask extends RequestInit {
    readonly token?: string;
    readonly host?: string;
    readonly origin?: string;
}

// A request as a window's editor sends it: to this port, with the window's bearer and page origin when given.
export const askerOf =
    (server: LocalFilesServer) =>
    (path: string, init: Ask = {}): Promise<Response> => {
        const headers = new Headers(init.headers);
        headers.set(`host`, init.host ?? `127.0.0.1:${PORT}`);
        if (init.token !== undefined) {
            headers.set(`authorization`, `Bearer ${init.token}`);
        }
        if (init.origin !== undefined) {
            headers.set(`origin`, init.origin);
        }
        return server.fetch(new Request(`http://127.0.0.1:${PORT}${path}`, { ...init, headers }), PORT);
    };

// A zip of `files`, stored rather than deflated: every reader takes one, and it needs nothing but a checksum.
export const zipOf = (files: Readonly<Record<string, string>>): Uint8Array => {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const [name, text] of Object.entries(files)) {
        const path = Buffer.from(name, `utf8`);
        const data = Buffer.from(text, `utf8`);
        const crc = crc32(data);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04_03_4b_50, 0);
        local.writeUInt16LE(20, 4);
        // UTF-8 names.
        local.writeUInt16LE(0x08_00, 6);
        local.writeUInt32LE(crc, 14);
        local.writeUInt32LE(data.length, 18);
        local.writeUInt32LE(data.length, 22);
        local.writeUInt16LE(path.length, 26);
        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02_01_4b_50, 0);
        central.writeUInt16LE(20, 4);
        central.writeUInt16LE(20, 6);
        central.writeUInt16LE(0x08_00, 8);
        central.writeUInt32LE(crc, 16);
        central.writeUInt32LE(data.length, 20);
        central.writeUInt32LE(data.length, 24);
        central.writeUInt16LE(path.length, 28);
        central.writeUInt32LE(offset, 42);
        locals.push(local, path, data);
        centrals.push(central, path);
        offset += local.length + path.length + data.length;
    }
    const directory = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06_05_4b_50, 0);
    end.writeUInt16LE(Object.keys(files).length, 8);
    end.writeUInt16LE(Object.keys(files).length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    return new Uint8Array(Buffer.concat([...locals, directory, end]));
};

const xml = (text: string): string => text.replaceAll(`&`, `&amp;`).replaceAll(`<`, `&lt;`).replaceAll(`>`, `&gt;`);

const PACKAGE_RELS = (target: string): string =>
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="${target}"/></Relationships>`;

const CONTENT_TYPES = (overrides: string): string =>
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${overrides}</Types>`;

// A Word document with one heading and a paragraph per entry.
export const docxOf = (heading: string, paragraphs: readonly string[]): Uint8Array =>
    zipOf({
        "[Content_Types].xml": CONTENT_TYPES(
            `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>`,
        ),
        "_rels/.rels": PACKAGE_RELS(`word/document.xml`),
        "word/document.xml": `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${xml(heading)}</w:t></w:r></w:p>${paragraphs.map((text) => `<w:p><w:r><w:t xml:space="preserve">${xml(text)}</w:t></w:r></w:p>`).join(``)}</w:body></w:document>`,
    });

// A workbook of one sheet, every cell an inline string.
export const xlsxOf = (sheet: string, rows: readonly (readonly string[])[]): Uint8Array =>
    zipOf({
        "[Content_Types].xml": CONTENT_TYPES(
            `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
        ),
        "_rels/.rels": PACKAGE_RELS(`xl/workbook.xml`),
        "xl/workbook.xml": `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xml(sheet)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
        "xl/_rels/workbook.xml.rels": `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>`,
        "xl/worksheets/sheet1.xml": `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows
            .map(
                (cells, row) =>
                    `<row r="${row + 1}">${cells.map((cell, column) => `<c r="${String.fromCodePoint(65 + column)}${row + 1}" t="inlineStr"><is><t>${xml(cell)}</t></is></c>`).join(``)}</row>`,
            )
            .join(``)}</sheetData></worksheet>`,
    });
