// Structural checks over a PowerPoint deck: what a person opening it would meet, read off the package without
// rendering it. Slide numbers are the deck's own order (presentation.xml's slide list), never the part file names,
// which a reordered deck no longer matches.
//
// The geometry, crop and missing-media rules are adapted from SurfSense's PPTX artifact verification
// (surfsense_backend/app/artifacts/verification/formats/pptx.py, Copyright (c) SurfSense, Apache-2.0,
// https://github.com/MODSetter/SurfSense; see this package's NOTICE). Changed here: a shape partly off the slide is a
// warning rather than ignored, a hidden or empty slide is a warning rather than a blocker, and placeholder geometry is
// inherited from the layout and master before it is judged. The text-fit, placeholder, stretch and leftover-text checks
// are this package's own.
import { imageSize } from "image-size";
import { error, inches, leftoverText, plural, warning, type CheckReport, type Finding } from "./finding.js";
import { missingTargetFindings, NotAPackage, openPackage, packageFindings, type OoxmlPackage } from "./package.js";
import { estimateText, type Paragraph } from "./text-fit.js";
import { childAt, childNamed, childrenNamed, everyElement, intAttr, isElement, textIn, type XmlElement } from "./xml-tree.js";

const PRESENTATION = "ppt/presentation.xml";
const EMU_PER_PT = 12_700;
const DEFAULT_SIZE_HUNDREDTHS = 1800;
// bodyPr's default insets: 0.1 in left and right, 0.05 in top and bottom.
const DEFAULT_INSET_X = 91_440;
const DEFAULT_INSET_Y = 45_720;
// An estimate has to miss by this much before it is worth a warning; the glyph widths are averages.
const OVERFLOW_MARGIN = 1.15;
const CROP_WHOLE = 100_000;

const DRAWABLE = new Set(["p:sp", "p:pic", "p:graphicFrame", "p:cxnSp", "p:grpSp", "p:contentPart"]);

// Placeholders that sit empty on purpose or are filled by the application (date, footer, slide number).
const SELF_FILLING = new Set(["dt", "ftr", "sldNum", "hdr", "sldImg"]);

const PROMPTS = new Map<string, readonly [string, string]>([
    ["title", ["title", "Click to add title"]],
    ["ctrTitle", ["title", "Click to add title"]],
    ["subTitle", ["subtitle", "Click to add subtitle"]],
    ["pic", ["picture", "Click icon to add picture"]],
    ["chart", ["chart", "Click icon to add chart"]],
    ["tbl", ["table", "Click icon to add table"]],
    ["media", ["media", "Click icon to add media"]],
]);
const promptOf = (type: string): readonly [string, string] => PROMPTS.get(type) ?? ["text", "Click to add text"];

interface Box {
    readonly x: number;
    readonly y: number;
    readonly cx: number;
    readonly cy: number;
    readonly rot: number;
}

interface Placeholder {
    readonly type: string;
    readonly idx: string | undefined;
}

// Everything a slide's shapes inherit from: the layout and master placeholders, the master's text styles, and the
// deck's default text style for shapes that are not placeholders.
interface Inheritance {
    readonly layout: XmlElement | undefined;
    readonly master: XmlElement | undefined;
    readonly defaultTextStyle: XmlElement | undefined;
}

interface SlideContext {
    readonly pkg: OoxmlPackage;
    readonly number: number;
    readonly part: string;
    readonly width: number;
    readonly height: number;
    readonly inheritance: Inheritance;
    readonly pictures: PictureUse[];
}

interface PictureUse {
    readonly where: string;
    readonly media: string;
    readonly cx: number;
    readonly cy: number;
    readonly crop: { readonly l: number; readonly t: number; readonly r: number; readonly b: number };
}

const KINDS = new Map([
    ["p:sp", "shape"],
    ["p:pic", "picture"],
    ["p:graphicFrame", "frame"],
    ["p:grpSp", "group"],
    ["p:cxnSp", "connector"],
]);

