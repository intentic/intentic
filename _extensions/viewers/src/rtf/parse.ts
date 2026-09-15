import type { Block, Cell, Inline, Row } from "../odf/document-model";
import type { Css } from "../odf/styles";
import { characterCss, initialStyle, paragraphCss, plainStyle, twips, type RtfStyle } from "./state";
import { asLatin1, tokenize, type RtfToken } from "./tokens";

/* RTF as the same blocks an ODF document produces, so one renderer draws both. */

// Groups whose contents are the file's own bookkeeping rather than the document's text.
const SKIPPED = new Set([
    `stylesheet`,
    `info`,
    `listtable`,
    `listoverridetable`,
    `rsidtbl`,
    `generator`,
    `filetbl`,
    `themedata`,
    `colorschememapping`,
    `datastore`,
    `latentstyles`,
    `xmlnstbl`,
    `pgdsctbl`,
    `revtbl`,
    `panose`,
    `falt`,
    `fname`,
    `atnid`,
    `atnauthor`,
    `annotation`,
    `header`,
    `headerl`,
    `headerr`,
    `headerf`,
    `footer`,
    `footerl`,
    `footerr`,
    `footerf`,
    `pntext`,
    `pn`,
    `object`,
    `objdata`,
    `result`,
    `do`,
    `shp`,
    `shpinst`,
    `nonshppict`,
    `bkmkstart`,
    `bkmkend`,
    `xe`,
    `tc`,
    `mmathPr`,
    `template`,
    `upr`,
]);

// Code page numbers to the encoding labels TextDecoder knows.
const CODE_PAGES: Readonly<Record<string, string>> = {
    "932": `shift_jis`,
    "936": `gbk`,
    "949": `euc-kr`,
    "950": `big5`,
    "1361": `euc-kr`,
    "10000": `macintosh`,
    "65001": `utf-8`,
};

const decoderFor = (codePage: number): TextDecoder => {
    const label = CODE_PAGES[String(codePage)] ?? (codePage >= 1250 && codePage <= 1258 ? `windows-${codePage}` : `windows-1252`);
    try {
        return new TextDecoder(label);
    } catch {
        return new TextDecoder(`windows-1252`);
    }
};

const ALIGN: Readonly<Record<string, string>> = { ql: `left`, qr: `right`, qc: `center`, qj: `justify` };

type Destination = "body" | "fonttbl" | "colortbl" | "pict" | "fldinst" | "skip";

interface Frame {
    style: RtfStyle;
    destination: Destination;
    link?: string;
    /** `\*` was just read: the word that follows names a destination a reader may skip whole if it is unknown. */
    ignorable?: boolean;
}

export type ImageFactory = (bytes: Uint8Array, type: string) => string | undefined;

interface PageSetup {
    width?: number;
    height?: number;
    left?: number;
    right?: number;
    top?: number;
    bottom?: number;
}

interface Builder {
    readonly blocks: Block[];
    inlines: Inline[];
    cellBlocks: Block[];
    cells: Cell[];
    rows: Row[];
    /** Cell right edges of the row being read, and of the table being built; they differ when a new table starts. */
    cellEdges: number[];
    tableEdges?: number[];
    /** Each cell's shading, in the same order as its right edge, and the one being defined. */
    cellShades: (string | undefined)[];
    pendingShade?: string;
    readonly frames: Frame[];
    readonly fonts: Map<number, string>;
    readonly colors: (string | undefined)[];
    codePage: number;
    decoder: TextDecoder;
    bytes: number[];
    /** Characters still to be dropped: the fallback text that follows a \u escape. */
    skip: number;
    fontSlot?: number;
    /** Text of a destination that is read rather than rendered: a font name, a field instruction. */
    collected: string;
    colorParts: { red: number; green: number; blue: number; seen: boolean };
    picture: { hex: string; type?: string; width?: number; height?: number };
    /** Paper size and margins in twips, as \paperw and friends give them. */
    readonly page: PageSetup;
    readonly image: ImageFactory;
}

const top = (builder: Builder): Frame => builder.frames.at(-1) ?? { style: initialStyle(), destination: `body` };

const flushBytes = (builder: Builder): string => {
    if (builder.bytes.length === 0) {
        return ``;
    }
    const text = builder.decoder.decode(new Uint8Array(builder.bytes));
    builder.bytes = [];
    return text;
};

