// Structural checks over an Excel workbook: cells whose saved value is an error (#REF!, #DIV/0!, #NAME?, …),
// formulas that point at a deleted range, formulas saved without a value, names that lead nowhere, and links to other
// workbooks. Worksheets are scanned as text, not built into a tree: a sheet can be tens of megabytes of cells.
//
// The error-value and missing-cached-value rules are adapted from SurfSense's XLSX artifact verification
// (surfsense_backend/app/artifacts/verification/formats/xlsx.py, Copyright (c) SurfSense, Apache-2.0,
// https://github.com/MODSetter/SurfSense; see this package's NOTICE). Changed here: each finding names its cell, and a
// formula with no saved value is a warning, since every spreadsheet application computes it on open.
import { decodeEntities } from "../xml.js";
import { error, excerpt, plural, warning, type CheckReport, type Finding } from "./finding.js";
import { mainPartOf, missingTargetFindings, NotAPackage, openPackage, packageFindings, type OoxmlPackage } from "./package.js";
import { childAt, childNamed, childrenNamed, isElement, type XmlElement } from "./xml-tree.js";

const DEFAULT_MAIN = "xl/workbook.xml";
// Past this many cells of one kind on one sheet, the rest are counted, not listed.
const LISTED_PER_SHEET = 10;

const CELL = /<((?:\w+:)?)c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1c>)/g;
const FORMULA = /<((?:\w+:)?)f\b[^>]*?(?:\/>|>([\s\S]*?)<\/\1f>)/;
const VALUE = /<((?:\w+:)?)v>([\s\S]*?)<\/\1v>/;
const INLINE = /<((?:\w+:)?)is\b/;

const attributeIn = (attributes: string, name: string): string | undefined => new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attributes)?.[1];

// A sheet name as a formula would quote it: `Sheet1!B4`, `'Q3 plan'!B4`.
const cellRef = (sheet: string, ref: string): string => (/^[A-Za-z_][\w.]*$/.test(sheet) ? `${sheet}!${ref}` : `'${sheet.replaceAll("'", "''")}'!${ref}`);

interface SheetScan {
    readonly errors: Finding[];
    readonly uncached: string[];
    readonly filled: number;
}

const scanSheet = (sheet: string, xml: string): SheetScan => {
    const errors: Finding[] = [];
    const uncached: string[] = [];
    let listed = 0;
    let unlisted = 0;
    let filled = 0;
    const report = (finding: Finding): void => {
        if (listed < LISTED_PER_SHEET) {
            errors.push(finding);
            listed += 1;
        } else {
            unlisted += 1;
        }
    };
    for (const match of xml.matchAll(CELL)) {
        const attributes = match[2] ?? "";
        const inner = match[3] ?? "";
        const ref = cellRef(sheet, attributeIn(attributes, "r") ?? "?");
        const formula = FORMULA.exec(inner);
        const value = VALUE.exec(inner);
        const formulaText = formula === null ? undefined : decodeEntities(formula[2] ?? "");
        if (formula !== null || value !== null || INLINE.test(inner)) {
            filled += 1;
        }
        const shown = formulaText === undefined || formulaText === "" ? "" : ` from =${formulaText}`;
        if (attributeIn(attributes, "t") === "e") {
            report(error("formula-error", ref, `shows ${decodeEntities(value?.[2] ?? "an error")}${shown}: fix the formula or its inputs`));
        } else if (formulaText?.includes("#REF!") === true) {
            report(error("formula-error", ref, `the formula =${formulaText} points at a deleted range (#REF!)`));
        } else if (formula !== null && value === null) {
            uncached.push(ref);
        }
    }
    if (unlisted > 0) {
        errors.push(error("formula-error", sheet, `and ${plural(unlisted, "more cell")} with errors on this sheet`));
    }
    return { errors, uncached, filled };
};

const uncachedFinding = (sheet: string, cells: readonly string[], recalculates: boolean): Finding => {
    const shown = cells.slice(0, 5).map((cell) => cell.slice(cell.lastIndexOf("!") + 1)).join(", ");
    const more = cells.length > 5 ? ", …" : "";
    const onOpen = recalculates ? "the workbook asks to be recalculated on open, so spreadsheet applications fill them in" : "Excel, LibreOffice and Google Sheets compute them on open";
    return warning(
        "formula-uncached",
        sheet,
        `${plural(cells.length, "formula")} saved with no value (${shown}${more}): ${onOpen}, but previews and anything that reads the file (pandas, fileq read) see blanks; write the value with the formula, or recalculate in LibreOffice`,
    );
};