// What PowerPoint's selection pane calls it: its name, or for a nameless one its kind and id.
const drawingName = (drawing: XmlElement): string => {
    const nv = drawing.children.find((child): child is XmlElement => isElement(child) && child.name.startsWith("p:nv"));
    const properties = childAt(nv, "p:cNvPr");
    const name = properties?.attrs["name"] ?? "";
    return name.trim() === "" ? `unnamed ${KINDS.get(drawing.name) ?? "drawing"} #${properties?.attrs["id"] ?? "?"}` : `"${name}"`;
};

// A shape wrapped for newer features sits in mc:AlternateContent; its first choice is the shape PowerPoint shows.
const drawableChildren = (tree: XmlElement): XmlElement[] =>
    tree.children.flatMap((child): XmlElement[] => {
        if (!isElement(child)) {
            return [];
        }
        if (child.name === "mc:AlternateContent") {
            const choice = childNamed(child, "mc:Choice") ?? childNamed(child, "mc:Fallback");
            return choice === undefined ? [] : drawableChildren(choice);
        }
        return DRAWABLE.has(child.name) ? [child] : [];
    });

const placeholderOf = (drawing: XmlElement): Placeholder | undefined => {
    const nv = drawing.children.find((child): child is XmlElement => isElement(child) && child.name.startsWith("p:nv"));
    const ph = childAt(nv, "p:nvPr", "p:ph");
    return ph === undefined ? undefined : { type: ph.attrs["type"] ?? "obj", idx: ph.attrs["idx"] };
};

// The master names only the broad kinds; a layout's centred title or subtitle inherits from the master's title or body.
const masterType = (type: string): string => {
    if (type === "ctrTitle") {
        return "title";
    }
    return type === "subTitle" || type === "obj" ? "body" : type;
};

const findPlaceholder = (tree: XmlElement | undefined, wanted: Placeholder, onMaster: boolean): XmlElement | undefined => {
    const spTree = childAt(tree, "p:cSld", "p:spTree");
    if (spTree === undefined) {
        return undefined;
    }
    const candidates = drawableChildren(spTree).flatMap((drawing) => {
        const ph = placeholderOf(drawing);
        return ph === undefined ? [] : [{ drawing, ph }];
    });
    if (!onMaster && wanted.idx !== undefined) {
        const byIdx = candidates.find(({ ph }) => ph.idx === wanted.idx);
        if (byIdx !== undefined) {
            return byIdx.drawing;
        }
    }
    const type = onMaster ? masterType(wanted.type) : wanted.type;
    return candidates.find(({ ph }) => (onMaster ? masterType(ph.type) : ph.type) === type)?.drawing;
};

// The shape itself, then the layout placeholder it fills, then the master's: the order PowerPoint inherits in.
const inheritanceChain = (drawing: XmlElement, inheritance: Inheritance): XmlElement[] => {
    const ph = placeholderOf(drawing);
    if (ph === undefined) {
        return [drawing];
    }
    const layoutDrawing = findPlaceholder(inheritance.layout, ph, false);
    const layoutPh = layoutDrawing === undefined ? undefined : placeholderOf(layoutDrawing);
    const masterDrawing = findPlaceholder(inheritance.master, layoutPh ?? ph, true);
    return [drawing, layoutDrawing, masterDrawing].filter((item): item is XmlElement => item !== undefined);
};

const ownTransform = (drawing: XmlElement): XmlElement | undefined => {
    switch (drawing.name) {
        case "p:graphicFrame":
            return childNamed(drawing, "p:xfrm");
        case "p:grpSp":
            return childAt(drawing, "p:grpSpPr", "a:xfrm");
        default:
            return childAt(drawing, "p:spPr", "a:xfrm");
    }
};

