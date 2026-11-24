// Estimates how much room a run of text needs, from character classes rather than the font's own metrics. Good enough
// to say "about nine lines of 24 pt will not fit in a box 1.2 in tall", never good enough to say it for certain: the
// real answer depends on the font the viewer substitutes, which is why every finding built on this is a warning and
// points at `fileq render` for the look that settles it.

export interface Paragraph {
    readonly text: string;
    readonly sizePt: number;
    readonly bold: boolean;
    /** Multiple of single spacing (1 for single); ignored when `lineHeightPt` gives the height in points. */
    readonly lineSpacing: number;
    /** Exact line height in points when the paragraph sets one. */
    readonly lineHeightPt?: number | undefined;
    readonly spaceBeforePt: number;
    readonly spaceAfterPt: number;
}

// Average advance of a character as a fraction of the font size, by class. Calibrated against Arial/Liberation Sans,
// where running English text averages about half an em per character.
const widthEm = (char: string): number => {
    if (/\s/.test(char)) {
        return 0.28;
    }
    if (/[\u1100-\u11ff\u2e80-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/.test(char)) {
        return 1;
    }
    if (/[iljtfrI.,:;'!|()[\]]/.test(char)) {
        return 0.3;
    }
    if (/[mwMW@%]/.test(char)) {
        return 0.85;
    }
    if (/[A-Z]/.test(char)) {
        return 0.66;
    }
    if (/\d/.test(char)) {
        return 0.556;
    }
    if (/[a-z]/.test(char)) {
        return 0.52;
    }
    return 0.6;
};

const BOLD_WIDENING = 1.07;
// Single spacing in PowerPoint and LibreOffice is about 1.2 times the font size.
const SINGLE_LINE = 1.2;

const textWidthPt = (text: string, sizePt: number, bold: boolean): number =>
    [...text].reduce((sum, char) => sum + widthEm(char), 0) * sizePt * (bold ? BOLD_WIDENING : 1);

/** Lines one paragraph wraps to at `widthPt`, greedy by word, a word wider than the line broken where it runs out. */
export const wrappedLines = (paragraph: Paragraph, widthPt: number): number => {
    let lines = 0;
    for (const hardLine of paragraph.text.split("\n")) {
        let used = 0;
        let count = 1;
        for (const word of hardLine.split(/(?<=\s)/)) {
            const width = textWidthPt(word, paragraph.sizePt, paragraph.bold);
            const visible = textWidthPt(word.trimEnd(), paragraph.sizePt, paragraph.bold);
            if (used > 0 && used + visible > widthPt) {
                count += 1;
                used = 0;
            }
            if (used === 0 && visible > widthPt && widthPt > 0) {
                count += Math.ceil(visible / widthPt) - 1;
                used = visible % widthPt;
                continue;
            }
            used += width;
        }
        lines += count;
    }
    return lines;
};

const lineHeightOf = (paragraph: Paragraph): number => paragraph.lineHeightPt ?? paragraph.sizePt * SINGLE_LINE * paragraph.lineSpacing;

export interface TextEstimate {
    readonly heightPt: number;
    readonly lines: number;
    /** The widest unwrapped line, for a box that does not wrap. */
    readonly widestPt: number;
    /** The size most of the text is set in, for the message. */
    readonly sizePt: number;
}

/** Height of the paragraphs set in a column `widthPt` wide; `wrap: false` keeps every hard line on one line. */
export const estimateText = (paragraphs: readonly Paragraph[], widthPt: number, wrap: boolean): TextEstimate => {
    let heightPt = 0;
    let lines = 0;
    let widestPt = 0;
    const weight = new Map<number, number>();
    paragraphs.forEach((paragraph, index) => {
        const count = wrap ? wrappedLines(paragraph, widthPt) : paragraph.text.split("\n").length;
        lines += count;
        heightPt += count * lineHeightOf(paragraph) + (index === 0 ? 0 : paragraph.spaceBeforePt) + (index === paragraphs.length - 1 ? 0 : paragraph.spaceAfterPt);
        for (const hardLine of paragraph.text.split("\n")) {
            widestPt = Math.max(widestPt, textWidthPt(hardLine, paragraph.sizePt, paragraph.bold));
        }
        weight.set(paragraph.sizePt, (weight.get(paragraph.sizePt) ?? 0) + Math.max(1, paragraph.text.length));
    });
    const sizePt = [...weight.entries()].toSorted((a, b) => b[1] - a[1])[0]?.[0] ?? 18;
    return { heightPt, lines, widestPt, sizePt };
};
