import type { ComplianceDocument, ComplianceDocumentKind, ComplianceLanguage, ComplianceReport } from "@intentic/sandbox-contract/schemas/compliance";
import { demoComplianceReport } from "./compliance";

// The data protection page's three drafts (the record of processing, the impact assessment, the measures), written from
// the same report the page draws, in Polish or English, as Markdown or as a Word document, the way the daemon drafts
// them (src/compliance/documents/). Drafts for the owner to complete, never a finished legal text.

const WORDS = {
    en: {
        ropa: `Record of processing activities`,
        dpia: `Data protection impact assessment (draft)`,
        toms: `Technical and organisational measures`,
        controller: `Controller: Acme Shop, ada@acme.dev`,
        system: `System: the acme-shop sandbox on Intentic`,
        draft: `A draft written from the sandbox's configuration. Complete and check it before relying on it.`,
        recipient: `Recipient`,
        operator: `Operator`,
        region: `Region`,
        transfer: `Transfer outside the EEA`,
        personal: `Personal data`,
        measure: `Measure`,
        status: `Status`,
        risks: `Risks to the people concerned`,
        risk: `Personal data in prompts and files reaches model providers outside the EEA while the privacy shield is off.`,
        yes: `yes`,
        no: `no`,
    },
    pl: {
        ropa: `Rejestr czynności przetwarzania`,
        dpia: `Ocena skutków dla ochrony danych (projekt)`,
        toms: `Środki techniczne i organizacyjne`,
        controller: `Administrator: Acme Shop, ada@acme.dev`,
        system: `System: piaskownica acme-shop w Intentic`,
        draft: `Projekt sporządzony na podstawie konfiguracji piaskownicy. Uzupełnij go i sprawdź przed użyciem.`,
        recipient: `Odbiorca`,
        operator: `Podmiot`,
        region: `Region`,
        transfer: `Przekazanie poza EOG`,
        personal: `Dane osobowe`,
        measure: `Środek`,
        status: `Stan`,
        risks: `Ryzyka dla osób, których dane dotyczą`,
        risk: `Dane osobowe w poleceniach i plikach trafiają do dostawców modeli spoza EOG, gdy osłona prywatności jest wyłączona.`,
        yes: `tak`,
        no: `nie`,
    },
} as const;

const flowTable = (report: ComplianceReport, words: (typeof WORDS)[ComplianceLanguage]): string[] => [
    `| ${words.recipient} | ${words.operator} | ${words.region} | ${words.transfer} | ${words.personal} |`,
    `| --- | --- | --- | --- | --- |`,
    ...report.flows
        .filter((flow) => flow.active)
        .map((flow) => `| ${flow.name} | ${flow.operator ?? `-`} | ${flow.region ?? `-`} | ${flow.thirdCountry === true ? words.yes : words.no} | ${flow.personalData} |`),
];

const measureTable = (report: ComplianceReport, words: (typeof WORDS)[ComplianceLanguage]): string[] => [
    `| ${words.measure} | ${words.status} |`,
    `| --- | --- |`,
    ...report.measures.map((measure) => `| ${measure.id} | ${measure.status} |`),
];

const markdownOf = (kind: ComplianceDocumentKind, language: ComplianceLanguage, report: ComplianceReport): string => {
    const words = WORDS[language];
    const body =
        kind === `toms` ? measureTable(report, words) : kind === `dpia` ? [`## ${words.risks}`, ``, `- ${words.risk}`, ``, ...flowTable(report, words)] : flowTable(report, words);
    return [`# ${words[kind]}`, ``, `> ${words.draft}`, ``, words.controller, ``, words.system, ``, ...body, ``].join(`\n`);
};

// A Word document is a zip of three XML parts; stored, not deflated, which every reader opens.
const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
    let crc = index;
    for (let bit = 0; bit < 8; bit += 1) {
        crc = crc & 1 ? 0xed_b8_83_20 ^ (crc >>> 1) : crc >>> 1;
    }
    return crc >>> 0;
});
const crc32 = (bytes: Uint8Array): number => {
    let crc = 0xff_ff_ff_ff;
    for (const byte of bytes) {
        crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
    }
    return (crc ^ 0xff_ff_ff_ff) >>> 0;
};

const zipOf = (files: readonly (readonly [string, string])[]): Uint8Array => {
    const encoder = new TextEncoder();
    const locals: Uint8Array[] = [];
    const centrals: Uint8Array[] = [];
    let offset = 0;
    for (const [name, text] of files) {
        const path = encoder.encode(name);
        const data = encoder.encode(text);
        const crc = crc32(data);
        const local = new DataView(new ArrayBuffer(30));
        [[0, 0x04_03_4b_50, 4], [4, 20, 2], [14, crc, 4], [18, data.length, 4], [22, data.length, 4], [26, path.length, 2]].forEach(([at = 0, value = 0, size]) =>
            size === 4 ? local.setUint32(at, value, true) : local.setUint16(at, value, true),
        );
        const central = new DataView(new ArrayBuffer(46));
        [[0, 0x02_01_4b_50, 4], [4, 20, 2], [6, 20, 2], [16, crc, 4], [20, data.length, 4], [24, data.length, 4], [28, path.length, 2], [42, offset, 4]].forEach(
            ([at = 0, value = 0, size]) => (size === 4 ? central.setUint32(at, value, true) : central.setUint16(at, value, true)),
        );
        locals.push(new Uint8Array(local.buffer), path, data);
        centrals.push(new Uint8Array(central.buffer), path);
        offset += 30 + path.length + data.length;
    }
    const size = centrals.reduce((sum, part) => sum + part.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06_05_4b_50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, size, true);
    end.setUint32(16, offset, true);
    const parts = [...locals, ...centrals, new Uint8Array(end.buffer)];
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
};

const escaped = (text: string): string => text.replaceAll(`&`, `&amp;`).replaceAll(`<`, `&lt;`).replaceAll(`>`, `&gt;`);

// One paragraph per Markdown line: enough for a draft somebody will edit in Word anyway.
const docxOf = (markdown: string): string => {
    const paragraphs = markdown
        .split(`\n`)
        .map((line) => `<w:p><w:r><w:t xml:space="preserve">${escaped(line.replace(/^#+ /u, ``))}</w:t></w:r></w:p>`)
        .join(``);
    const zip = zipOf([
        [
            `[Content_Types].xml`,
            `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
        ],
        [
            `_rels/.rels`,
            `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
        ],
        [
            `word/document.xml`,
            `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}</w:body></w:document>`,
        ],
    ]);
    return btoa(Array.from(zip, (byte) => String.fromCodePoint(byte)).join(``));
};

/** GET /compliance/document: one draft, in the asked language and format. */
export const demoComplianceDocument = (kind: ComplianceDocumentKind, language: ComplianceLanguage, format: `md` | `docx`): ComplianceDocument => {
    const markdown = markdownOf(kind, language, demoComplianceReport());
    const filename = `acme-shop-${kind}-${language}.${format}`;
    return format === `md`
        ? { filename, mediaType: `text/markdown`, encoding: `utf8`, content: markdown }
        : { filename, mediaType: `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, encoding: `base64`, content: docxOf(markdown) };
};