const boxOf = (chain: readonly XmlElement[]): Box | undefined => {
    for (const drawing of chain) {
        const xfrm = ownTransform(drawing);
        const off = childAt(xfrm, "a:off");
        const ext = childAt(xfrm, "a:ext");
        if (off === undefined || ext === undefined) {
            continue;
        }
        const [x, y, cx, cy] = [intAttr(off, "x"), intAttr(off, "y"), intAttr(ext, "cx"), intAttr(ext, "cy")];
        if (x === undefined || y === undefined || cx === undefined || cy === undefined) {
            return undefined;
        }
        return { x, y, cx, cy, rot: intAttr(xfrm, "rot") ?? 0 };
    }
    return undefined;
};

// The axis-aligned box a rotated shape covers, about its centre.
interface Covered {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
}

const coveredBox = (box: Box): Covered => {
    const angle = ((box.rot / 60_000) * Math.PI) / 180;
    const width = Math.abs(box.cx * Math.cos(angle)) + Math.abs(box.cy * Math.sin(angle));
    const height = Math.abs(box.cx * Math.sin(angle)) + Math.abs(box.cy * Math.cos(angle));
    const centreX = box.x + box.cx / 2;
    const centreY = box.y + box.cy / 2;
    return { left: centreX - width / 2, top: centreY - height / 2, right: centreX + width / 2, bottom: centreY + height / 2 };
};

const geometryFindings = (drawing: XmlElement, box: Box, where: string, width: number, height: number): Finding[] => {
    if (box.cx < 0 || box.cy < 0) {
        return [error("bad-geometry", where, "has a negative width or height, which PowerPoint cannot draw")];
    }
    const connector = drawing.name === "p:cxnSp";
    if ((box.cx === 0 && box.cy === 0) || (!connector && (box.cx === 0 || box.cy === 0))) {
        return [warning("bad-geometry", where, "has no area, so it cannot be seen; size it or delete it")];
    }
    const covered = coveredBox(box);
    if (covered.right <= 0 || covered.bottom <= 0 || covered.left >= width || covered.top >= height) {
        return [error("off-slide", where, "sits entirely off the slide, so no one will see it; move it onto the slide or delete it")];
    }
    // Bleeding past an edge is sometimes the design (a full-bleed photo), so it is reported, not failed; a sliver
    // under 1% of the slide is rounding.
    const edges = [
        ["left", -covered.left, width],
        ["top", -covered.top, height],
        ["right", covered.right - width, width],
        ["bottom", covered.bottom - height, height],
    ] as const;
    return edges
        .filter(([, past, span]) => past > span * 0.01)
        .map(([edge, past]) => warning("off-slide", where, `runs ${inches(past)} past the ${edge} edge of the slide, where it is cut off`));
};

// --- text ------------------------------------------------------------------------------------------------------

// The first value a list of candidates yields, in inheritance order.
const firstOf = <T>(candidates: readonly (() => T | undefined)[]): T | undefined => {
    for (const candidate of candidates) {
        const value = candidate();
        if (value !== undefined) {
            return value;
        }
    }
    return undefined;
};

const masterStyleFor = (master: XmlElement | undefined, placeholder: Placeholder): XmlElement | undefined =>
    childAt(master, "p:txStyles", masterType(placeholder.type) === "title" ? "p:titleStyle" : "p:bodyStyle");

interface TextStyle {
    readonly listStyles: readonly (XmlElement | undefined)[];
}

const textStyleOf = (drawing: XmlElement, chain: readonly XmlElement[], inheritance: Inheritance): TextStyle => {
    const placeholder = placeholderOf(drawing);
    const own = chain.map((link) => childAt(link, "p:txBody", "a:lstStyle"));
    const tail = placeholder === undefined ? [inheritance.defaultTextStyle] : [masterStyleFor(inheritance.master, placeholder)];
    return { listStyles: [...own, ...tail] };
};

const hundredthsAt = (element: XmlElement | undefined, path: readonly string[], attribute: string): number | undefined =>
    intAttr(childAt(element, ...path), attribute);

