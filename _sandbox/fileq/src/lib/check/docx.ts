// Structural checks over a Word document: broken cross-references and links, fields that show an error or nothing,
// missing or linked images, empty headings, and what a draft leaves behind (tracked changes, comments, a content
// control still showing its prompt, template text). Word has no pages in the file, so a location is a paragraph: its
// number in reading order, with its own words or the heading it sits under to find it by.
//
// The literal-bullet rule is adapted from SurfSense's DOCX artifact verification
// (surfsense_backend/app/artifacts/verification/formats/docx.py, Copyright (c) SurfSense, Apache-2.0,
// https://github.com/MODSetter/SurfSense; see this package's NOTICE), reported here once per document as a warning.
import { error, excerpt, inches, leftoverText, plural, warning, type CheckReport, type Finding } from "./finding.js";
import { mainPartOf, missingTargetFindings, NotAPackage, openPackage, packageFindings, type OoxmlPackage, type Relationship } from "./package.js";
import { childAt, childNamed, childrenNamed, descendantsNamed, everyElement, intAttr, isElement, textIn, type XmlElement } from "./xml-tree.js";

const DEFAULT_MAIN = "word/document.xml";
const EMU_PER_TWIP = 635;
// Built-in anchors Word resolves without a bookmark.
const BUILT_IN_ANCHORS = new Set(["_top"]);
// Fields every viewer computes as it lays the page out; an empty saved result is normal for them.
const COMPUTED_FIELDS = new Set(["PAGE", "NUMPAGES", "SECTIONPAGES", "DATE", "TIME", "PRINTDATE", "SAVEDATE", "CREATEDATE"]);
const CROSS_REFERENCES = new Set(["REF", "PAGEREF", "NOTEREF"]);
const TYPED_BULLET = /^\s*[•◦▪‣∙·]\s/;

interface Located {
    readonly paragraph: XmlElement;
    readonly number: number;
    readonly text: string;
    readonly heading: number | undefined;
}

interface Field {
    readonly instruction: string;
    readonly result: string;
    readonly hasResult: boolean;
    readonly where: string;
}

interface DocContext {
    readonly pkg: OoxmlPackage;
    readonly main: string;
    readonly paragraphs: readonly Located[];
    readonly whereOf: ReadonlyMap<XmlElement, string>;
    readonly bookmarks: ReadonlySet<string>;
}

// --- styles ----------------------------------------------------------------------------------------------------

// Heading level by style id, from styles.xml: a built-in "heading N" or "Title" by its (always English) style name,
// or any style carrying an outline level, following basedOn so a custom style on top of a heading still counts.
const headingLevels = (styles: XmlElement | undefined): ReadonlyMap<string, number> => {
    const byId = new Map<string, XmlElement>();
    for (const style of styles === undefined ? [] : childrenNamed(styles, "w:style")) {
        const id = style.attrs["w:styleId"];
        if (id !== undefined && style.attrs["w:type"] === "paragraph") {
            byId.set(id, style);
        }
    }
    const levelOf = (id: string, depth: number): number | undefined => {
        const style = byId.get(id);
        if (style === undefined || depth > 8) {
            return undefined;
        }
        const name = (childNamed(style, "w:name")?.attrs["w:val"] ?? "").toLowerCase();
        const numbered = /^heading (\d)$/.exec(name);
        if (numbered !== null) {
            return Number(numbered[1]);
        }
        if (name === "title") {
            return 0;
        }
        const outline = intAttr(childAt(style, "w:pPr", "w:outlineLvl"), "w:val");
        if (outline !== undefined && outline < 9) {
            return outline + 1;
        }
        const basedOn = childNamed(style, "w:basedOn")?.attrs["w:val"];
        return basedOn === undefined ? undefined : levelOf(basedOn, depth + 1);
    };
    return new Map([...byId.keys()].flatMap((id) => {
        const level = levelOf(id, 0);
        return level === undefined ? [] : [[id, level] as const];
    }));
};

const headingOf = (paragraph: XmlElement, levels: ReadonlyMap<string, number>): number | undefined => {
    const pPr = childNamed(paragraph, "w:pPr");
    const outline = intAttr(childAt(pPr, "w:outlineLvl"), "w:val");
    if (outline !== undefined && outline < 9) {
        return outline + 1;
    }
    const style = childAt(pPr, "w:pStyle")?.attrs["w:val"];
    return style === undefined ? undefined : levels.get(style);
};