const pushInline = (builder: Builder, inline: Inline): void => {
    const link = top(builder).link;
    builder.inlines.push(link === undefined ? inline : { kind: `link`, href: link, inlines: [inline] });
};

const write = (builder: Builder, text: string): void => {
    if (text === `` || top(builder).style.hidden) {
        return;
    }
    pushInline(builder, { kind: `text`, text, css: characterCss(top(builder).style) });
};

const endParagraph = (builder: Builder, force: boolean): void => {
    const inlines = builder.inlines;
    if (inlines.length === 0 && !force) {
        return;
    }
    builder.inlines = [];
    const paragraph: Block = { kind: `paragraph`, level: 0, css: paragraphCss(top(builder).style), inlines };
    if (top(builder).style.inTable) {
        builder.cellBlocks.push(paragraph);
        return;
    }
    // Text outside a table is what ends one. \pard cannot: writers reset paragraph formatting BETWEEN the rows of
    // a single table, and flushing there would turn every row into a table of its own.
    endRow(builder);
    flushTable(builder);
    builder.blocks.push(paragraph);
};

// A shaded header cell is usually white text on colour; drawn without the colour, its text is white on white.
const endCell = (builder: Builder): void => {
    endParagraph(builder, false);
    const shade = builder.cellShades[builder.cells.length];
    builder.cells.push({ blocks: builder.cellBlocks, css: shade === undefined ? {} : { "background-color": shade }, colspan: 1, rowspan: 1 });
    builder.cellBlocks = [];
};

// Column widths come from the right edge of each cell, which is what RTF records.
const columnsOf = (edges: readonly number[]): string[] =>
    edges.map((edge, index) => twips(Math.max(0, edge - (index === 0 ? 0 : (edges[index - 1] ?? 0)))));

const flushTable = (builder: Builder): void => {
    if (builder.rows.length === 0) {
        return;
    }
    builder.blocks.push({ kind: `table`, columns: columnsOf(builder.tableEdges ?? []), rows: builder.rows, css: {} });
    builder.rows = [];
    builder.tableEdges = undefined;
};

const sameEdges = (left: readonly number[], right: readonly number[]): boolean =>
    left.length === right.length && left.every((edge, index) => edge === right[index]);

// A row whose columns are laid out differently starts a NEW table: two tables one after another share no border,
// and merging them would make one ragged grid out of two good ones.
const endRow = (builder: Builder): void => {
    if (builder.cells.length === 0) {
        return;
    }
    if (builder.rows.length > 0 && !sameEdges(builder.tableEdges ?? [], builder.cellEdges)) {
        flushTable(builder);
    }
    builder.tableEdges ??= [...builder.cellEdges];
    builder.rows.push({ cells: builder.cells, css: {}, header: false });
    builder.cells = [];
};

const HEX_BYTE = 2;

const endPicture = (builder: Builder): void => {
    const { hex, type, width, height } = builder.picture;
    builder.picture = { hex: `` };
    if (type === undefined || hex.length < HEX_BYTE) {
        return;
    }
    const clean = hex.replaceAll(/[^0-9a-fA-F]/g, ``);
    const bytes = new Uint8Array(clean.length / HEX_BYTE);
    for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = Number.parseInt(clean.slice(index * HEX_BYTE, index * HEX_BYTE + HEX_BYTE), 16);
    }
    const src = builder.image(bytes, type);
    if (src === undefined) {
        return;
    }
    const css: Record<string, string> = { "max-width": `100%` };
    if (width !== undefined && width > 0) {
        css[`width`] = twips(width);
    }
    if (height !== undefined && height > 0) {
        css[`height`] = twips(height);
    }
    pushInline(builder, { kind: `image`, src, alt: ``, css });
};

const HYPERLINK = /HYPERLINK\s+"([^"]+)"/i;