const paragraphsOf = (txBody: XmlElement, style: TextStyle, fontScale: number, spacingReduction: number): Paragraph[] =>
    childrenNamed(txBody, "a:p").map((p) => {
        const pPr = childNamed(p, "a:pPr");
        const level = (intAttr(pPr, "lvl") ?? 0) + 1;
        const runs = p.children.filter((child): child is XmlElement => isElement(child) && (child.name === "a:r" || child.name === "a:fld"));
        const text = p.children
            .map((child) => {
                if (!isElement(child)) {
                    return "";
                }
                if (child.name === "a:br") {
                    return "\n";
                }
                return child.name === "a:r" || child.name === "a:fld" ? textIn(child, "a:t") : "";
            })
            .join("");
        const inherited = (attribute: string): number | undefined =>
            firstOf([
                () => intAttr(childAt(pPr, "a:defRPr"), attribute),
                ...style.listStyles.map((listStyle) => () => intAttr(childAt(listStyle, `a:lvl${level}pPr`, "a:defRPr"), attribute)),
            ]);
        const runSizes = runs.flatMap((run) => intAttr(childNamed(run, "a:rPr"), "sz") ?? []);
        const size =
            runSizes.length > 0
                ? Math.max(...runSizes)
                : (intAttr(childNamed(p, "a:endParaRPr"), "sz") ?? inherited("sz") ?? DEFAULT_SIZE_HUNDREDTHS);
        const bold = runs.some((run) => childNamed(run, "a:rPr")?.attrs["b"] === "1") || (runs.length > 0 && inherited("b") === 1);
        const spacing = (name: string): number | undefined =>
            firstOf([
                () => hundredthsAt(pPr, [name, "a:spcPts"], "val"),
                ...style.listStyles.map((listStyle) => () => hundredthsAt(listStyle, [`a:lvl${level}pPr`, name, "a:spcPts"], "val")),
            ]);
        const lineSpacingPct = firstOf([
            () => hundredthsAt(pPr, ["a:lnSpc", "a:spcPct"], "val"),
            ...style.listStyles.map((listStyle) => () => hundredthsAt(listStyle, [`a:lvl${level}pPr`, "a:lnSpc", "a:spcPct"], "val")),
        ]);
        const lineHeightPts = hundredthsAt(pPr, ["a:lnSpc", "a:spcPts"], "val");
        const sizePt = (size / 100) * fontScale;
        return {
            text,
            sizePt,
            bold,
            lineSpacing: ((lineSpacingPct ?? 100_000) / 100_000) * (1 - spacingReduction),
            lineHeightPt: lineHeightPts === undefined ? undefined : lineHeightPts / 100,
            spaceBeforePt: (spacing("a:spcBef") ?? 0) / 100,
            spaceAfterPt: (spacing("a:spcAft") ?? 0) / 100,
        };
    });

type Autofit = "none" | "shrink" | "grow";

const bodyPropsOf = (chain: readonly XmlElement[]) => {
    const bodies = chain.map((link) => childAt(link, "p:txBody", "a:bodyPr")).filter((body): body is XmlElement => body !== undefined);
    const attribute = (name: string): string | undefined => bodies.map((body) => body.attrs[name]).find((value) => value !== undefined);
    const inset = (name: string, fallback: number): number => {
        const raw = attribute(name);
        return raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : fallback;
    };
    const fitElement = bodies
        .map((body) => childNamed(body, "a:normAutofit") ?? childNamed(body, "a:spAutoFit") ?? childNamed(body, "a:noAutofit"))
        .find((fit) => fit !== undefined);
    const autofit: Autofit = fitElement?.name === "a:normAutofit" ? "shrink" : fitElement?.name === "a:spAutoFit" ? "grow" : "none";
    return {
        left: inset("lIns", DEFAULT_INSET_X),
        right: inset("rIns", DEFAULT_INSET_X),
        top: inset("tIns", DEFAULT_INSET_Y),
        bottom: inset("bIns", DEFAULT_INSET_Y),
        wrap: attribute("wrap") !== "none",
        vertical: (attribute("vert") ?? "horz") !== "horz",
        autofit,
        fontScale: (intAttr(fitElement, "fontScale") ?? 100_000) / 100_000,
        spacingReduction: (intAttr(fitElement, "lnSpcReduction") ?? 0) / 100_000,
    };
};

