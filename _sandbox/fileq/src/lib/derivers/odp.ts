import { readFile } from "node:fs/promises";
import { unzipSync } from "fflate";
import type { DerivedDoc, Deriver } from "./deriver.js";
import { attributeOf, decodeEntities } from "../xml.js";

/* OpenDocument presentations and drawings: one `## Slide N` section per page, the same shape pptx derives to. */

const PAGE = /<draw:page\b([^>]*)>([\s\S]*?)<\/draw:page>/g;
const NOTES = /<presentation:notes\b[^>]*>[\s\S]*?<\/presentation:notes>/g;
const PARAGRAPH = /<text:(p|h)\b[^>]*(?:\/>|>([\s\S]*?)<\/text:\1>)/g;

/** The text of one `<text:p>` or `<text:h>`, with the elements ODF uses for spacing turned back into spaces. */
const lineOf = (inner: string): string =>
    decodeEntities(
        inner
            .replaceAll(/<text:s\b[^>]*\/>/g, " ")
            .replaceAll(/<text:tab\b[^>]*\/>/g, " ")
            .replaceAll(/<text:line-break\b[^>]*\/>/g, " ")
            .replaceAll(/<[^>]+>/g, ""),
    )
        .replaceAll(/\s+/g, " ")
        .trim();

const linesOf = (xml: string): string[] => [...xml.matchAll(PARAGRAPH)].map((match) => lineOf(match[2] ?? "")).filter((line) => line !== "");

export const odpDeriver: Deriver = {
    name: "odp",
    version: 1,
    derive: async (absPath): Promise<DerivedDoc> => {
        const zip = unzipSync(new Uint8Array(await readFile(absPath)), { filter: (file) => file.name === "content.xml" });
        const content = zip["content.xml"];
        if (content === undefined) {
            return { markdown: "", notes: ["no content.xml in this OpenDocument container"] };
        }
        const xml = new TextDecoder().decode(content);
        const sections: string[] = [];
        for (const page of xml.matchAll(PAGE)) {
            const body = page[2] ?? "";
            // The notes page travels inside the slide; it is what the speaker says, not what the slide shows.
            const slide = body.replaceAll(NOTES, "");
            const notes = (body.match(NOTES) ?? []).flatMap((part) => linesOf(part)).filter((line) => !/^\d+$/.test(line));
            const name = attributeOf(page[1] ?? "", "draw:name");
            const heading = `## Slide ${sections.length + 1}${name === undefined || name === "" ? "" : `: ${name}`}`;
            const section = [heading, ...linesOf(slide)];
            if (notes.length > 0) {
                section.push("", "Notes:", ...notes.map((line) => `> ${line}`));
            }
            sections.push(section.join("\n"));
        }
        return { markdown: sections.join("\n\n"), notes: sections.length === 0 ? ["no slides in this presentation"] : [] };
    },
};
