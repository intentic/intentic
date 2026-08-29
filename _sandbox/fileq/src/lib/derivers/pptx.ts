import { readFile } from "node:fs/promises";
import { unzipSync } from "fflate";
import type { DerivedDoc, Deriver } from "./deriver.js";

/* Presentations: text runs out of the OOXML slide parts, one `## Slide N` section each. No library carries
 * its weight here — a pptx is a zip of XML whose visible text lives entirely in `<a:t>` runs grouped into
 * `<a:p>` paragraphs, and regex over that is honest about what it is: the words, in slide order, nothing
 * about layout. Speaker notes ride along the same way because they are routinely where the actual argument
 * of a deck lives. */

const SLIDE_PART = /^ppt\/slides\/slide(\d+)\.xml$/;
const NOTES_PART = /^ppt\/notesSlides\/notesSlide(\d+)\.xml$/;

const decodeEntities = (text: string): string =>
    text
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&quot;", '"')
        .replaceAll("&apos;", "'")
        .replaceAll(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
        .replaceAll(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
        .replaceAll("&amp;", "&");

// One slide part's XML → its paragraphs: `<a:t>` runs joined within each `<a:p>`, empties dropped.
export const slideParagraphs = (xml: string): string[] =>
    [...xml.matchAll(/<a:p\b[\s\S]*?<\/a:p>/g)]
        .map((paragraph) =>
            [...paragraph[0].matchAll(/<a:t[^>]*>([\s\S]*?)<\/a:t>/g)]
                .map((run) => decodeEntities(run[1] ?? ""))
                .join("")
                .trim(),
        )
        .filter((text) => text !== "");

const partsByNumber = (names: string[], pattern: RegExp): Map<number, string> => {
    const map = new Map<number, string>();
    for (const name of names) {
        const match = pattern.exec(name);
        if (match !== null) {
            map.set(Number(match[1]), name);
        }
    }
    return map;
};

export const pptxDeriver: Deriver = {
    name: "pptx",
    version: 1,
    derive: async (absPath): Promise<DerivedDoc> => {
        const zip = unzipSync(new Uint8Array(await readFile(absPath)));
        const names = Object.keys(zip);
        const decoder = new TextDecoder();
        const xmlOf = (name: string): string => decoder.decode(zip[name]);
        const slides = partsByNumber(names, SLIDE_PART);
        const notes = partsByNumber(names, NOTES_PART);
        const sections: string[] = [];
        for (const number of [...slides.keys()].toSorted((a, b) => a - b)) {
            const lines = slideParagraphs(xmlOf(slides.get(number) ?? ""));
            const section = [`## Slide ${number}`, ...lines];
            const notesPart = notes.get(number);
            if (notesPart !== undefined) {
                const noteLines = slideParagraphs(xmlOf(notesPart)).filter((line) => !/^\d+$/.test(line)); // slide-number placeholder
                if (noteLines.length > 0) {
                    section.push("", "Notes:", ...noteLines.map((line) => `> ${line}`));
                }
            }
            sections.push(section.join("\n"));
        }
        return {
            markdown: sections.join("\n\n"),
            notes: slides.size === 0 ? ["no slide parts found in this presentation"] : [],
        };
    },
};