const endGroup = (builder: Builder): void => {
    const frame = builder.frames.pop();
    if (frame === undefined) {
        return;
    }
    if (frame.destination === `pict`) {
        endPicture(builder);
    }
    if (frame.destination === `fonttbl` && builder.fontSlot !== undefined) {
        builder.fonts.set(builder.fontSlot, builder.collected.replace(/;.*$/s, ``).trim());
        builder.fontSlot = undefined;
        builder.collected = ``;
    }
    if (frame.destination === `fldinst`) {
        // The instruction names the link; the result group that follows is the text it applies to. Writers wrap the
        // instruction in further groups, so the link belongs on the nearest frame OUTSIDE the instruction — the
        // field itself, which the result group is a sibling inside.
        const match = HYPERLINK.exec(builder.collected);
        builder.collected = ``;
        const field = builder.frames.findLast((entry) => entry.destination !== `fldinst`);
        if (match?.[1] !== undefined && field !== undefined) {
            field.link = match[1];
        }
    }
};

export type WordHandler = (builder: Builder, value: number | undefined) => void;

const setStyle = (builder: Builder, change: Partial<RtfStyle>): void => {
    Object.assign(top(builder).style, change);
};

const onOff = (value: number | undefined): boolean => value !== 0;

const PICTURE_TYPES: Readonly<Record<string, string>> = { pngblip: `image/png`, jpegblip: `image/jpeg` };

const CHARACTER_WORDS: Readonly<Record<string, WordHandler>> = {
    b: (builder, value) => setStyle(builder, { bold: onOff(value) }),
    i: (builder, value) => setStyle(builder, { italic: onOff(value) }),
    ul: (builder, value) => setStyle(builder, { underline: onOff(value) }),
    ulnone: (builder) => setStyle(builder, { underline: false }),
    strike: (builder, value) => setStyle(builder, { strike: onOff(value) }),
    striked: (builder, value) => setStyle(builder, { strike: onOff(value) }),
    caps: (builder, value) => setStyle(builder, { caps: onOff(value) }),
    scaps: (builder, value) => setStyle(builder, { smallCaps: onOff(value) }),
    v: (builder, value) => setStyle(builder, { hidden: onOff(value) }),
    super: (builder) => setStyle(builder, { vertical: `super` }),
    sub: (builder) => setStyle(builder, { vertical: `sub` }),
    nosupersub: (builder) => setStyle(builder, { vertical: undefined }),
    up: (builder, value) => setStyle(builder, { vertical: value === 0 ? undefined : `super` }),
    dn: (builder, value) => setStyle(builder, { vertical: value === 0 ? undefined : `sub` }),
    fs: (builder, value) => setStyle(builder, { size: value }),
    uc: (builder, value) => setStyle(builder, { uc: value ?? 1 }),
    cf: (builder, value) => setStyle(builder, { color: builder.colors[value ?? 0] }),
    cb: (builder, value) => setStyle(builder, { background: builder.colors[value ?? 0] }),
    chcbpat: (builder, value) => setStyle(builder, { background: builder.colors[value ?? 0] }),
    highlight: (builder, value) => setStyle(builder, { background: builder.colors[value ?? 0] }),
    plain: (builder) => setStyle(builder, plainStyle(top(builder).style)),
};

const PARAGRAPH_WORDS: Readonly<Record<string, WordHandler>> = {
    par: (builder) => endParagraph(builder, true),
    line: (builder) => pushInline(builder, { kind: `break` }),
    tab: (builder) => pushInline(builder, { kind: `tab` }),
    li: (builder, value) => setStyle(builder, { indentLeft: value }),
    fi: (builder, value) => setStyle(builder, { indentFirst: value }),
    sb: (builder, value) => setStyle(builder, { spaceBefore: value }),
    sa: (builder, value) => setStyle(builder, { spaceAfter: value }),
    pard: (builder) =>
        setStyle(builder, { align: undefined, indentLeft: undefined, indentFirst: undefined, spaceBefore: undefined, spaceAfter: undefined, inTable: false }),
    intbl: (builder) => setStyle(builder, { inTable: true }),
    cell: (builder) => endCell(builder),
    nestcell: (builder) => endCell(builder),
    row: (builder) => endRow(builder),
    nestrow: (builder) => endRow(builder),
    trowd: (builder) => {
        builder.cellEdges = [];
        builder.cellShades = [];
        setStyle(builder, { inTable: true });
    },
    cellx: (builder, value) => {
        builder.cellEdges.push(value ?? 0);
        builder.cellShades.push(builder.pendingShade);
        builder.pendingShade = undefined;
    },
    clcbpat: (builder, value) => {
        builder.pendingShade = builder.colors[value ?? 0];
    },
    clcbpatraw: (builder, value) => {
        builder.pendingShade = builder.colors[value ?? 0];
    },
};