const overflowFindings = (drawing: XmlElement, chain: readonly XmlElement[], box: Box, where: string, context: SlideContext): Finding[] => {
    const txBody = childNamed(drawing, "p:txBody");
    if (txBody === undefined || textIn(txBody, "a:t").trim() === "") {
        return [];
    }
    const body = bodyPropsOf(chain);
    if (body.vertical || box.rot !== 0) {
        return [];
    }
    const paragraphs = paragraphsOf(txBody, textStyleOf(drawing, chain, context.inheritance), body.fontScale, body.spacingReduction);
    const innerWidth = (box.cx - body.left - body.right) / EMU_PER_PT;
    const innerHeight = (box.cy - body.top - body.bottom) / EMU_PER_PT;
    if (innerWidth <= 0) {
        return [];
    }
    const estimate = estimateText(paragraphs, innerWidth, body.wrap);
    const look = `(an estimate: look with \`fileq render --pages ${context.number}\`)`;
    if (!body.wrap && estimate.widestPt > innerWidth * OVERFLOW_MARGIN) {
        return [warning("text-overflow", where, `text is set not to wrap and probably runs past the box's right edge ${look}`)];
    }
    const needed = estimate.heightPt * EMU_PER_PT + body.top + body.bottom;
    if (body.autofit === "grow") {
        // The box grows to fit its text, so the text cannot overflow the box, only the slide.
        return box.y + needed > context.height * 1.02
            ? [
                  warning(
                      "text-overflow",
                      where,
                      `the box grows to fit its text, and about ${plural(estimate.lines, "line")} of ${estimate.sizePt} pt take it past the bottom of the slide ${look}`,
                  ),
              ]
            : [];
    }
    if (estimate.heightPt <= innerHeight * OVERFLOW_MARGIN) {
        return [];
    }
    const shrink =
        body.autofit === "shrink"
            ? "; shrink-on-overflow is on, so LibreOffice shrinks it but PowerPoint shows it overflowing until the text is edited: shorten it or enlarge the box"
            : "; shorten it, enlarge the box or split the slide";
    const offSlide = box.y + needed > context.height * 1.02 ? ", past the bottom of the slide" : "";
    return [
        warning(
            "text-overflow",
            where,
            `text probably overflows its box${offSlide}: about ${plural(estimate.lines, "line")} of ${estimate.sizePt} pt need ${inches(needed)}, the box is ${inches(box.cy)} tall${shrink} ${look}`,
        ),
    ];
};

// A table's rows grow to fit their text in PowerPoint, so a long table runs off the slide rather than overflowing a cell.
const tableFindings = (frame: XmlElement, box: Box, where: string, context: SlideContext): Finding[] => {
    const table = childAt(frame, "a:graphic", "a:graphicData", "a:tbl");
    if (table === undefined) {
        return [];
    }
    const grid = childAt(table, "a:tblGrid");
    const columns = (grid === undefined ? [] : childrenNamed(grid, "a:gridCol")).map((column) => intAttr(column, "w") ?? 0);
    let total = 0;
    for (const row of childrenNamed(table, "a:tr")) {
        let rowHeight = intAttr(row, "h") ?? 0;
        let column = 0;
        for (const cell of childrenNamed(row, "a:tc")) {
            const span = intAttr(cell, "gridSpan") ?? 1;
            const cellWidth = columns.slice(column, column + span).reduce((sum, width) => sum + width, 0);
            column += span;
            const txBody = childNamed(cell, "a:txBody");
            if (txBody === undefined || cell.attrs["hMerge"] === "1" || cell.attrs["vMerge"] === "1") {
                continue;
            }
            const tcPr = childNamed(cell, "a:tcPr");
            const marginX = (intAttr(tcPr, "marL") ?? DEFAULT_INSET_X) + (intAttr(tcPr, "marR") ?? DEFAULT_INSET_X);
            const marginY = (intAttr(tcPr, "marT") ?? DEFAULT_INSET_Y) + (intAttr(tcPr, "marB") ?? DEFAULT_INSET_Y);
            const estimate = estimateText(
                paragraphsOf(txBody, { listStyles: [childNamed(txBody, "a:lstStyle")] }, 1, 0),
                (cellWidth - marginX) / EMU_PER_PT,
                true,
            );
            rowHeight = Math.max(rowHeight, estimate.heightPt * EMU_PER_PT + marginY);
        }
        total += rowHeight;
    }
    if (box.y + total <= context.height * 1.05) {
        return [];
    }
    return [
        warning(
            "table-overflow",
            where,
            `the table's rows probably need about ${inches(total)}, and it starts ${inches(box.y)} down a ${inches(context.height)} slide, so its last rows run off the bottom; split it across slides or cut rows (an estimate: look with \`fileq render --pages ${context.number}\`)`,
        ),
    ];
};