// --- locating --------------------------------------------------------------------------------------------------

const paragraphText = (paragraph: XmlElement): string => textIn(paragraph, "w:t");

interface Locations {
    readonly located: Located[];
    readonly whereOf: Map<XmlElement, string>;
}

const locate = (paragraphs: readonly XmlElement[], levels: ReadonlyMap<string, number>): Locations => {
    const located: Located[] = [];
    const whereOf = new Map<XmlElement, string>();
    let lastHeading: string | undefined;
    paragraphs.forEach((paragraph, index) => {
        const text = paragraphText(paragraph);
        const heading = headingOf(paragraph, levels);
        const number = index + 1;
        const label = text.trim() !== "" ? `paragraph ${number} · ${excerpt(text, 40)}` : lastHeading === undefined ? `paragraph ${number}` : `paragraph ${number} · under ${lastHeading}`;
        located.push({ paragraph, number, text, heading });
        whereOf.set(paragraph, label);
        if (heading !== undefined && text.trim() !== "") {
            lastHeading = excerpt(text, 40);
        }
    });
    return { located, whereOf };
};

// The paragraph an element sits in, by walking every paragraph's subtree once.
const paragraphIndex = (paragraphs: readonly XmlElement[]): Map<XmlElement, XmlElement> => {
    const owner = new Map<XmlElement, XmlElement>();
    for (const paragraph of paragraphs) {
        for (const node of everyElement(paragraph)) {
            owner.set(node, paragraph);
        }
    }
    return owner;
};

// --- fields ----------------------------------------------------------------------------------------------------

interface OpenField {
    instruction: string;
    result: string;
    separated: boolean;
    readonly where: string;
}

// One fldChar moves the field state machine: begin opens a field, separate starts its saved result, end closes it.
const stepField = (node: XmlElement, open: OpenField[], fields: Field[], where: string): void => {
    const type = node.attrs["w:fldCharType"];
    const current = open.at(-1);
    if (type === "begin") {
        open.push({ instruction: "", result: "", separated: false, where });
        return;
    }
    if (current === undefined) {
        return;
    }
    if (type === "separate") {
        current.separated = true;
    } else if (type === "end") {
        open.pop();
        fields.push({ instruction: current.instruction.trim(), result: current.result, hasResult: current.separated && current.result.trim() !== "", where: current.where });
    }
};

// Complex fields span runs: begin, instruction text, separate, the saved result, end; they nest. Simple fields carry
// the instruction as an attribute and the result as their content.
const fieldsIn = (body: XmlElement, whereOfNode: (node: XmlElement) => string): Field[] => {
    const fields: Field[] = [];
    const open: OpenField[] = [];
    for (const node of everyElement(body)) {
        if (node.name === "w:fldSimple") {
            const result = textIn(node, "w:t");
            fields.push({ instruction: (node.attrs["w:instr"] ?? "").trim(), result, hasResult: result.trim() !== "", where: whereOfNode(node) });
        } else if (node.name === "w:fldChar") {
            stepField(node, open, fields, whereOfNode(node));
        } else {
            const current = open.at(-1);
            const text = node.children.filter((child): child is string => !isElement(child)).join("");
            if (current !== undefined && node.name === "w:instrText" && !current.separated) {
                current.instruction += text;
            } else if (current !== undefined && node.name === "w:t" && current.separated) {
                current.result += text;
            }
        }
    }
    return fields;
};