const DOCUMENT_WORDS: Readonly<Record<string, WordHandler>> = {
    ansicpg: (builder, value) => {
        builder.codePage = value ?? 1252;
        builder.decoder = decoderFor(builder.codePage);
    },
    f: (builder, value) => {
        if (top(builder).destination === `fonttbl`) {
            builder.fontSlot = value;
            return;
        }
        setStyle(builder, { font: builder.fonts.get(value ?? -1) });
    },
    red: (builder, value) => {
        builder.colorParts.red = value ?? 0;
        builder.colorParts.seen = true;
    },
    green: (builder, value) => {
        builder.colorParts.green = value ?? 0;
        builder.colorParts.seen = true;
    },
    blue: (builder, value) => {
        builder.colorParts.blue = value ?? 0;
        builder.colorParts.seen = true;
    },
    picwgoal: (builder, value) => {
        builder.picture.width = value;
    },
    paperw: (builder, value) => void (builder.page.width = value ?? 0),
    paperh: (builder, value) => void (builder.page.height = value ?? 0),
    margl: (builder, value) => void (builder.page.left = value ?? 0),
    margr: (builder, value) => void (builder.page.right = value ?? 0),
    margt: (builder, value) => void (builder.page.top = value ?? 0),
    margb: (builder, value) => void (builder.page.bottom = value ?? 0),
    pichgoal: (builder, value) => {
        builder.picture.height = value;
    },
};

// Characters RTF writes as control words. Dropped, a document loses its dashes and quotation marks: the em dash a
// table uses for "no value" simply vanishes from the cell.
const CHARACTERS: Readonly<Record<string, string>> = {
    emdash: `\u2014`,
    endash: `\u2013`,
    lquote: `\u2018`,
    rquote: `\u2019`,
    ldblquote: `\u201C`,
    rdblquote: `\u201D`,
    bullet: `\u2022`,
    emspace: `\u2003`,
    enspace: `\u2002`,
    qmspace: `\u2005`,
};

const CHARACTER_TEXT: Readonly<Record<string, WordHandler>> = Object.fromEntries(
    Object.entries(CHARACTERS).map(([word, text]) => [word, (builder: Builder) => write(builder, text)]),
);

const SYMBOL_WORDS: Readonly<Record<string, WordHandler>> = {
    "~": (builder) => write(builder, ` `),
    "_": (builder) => write(builder, `‑`),
    "-": () => {},
    ":": () => {},
    "|": () => {},
    "*": (builder) => {
        top(builder).ignorable = true;
    },
};

const WORDS: Readonly<Record<string, WordHandler>> = { ...CHARACTER_WORDS, ...PARAGRAPH_WORDS, ...DOCUMENT_WORDS, ...CHARACTER_TEXT, ...SYMBOL_WORDS };

const DESTINATIONS: Readonly<Record<string, Destination>> = { fonttbl: `fonttbl`, colortbl: `colortbl`, pict: `pict`, fldinst: `fldinst` };

const applyWord = (builder: Builder, word: string, value: number | undefined): void => {
    const frame = top(builder);
    const destination = DESTINATIONS[word];
    if (destination !== undefined) {
        frame.destination = destination;
        frame.ignorable = false;
        return;
    }
    // The rule RTF is built on: `\*\word` marks a group a reader that does not know `word` must skip entirely.
    // Without it, an embedded font's hex payload reads as the font's NAME, and a drawing's as the document's text.
    if (SKIPPED.has(word) || frame.ignorable === true) {
        frame.destination = `skip`;
        frame.ignorable = false;
        return;
    }
    const alignment = ALIGN[word];
    if (alignment !== undefined) {
        setStyle(builder, { align: alignment });
        return;
    }
    const pictureType = PICTURE_TYPES[word];
    if (pictureType !== undefined) {
        builder.picture.type = pictureType;
        return;
    }
    WORDS[word]?.(builder, value);
};