// --- references ------------------------------------------------------------------------------------------------

// One `r:` attribute's relationship, judged: undefined when it resolves to something that is there.
const referenceFinding = (node: XmlElement, id: string, where: string, context: SlideContext): Finding | undefined => {
    const relationship = context.pkg.rels(context.part).get(id);
    const isImage = node.name === "a:blip";
    const rule = isImage ? "missing-image" : "missing-part";
    if (relationship === undefined) {
        const what = isImage ? "the picture shows as a broken image" : "the reference is broken";
        return error(rule, where, `${isImage ? "image" : node.name} refers to ${id}, which the slide does not define: ${what}`);
    }
    if (relationship.external) {
        return isImage
            ? warning(
                  "linked-image",
                  where,
                  `image is linked from outside the file (${relationship.target}), so it will not show on anyone else's machine; embed it`,
              )
            : undefined;
    }
    if (context.pkg.has(relationship.target)) {
        return undefined;
    }
    return isImage
        ? error(rule, where, `image ${relationship.target} is not in the file, so it shows as a broken image`)
        : error(rule, where, `${relationship.kind} ${relationship.target} is not in the file, so it is missing`);
};

const referenceFindings = (element: XmlElement, where: string, context: SlideContext, referenced: Set<string>): Finding[] =>
    everyElement(element).flatMap((node) =>
        Object.entries(node.attrs).flatMap(([attribute, id]) => {
            if (!attribute.startsWith("r:") || id === "") {
                return [];
            }
            referenced.add(id);
            return referenceFinding(node, id, where, context) ?? [];
        }),
    );

const pictureFindings = (picture: XmlElement, box: Box | undefined, where: string, context: SlideContext): Finding[] => {
    const blipFill = childNamed(picture, "p:blipFill");
    const crop = childAt(blipFill, "a:srcRect");
    const sides = { l: intAttr(crop, "l") ?? 0, t: intAttr(crop, "t") ?? 0, r: intAttr(crop, "r") ?? 0, b: intAttr(crop, "b") ?? 0 };
    if (sides.l + sides.r >= CROP_WHOLE || sides.t + sides.b >= CROP_WHOLE) {
        return [error("bad-crop", where, "the picture is cropped away entirely, so nothing of it shows; fix the crop")];
    }
    const embed = childAt(blipFill, "a:blip")?.attrs["r:embed"];
    const relationship = embed === undefined ? undefined : context.pkg.rels(context.part).get(embed);
    if (
        box !== undefined &&
        relationship !== undefined &&
        !relationship.external &&
        context.pkg.has(relationship.target) &&
        box.cx > 0 &&
        box.cy > 0
    ) {
        context.pictures.push({ where, media: relationship.target, cx: box.cx, cy: box.cy, crop: sides });
    }
    return [];
};