const openWorkbook = (bytes: Uint8Array): OoxmlPackage | CheckReport => {
    try {
        return openPackage(bytes);
    } catch (cause) {
        if (cause instanceof NotAPackage) {
            return { format: "xlsx", findings: [error("unreadable", "", `${cause.message}: this is not an Excel file (or it is password-protected)`)], notes: [] };
        }
        throw cause;
    }
};

const namesFindings = (workbook: XmlElement | undefined): Finding[] => {
    const names = workbook === undefined ? undefined : childNamed(workbook, "x:definedNames");
    return (names === undefined ? [] : childrenNamed(names, "x:definedName")).flatMap((name) => {
        const target = name.children.filter((child): child is string => !isElement(child)).join("");
        return target.includes("#REF!") ? [error("broken-name", "", `the defined name "${name.attrs["name"] ?? "?"}" refers to ${excerpt(target)}, a deleted range`)] : [];
    });
};

const externalFindings = (pkg: OoxmlPackage): Finding[] => {
    const links = [...pkg.names].filter((name) => /^xl\/externalLinks\/externalLink\d+\.xml$/.test(name));
    return links.map((link) => {
        const target = [...pkg.rels(link).values()].find((relationship) => relationship.external)?.target ?? "another file";
        return warning("external-link", "", `the workbook takes values from ${target}; they go stale, or break, once the file is sent without it`);
    });
};

interface SheetsResult {
    readonly findings: Finding[];
    readonly filled: number;
}

const sheetsFindings = (pkg: OoxmlPackage, main: string, sheets: readonly XmlElement[], recalculates: boolean): SheetsResult => {
    const rels = pkg.rels(main);
    const findings: Finding[] = [];
    let filled = 0;
    for (const sheet of sheets) {
        const name = sheet.attrs["name"] ?? "?";
        const relationship = rels.get(sheet.attrs["r:id"] ?? "");
        if (relationship === undefined || relationship.external || !pkg.has(relationship.target)) {
            findings.push(error("missing-part", name, "the sheet list names a sheet that is not in the file; Excel will offer to repair the workbook"));
            continue;
        }
        // A chart sheet has no cells, and a sheet over the size cap is named in the notes.
        const xml = relationship.kind === "worksheet" ? pkg.text(relationship.target) : undefined;
        const scan = xml === undefined ? undefined : scanSheet(name, xml);
        if (scan === undefined) {
            continue;
        }
        filled += scan.filled;
        findings.push(...scan.errors, ...(scan.uncached.length > 0 ? [uncachedFinding(name, scan.uncached, recalculates)] : []));
        findings.push(...missingTargetFindings(pkg, relationship.target, name));
    }
    return { findings, filled };
};

export const checkXlsx = (bytes: Uint8Array): CheckReport => {
    const pkg = openWorkbook(bytes);
    if ("findings" in pkg) {
        return pkg;
    }
    const main = mainPartOf(pkg, DEFAULT_MAIN);
    const findings = packageFindings(pkg, main);
    const notes = pkg.skipped.map((part) => `not checked: ${part} is too large to read`);
    const workbook = pkg.xml(main);
    const sheetList = childAt(workbook, "x:sheets");
    const sheets = sheetList === undefined ? [] : childrenNamed(sheetList, "x:sheet");
    if (workbook !== undefined && sheets.length === 0) {
        findings.push(error("no-sheets", "", "the workbook has no sheets"));
    }
    const fullCalcOnLoad = childAt(workbook, "x:calcPr")?.attrs["fullCalcOnLoad"];
    const scanned = sheetsFindings(pkg, main, sheets, fullCalcOnLoad === "1" || fullCalcOnLoad === "true");
    findings.push(...scanned.findings);
    if (sheets.length > 0 && scanned.filled === 0 && pkg.skipped.length === 0) {
        findings.push(warning("no-data", "", "every sheet is empty"));
    }
    const listed = new Set(sheets.flatMap((sheet) => sheet.attrs["r:id"] ?? []));
    findings.push(...namesFindings(workbook), ...externalFindings(pkg), ...missingTargetFindings(pkg, main, "", listed));
    return { format: "xlsx", extent: plural(sheets.length, "sheet"), findings, notes };
};