const bookmarkArgument = (instruction: string): string | undefined => {
    const tokens = [...instruction.matchAll(/"[^"]*"|\S+/g)].map((match) => match[0]);
    const keyword = (tokens[0] ?? "").toUpperCase();
    if (CROSS_REFERENCES.has(keyword)) {
        return tokens[1]?.replaceAll('"', "");
    }
    if (keyword === "HYPERLINK") {
        const at = tokens.indexOf("\\l");
        return at === -1 ? undefined : tokens[at + 1]?.replaceAll('"', "");
    }
    return undefined;
};

const fieldFindings = (fields: readonly Field[], bookmarks: ReadonlySet<string>, updatesOnOpen: boolean): Finding[] =>
    fields.flatMap((field): Finding[] => {
        const keyword = (field.instruction.split(/\s+/)[0] ?? "").toUpperCase();
        if (field.result.trim().startsWith('Error!')) {
            return [error("field-error", field.where, `the ${keyword} field shows ${excerpt(field.result)}: fix what it points at, then update fields`)];
        }
        const bookmark = bookmarkArgument(field.instruction);
        if (bookmark !== undefined && !bookmarks.has(bookmark) && !BUILT_IN_ANCHORS.has(bookmark)) {
            return [error("broken-reference", field.where, `the ${keyword} field points to bookmark "${bookmark}", which is not in the document: Word shows "Error! Reference source not found."`)];
        }
        if (keyword === "MERGEFIELD") {
            return [warning("merge-field", field.where, `a mail-merge field is left in (${field.instruction}): it prints its placeholder, not a value`)];
        }
        if (keyword === "TOC" && !field.hasResult) {
            const when = updatesOnOpen ? "Word offers to update fields when the file opens" : "nothing fills it until someone updates fields (F9 in Word)";
            return [warning("empty-toc", field.where, `the table of contents has no entries saved: ${when}, and previews and LibreOffice show it empty`)];
        }
        if (!field.hasResult && keyword !== "" && !COMPUTED_FIELDS.has(keyword) && keyword !== "TOC") {
            return [warning("empty-field", field.where, `the ${keyword} field has no saved result, so it shows blank until fields are updated`)];
        }
        return [];
    });

// --- references and images -------------------------------------------------------------------------------------

const referenceFindings = (context: DocContext, part: string, tree: XmlElement, whereOfNode: (node: XmlElement) => string, referenced: Set<string>): Finding[] => {
    const rels = context.pkg.rels(part);
    const findings: Finding[] = [];
    for (const node of everyElement(tree)) {
        for (const [attribute, id] of Object.entries(node.attrs)) {
            if (!attribute.startsWith("r:") || id === "") {
                continue;
            }
            referenced.add(id);
            const finding = referenceFinding(context.pkg, node, rels.get(id), id, whereOfNode(node));
            if (finding !== undefined) {
                findings.push(finding);
            }
        }
    }
    return findings;
};

const referenceFinding = (
    pkg: OoxmlPackage,
    node: XmlElement,
    relationship: Relationship | undefined,
    id: string,
    where: string,
): Finding | undefined => {
    const isImage = node.name === "a:blip" || node.name === "v:imagedata";
    if (relationship === undefined) {
        return error(isImage ? "missing-image" : "missing-part", where, `${isImage ? "an image" : node.name} refers to ${id}, which the document does not define: it shows as missing`);
    }
    if (relationship.external) {
        return isImage ? warning("linked-image", where, `an image is linked from outside the file (${relationship.target}), so it will not show on anyone else's machine; embed it`) : undefined;
    }
    if (pkg.has(relationship.target)) {
        return undefined;
    }
    return isImage
        ? error("missing-image", where, `image ${relationship.target} is not in the file, so it shows as a broken picture`)
        : error("missing-part", where, `${relationship.kind} ${relationship.target} is not in the file`);
};

// The text column of each section, in reading order: a paragraph's own sectPr closes a section, the body's closes the last.
const textWidths = (paragraphs: readonly XmlElement[], body: XmlElement): { endsAt: number; width: number | undefined }[] => {
    const widthOf = (sectPr: XmlElement | undefined): number | undefined => {
        const page = intAttr(childAt(sectPr, "w:pgSz"), "w:w");
        const margins = childAt(sectPr, "w:pgMar");
        if (page === undefined) {
            return undefined;
        }
        const columns = Math.max(1, intAttr(childAt(sectPr, "w:cols"), "w:num") ?? 1);
        const text = page - (intAttr(margins, "w:left") ?? 0) - (intAttr(margins, "w:right") ?? 0) - (intAttr(margins, "w:gutter") ?? 0);
        return (text / columns) * EMU_PER_TWIP;
    };
    const sections = paragraphs.flatMap((paragraph, index) => {
        const sectPr = childAt(paragraph, "w:pPr", "w:sectPr");
        return sectPr === undefined ? [] : [{ endsAt: index, width: widthOf(sectPr) }];
    });
    sections.push({ endsAt: paragraphs.length, width: widthOf(childNamed(body, "w:sectPr")) });
    return sections;
};

const wideImageFindings = (context: DocContext, body: XmlElement, owner: ReadonlyMap<XmlElement, XmlElement>): Finding[] => {
    const all = context.paragraphs.map((located) => located.paragraph);
    const order = new Map(all.map((paragraph, index) => [paragraph, index]));
    const sections = textWidths(all, body);
    return descendantsNamed(body, "wp:inline").flatMap((inline): Finding[] => {
        const cx = intAttr(childNamed(inline, "wp:extent"), "cx");
        const paragraph = owner.get(inline);
        const index = paragraph === undefined ? undefined : order.get(paragraph);
        const width = index === undefined ? undefined : sections.find((section) => section.endsAt >= index)?.width;
        if (cx === undefined || width === undefined || width <= 0 || cx <= width * 1.02) {
            return [];
        }
        const where = paragraph === undefined ? "" : (context.whereOf.get(paragraph) ?? "");
        return [warning("wide-image", where, `a picture is ${inches(cx)} wide in a ${inches(width)} text column, so it runs into the margin or is cut off; scale it to fit`)];
    });
};

// --- the document ----------------------------------------------------------------------------------------------

const draftFindings = (context: DocContext, body: XmlElement): Finding[] => {
    const findings: Finding[] = [];
    const changes = everyElement(body).filter((node) => ["w:ins", "w:del", "w:moveFrom", "w:moveTo"].includes(node.name) && node.children.some(isElement)).length;
    if (changes > 0) {
        findings.push(warning("tracked-changes", "", `${plural(changes, "tracked change")} still in the document: accept or reject them before it goes out`));
    }
    const commentsPart = [...context.pkg.rels(context.main).values()].find((relationship) => relationship.kind === "comments" && !relationship.external);
    const comments = commentsPart === undefined ? undefined : context.pkg.xml(commentsPart.target);
    const count = comments === undefined ? 0 : childrenNamed(comments, "w:comment").length;
    if (count > 0) {
        findings.push(warning("comments", "", `${plural(count, "comment")} still in the document: resolve or delete them before it goes out`));
    }
    return findings;
};

const paragraphFindings = (context: DocContext): Finding[] => {
    const findings: Finding[] = [];
    let typedBullets = 0;
    let firstBullet: string | undefined;
    for (const located of context.paragraphs) {
        const where = context.whereOf.get(located.paragraph) ?? `paragraph ${located.number}`;
        findings.push(...leftoverText(located.text, where));
        const hasPicture = descendantsNamed(located.paragraph, "w:drawing").length > 0 || descendantsNamed(located.paragraph, "w:pict").length > 0;
        if (located.heading !== undefined && located.text.trim() === "" && !hasPicture) {
            const level = located.heading === 0 ? "title" : `heading ${located.heading}`;
            findings.push(warning("empty-heading", where, `empty ${level}: a blank line in the text and an empty entry in the navigation pane and any table of contents; delete it`));
        }
        if (TYPED_BULLET.test(located.text) && childAt(located.paragraph, "w:pPr", "w:numPr") === undefined) {
            typedBullets += 1;
            firstBullet ??= where;
        }
    }
    if (firstBullet !== undefined) {
        findings.push(
            warning("typed-bullets", firstBullet, `${plural(typedBullets, "paragraph")} ${typedBullets === 1 ? "starts" : "start"} with a typed bullet character instead of a list style, so the list will not indent or renumber; use a list style`),
        );
    }
    return findings;
};

const controlFindings = (body: XmlElement, whereOfNode: (node: XmlElement) => string): Finding[] =>
    descendantsNamed(body, "w:sdt")
        .filter((control) => childAt(control, "w:sdtPr", "w:showingPlcHdr") !== undefined)
        .map((control) => {
            const prompt = textIn(childNamed(control, "w:sdtContent") ?? control, "w:t");
            // A block-level control holds whole paragraphs; it is found by the first of them.
            const where = whereOfNode(descendantsNamed(control, "w:p")[0] ?? control);
            return error("placeholder-control", where, `a content control still shows its prompt ${excerpt(prompt)}: enter the value or remove the control`);
        });

const linkFindings = (body: XmlElement, bookmarks: ReadonlySet<string>, whereOfNode: (node: XmlElement) => string): Finding[] =>
    descendantsNamed(body, "w:hyperlink").flatMap((link) => {
        const anchor = link.attrs["w:anchor"];
        if (anchor === undefined || bookmarks.has(anchor) || BUILT_IN_ANCHORS.has(anchor)) {
            return [];
        }
        return [error("broken-link", whereOfNode(link), `the link ${excerpt(textIn(link, "w:t"))} points to bookmark "${anchor}", which is not in the document, so clicking it goes nowhere`)];
    });

// Headers, footers and notes: each part's own images and relationships, located by the part's name.
const storyFindings = (context: DocContext, stories: readonly { part: string; tree: XmlElement }[]): Finding[] =>
    stories.flatMap((story) => {
        const label = story.part.replace(/^word\//, "").replace(/\.xml$/, "");
        const referenced = new Set<string>();
        return [...referenceFindings(context, story.part, story.tree, () => label, referenced), ...missingTargetFindings(context.pkg, story.part, label, referenced)];
    });

const openDocx = (bytes: Uint8Array): OoxmlPackage | CheckReport => {
    try {
        return openPackage(bytes);
    } catch (cause) {
        if (cause instanceof NotAPackage) {
            return { format: "docx", findings: [error("unreadable", "", `${cause.message}: this is not a Word file (or it is password-protected)`)], notes: [] };
        }
        throw cause;
    }
};

export const checkDocx = (bytes: Uint8Array): CheckReport => {
    const pkg = openDocx(bytes);
    if ("findings" in pkg) {
        return pkg;
    }
    const main = mainPartOf(pkg, DEFAULT_MAIN);
    const findings = packageFindings(pkg, main);
    const notes = pkg.skipped.map((part) => `not checked: ${part} is too large to read`);
    const body = childAt(pkg.xml(main), "w:body");
    if (body === undefined) {
        return { format: "docx", findings, notes };
    }
    const mainRels = [...pkg.rels(main).values()].filter((relationship) => !relationship.external);
    const partOfKind = (kind: string): XmlElement | undefined => {
        const relationship = mainRels.find((candidate) => candidate.kind === kind);
        return relationship === undefined ? undefined : pkg.xml(relationship.target);
    };
    const all = descendantsNamed(body, "w:p");
    const { located, whereOf } = locate(all, headingLevels(partOfKind("styles")));
    const owner = paragraphIndex(all);
    const whereOfNode = (node: XmlElement): string => whereOf.get(owner.get(node) ?? node) ?? "";
    // Bookmarks can sit in any story: the body, headers and footers, footnotes.
    const stories = mainRels
        .filter((relationship) => ["header", "footer", "footnotes", "endnotes"].includes(relationship.kind))
        .flatMap((relationship) => {
            const tree = pkg.xml(relationship.target);
            return tree === undefined ? [] : [{ part: relationship.target, tree }];
        });
    const bookmarks = new Set(
        [body, ...stories.map((story) => story.tree)].flatMap((tree) => descendantsNamed(tree, "w:bookmarkStart").flatMap((mark) => mark.attrs["w:name"] ?? [])),
    );
    const context: DocContext = { pkg, main, paragraphs: located, whereOf, bookmarks };
    if (located.every((item) => item.text.trim() === "") && descendantsNamed(body, "w:drawing").length === 0) {
        findings.push(warning("no-text", "", "the document has no text"));
    }
    const updateFields = childAt(partOfKind("settings"), "w:updateFields");
    const referenced = new Set<string>();
    findings.push(
        ...linkFindings(body, bookmarks, whereOfNode),
        ...fieldFindings(fieldsIn(body, whereOfNode), bookmarks, updateFields !== undefined && updateFields.attrs["w:val"] !== "false"),
        ...referenceFindings(context, main, body, whereOfNode, referenced),
        ...storyFindings(context, stories),
        ...missingTargetFindings(pkg, main, "", referenced),
        ...controlFindings(body, whereOfNode),
        ...paragraphFindings(context),
        ...wideImageFindings(context, body, owner),
        ...draftFindings(context, body),
    );
    // A field showing "Error!" or a control showing its prompt is already named for what it is; the same words read as
    // leftover text would say it twice.
    const explained = new Set(findings.filter((finding) => finding.rule === "field-error" || finding.rule === "placeholder-control").map((finding) => finding.where));
    return {
        format: "docx",
        extent: plural(located.length, "paragraph"),
        findings: findings.filter((finding) => finding.rule !== "leftover-text" || !explained.has(finding.where)),
        notes,
    };
};