// A picture drawn at a shape other than its own proportions is stretched; the most common way to get there is setting
// both width and height instead of deriving one from the other.
const stretchFindings = (pkg: OoxmlPackage, pictures: readonly PictureUse[]): Finding[] => {
    const media = pkg.binaries([...new Set(pictures.map((picture) => picture.media))]);
    return pictures.flatMap((picture) => {
        const bytes = media[picture.media];
        if (bytes === undefined) {
            return [];
        }
        let size: { width?: number; height?: number };
        try {
            size = imageSize(bytes);
        } catch {
            // allow(silent-catch): a format image-size cannot read (EMF, a damaged file) has no proportions to compare.
            return [];
        }
        if (size.width === undefined || size.height === undefined || size.width === 0 || size.height === 0) {
            return [];
        }
        const shownWidth = size.width * (1 - (picture.crop.l + picture.crop.r) / CROP_WHOLE);
        const shownHeight = size.height * (1 - (picture.crop.t + picture.crop.b) / CROP_WHOLE);
        const imageRatio = shownWidth / shownHeight;
        const boxRatio = picture.cx / picture.cy;
        const off = boxRatio / imageRatio;
        if (Math.abs(off - 1) <= 0.05) {
            return [];
        }
        return [
            warning(
                "stretched-image",
                picture.where,
                `the picture is ${off > 1 ? "stretched wide" : "squeezed narrow"}: its box is ${boxRatio.toFixed(2)}:1, the image ${imageRatio.toFixed(2)}:1; set one side from the other, or crop instead`,
            ),
        ];
    });
};

// --- one slide -------------------------------------------------------------------------------------------------

const drawingFindings = (drawing: XmlElement, context: SlideContext, grouped: boolean, referenced: Set<string>): Finding[] => {
    const name = drawingName(drawing);
    const where = `slide ${context.number} · ${name}`;
    const findings: Finding[] = [...referenceFindings(drawing, where, context, referenced)];
    const chain = inheritanceChain(drawing, context.inheritance);
    // A grouped shape's offsets are in its group's own coordinate space; only the group itself is placed on the slide.
    const box = grouped ? undefined : boxOf(chain);
    if (box !== undefined) {
        findings.push(...geometryFindings(drawing, box, where, context.width, context.height));
    }
    switch (drawing.name) {
        case "p:grpSp":
            for (const child of drawableChildren(drawing)) {
                findings.push(...drawingFindings(child, context, true, referenced));
            }
            break;
        case "p:pic":
            findings.push(...pictureFindings(drawing, box, where, context));
            break;
        case "p:graphicFrame":
            findings.push(...leftoverText(textIn(drawing, "a:t"), where));
            if (box !== undefined) {
                findings.push(...tableFindings(drawing, box, where, context));
            }
            break;
        case "p:sp": {
            const text = childrenNamed(childNamed(drawing, "p:txBody") ?? drawing, "a:p")
                .map((p) => textIn(p, "a:t"))
                .join("\n");
            findings.push(...leftoverText(text, where));
            const placeholder = placeholderOf(drawing);
            const filledWithPicture = childAt(drawing, "p:spPr", "a:blipFill") !== undefined;
            if (placeholder !== undefined && !SELF_FILLING.has(placeholder.type) && text.trim() === "" && !filledWithPicture) {
                const [label, prompt] = promptOf(placeholder.type);
                findings.push(
                    warning(
                        "empty-placeholder",
                        where,
                        `empty ${label} placeholder: invisible in the slide show, but it reads "${prompt}" to anyone who edits the deck; fill it or delete it`,
                    ),
                );
            }
            if (box !== undefined) {
                findings.push(...overflowFindings(drawing, chain, box, where, context));
            }
            break;
        }
        default:
            break;
    }
    return findings;
};

const layoutsOf = (pkg: OoxmlPackage, slidePart: string): Pick<Inheritance, "layout" | "master"> => {
    const layoutRel = [...pkg.rels(slidePart).values()].find((relationship) => relationship.kind === "slideLayout" && !relationship.external);
    const layout = layoutRel === undefined ? undefined : pkg.xml(layoutRel.target);
    const masterRel =
        layoutRel === undefined ? undefined : [...pkg.rels(layoutRel.target).values()].find((relationship) => relationship.kind === "slideMaster");
    return { layout, master: masterRel === undefined ? undefined : pkg.xml(masterRel.target) };
};