// \u is the one word that must be handled with the fallback characters that follow it, which are dropped.
const applyUnicode = (builder: Builder, value: number | undefined): void => {
    const code = value === undefined ? 0 : value < 0 ? value + 0x10000 : value;
    if (code > 0 && code <= 0x10ffff) {
        write(builder, String.fromCodePoint(code));
    }
    builder.skip = top(builder).style.uc;
};

const takeText = (builder: Builder, text: string): string => {
    if (builder.skip <= 0) {
        return text;
    }
    const dropped = Math.min(builder.skip, text.length);
    builder.skip -= dropped;
    return text.slice(dropped);
};

const onText = (builder: Builder, text: string): void => {
    const frame = top(builder);
    const combined = flushBytes(builder) + text;
    const kept = takeText(builder, combined);
    if (frame.destination === `pict`) {
        builder.picture.hex += kept;
        return;
    }
    if (frame.destination === `fonttbl` || frame.destination === `fldinst`) {
        builder.collected += kept;
        return;
    }
    if (frame.destination === `skip`) {
        return;
    }
    if (frame.destination === `colortbl`) {
        collectColors(builder, kept);
        return;
    }
    write(builder, kept);
};

// A colour table is a list of triples terminated by semicolons; a bare semicolon is "automatic", which means the
// reader's own default rather than a colour.
const collectColors = (builder: Builder, text: string): void => {
    for (const char of text) {
        if (char !== `;`) {
            continue;
        }
        const { red, green, blue, seen } = builder.colorParts;
        builder.colors.push(seen ? `rgb(${red} ${green} ${blue})` : undefined);
        builder.colorParts = { red: 0, green: 0, blue: 0, seen: false };
    }
};

const onToken = (builder: Builder, token: RtfToken): void => {
    switch (token.kind) {
        case `group-start`: {
            const frame = top(builder);
            builder.frames.push({ style: { ...frame.style }, destination: frame.destination, link: frame.link });
            return;
        }
        case `group-end`:
            onText(builder, ``);
            endGroup(builder);
            return;
        case `byte`:
            if (builder.skip > 0) {
                builder.skip -= 1;
                return;
            }
            builder.bytes.push(token.byte);
            return;
        case `text`:
            onText(builder, token.text);
            return;
        case `word`:
            onText(builder, ``);
            if (token.word === `u`) {
                applyUnicode(builder, token.value);
                return;
            }
            applyWord(builder, token.word, token.value);
            return;
        default:
    }
};

export interface RtfDocument {
    readonly blocks: readonly Block[];
    readonly empty: boolean;
    /** The paper the document was written for, as CSS: width plus the four margins as padding. */
    readonly geometry: { readonly width: string; readonly padding: Css };
}

// US Letter in twips, which is what Word writes when a document says nothing.
const LETTER = { width: 12_240, left: 1440, right: 1440, top: 1440, bottom: 1440 };

const geometryOf = (page: PageSetup): RtfDocument[`geometry`] => ({
    width: twips(page.width !== undefined && page.width > 0 ? page.width : LETTER.width),
    padding: {
        "padding-top": twips(page.top ?? LETTER.top),
        "padding-right": twips(page.right ?? LETTER.right),
        "padding-bottom": twips(page.bottom ?? LETTER.bottom),
        "padding-left": twips(page.left ?? LETTER.left),
    },
});

/** An .rtf as blocks. `image` turns a picture's bytes into a URL, so this stays free of the browser. */
export const parseRtf = (bytes: Uint8Array, image: ImageFactory): RtfDocument => {
    const builder: Builder = {
        blocks: [],
        inlines: [],
        cellBlocks: [],
        cells: [],
        rows: [],
        cellEdges: [],
        cellShades: [],
        frames: [{ style: initialStyle(), destination: `body` }],
        fonts: new Map(),
        colors: [],
        codePage: 1252,
        decoder: decoderFor(1252),
        bytes: [],
        skip: 0,
        collected: ``,
        colorParts: { red: 0, green: 0, blue: 0, seen: false },
        picture: { hex: `` },
        page: {},
        image,
    };

    for (const token of tokenize(asLatin1(bytes))) {
        onToken(builder, token);
    }
    onText(builder, ``);
    endParagraph(builder, false);
    endRow(builder);
    flushTable(builder);
    return { blocks: builder.blocks, empty: builder.blocks.length === 0, geometry: geometryOf(builder.page) };
};