const slideFindings = (context: SlideContext, tree: XmlElement): Finding[] => {
    const findings: Finding[] = [];
    const slideWhere = `slide ${context.number}`;
    if (tree.attrs["show"] === "0") {
        findings.push(
            warning("hidden-slide", slideWhere, "the slide is hidden, so the slide show skips it; delete it if it is not meant to be delivered"),
        );
    }
    const referenced = new Set<string>();
    const background = childAt(tree, "p:cSld", "p:bg");
    if (background !== undefined) {
        findings.push(...referenceFindings(background, `${slideWhere} · background`, context, referenced));
    }
    const spTree = childAt(tree, "p:cSld", "p:spTree");
    const drawings = spTree === undefined ? [] : drawableChildren(spTree);
    if (drawings.length === 0) {
        findings.push(warning("empty-slide", slideWhere, "the slide has nothing on it of its own, only what its layout draws"));
    }
    for (const drawing of drawings) {
        findings.push(...drawingFindings(drawing, context, false, referenced));
    }
    findings.push(...missingTargetFindings(context.pkg, context.part, slideWhere, referenced));
    return findings;
};

// --- the deck --------------------------------------------------------------------------------------------------

export const checkPptx = (bytes: Uint8Array): CheckReport => {
    let pkg: OoxmlPackage;
    try {
        pkg = openPackage(bytes);
    } catch (cause) {
        if (cause instanceof NotAPackage) {
            return {
                format: "pptx",
                findings: [error("unreadable", "", `${cause.message}: this is not a PowerPoint file (or it is password-protected)`)],
                notes: [],
            };
        }
        throw cause;
    }
    const findings = packageFindings(pkg, PRESENTATION);
    const notes = pkg.skipped.map((part) => `not checked: ${part} is too large to read`);
    const presentation = pkg.xml(PRESENTATION);
    if (presentation === undefined) {
        return { format: "pptx", findings, notes };
    }
    const size = childNamed(presentation, "p:sldSz");
    const width = intAttr(size, "cx") ?? 0;
    const height = intAttr(size, "cy") ?? 0;
    if (width <= 0 || height <= 0) {
        findings.push(error("no-slide-size", "", "the presentation sets no slide size (p:sldSz), so nothing can lay it out"));
        return { format: "pptx", findings, notes };
    }
    const slideList = childNamed(presentation, "p:sldIdLst");
    const slideIds = slideList === undefined ? [] : childrenNamed(slideList, "p:sldId");
    if (slideIds.length === 0) {
        findings.push(error("no-slides", "", "the presentation has no slides"));
    }
    const rels = pkg.rels(PRESENTATION);
    const defaultTextStyle = childNamed(presentation, "p:defaultTextStyle");
    const pictures: PictureUse[] = [];
    slideIds.forEach((slideId, index) => {
        const number = index + 1;
        const relationship = rels.get(slideId.attrs["r:id"] ?? "");
        if (relationship === undefined || relationship.external || !pkg.has(relationship.target)) {
            findings.push(
                error(
                    "missing-part",
                    `slide ${number}`,
                    "the slide list names a slide that is not in the file; PowerPoint will offer to repair the deck",
                ),
            );
            return;
        }
        const tree = pkg.xml(relationship.target);
        if (tree === undefined) {
            return; // too large to read, named in the notes
        }
        const context: SlideContext = {
            pkg,
            number,
            part: relationship.target,
            width,
            height,
            inheritance: { ...layoutsOf(pkg, relationship.target), defaultTextStyle },
            pictures,
        };
        findings.push(...slideFindings(context, tree));
    });
    findings.push(...stretchFindings(pkg, pictures));
    return { format: "pptx", extent: plural(slideIds.length, "slide"), findings, notes };
};
