import ts from "typescript";
import type { Project } from "./project.js";

export interface RenameResult {
    readonly changedFiles: readonly string[];
    readonly edits: number;
}

const isDeclarationLike = (node: ts.Node): boolean =>
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isModuleDeclaration(node) ||
    ts.isVariableDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isPropertySignature(node) ||
    ts.isPropertyAssignment(node) ||
    ts.isParameter(node) ||
    ts.isEnumMember(node);

// The position of the FIRST declaration named `symbol` in `sourceFile` — the anchor the rename fans out from.
// Undefined when nothing by that name is declared here (the caller turns that into an actionable error).
const declarationPosition = (sourceFile: ts.SourceFile, symbol: string): number | undefined => {
    let position: number | undefined;
    const visit = (node: ts.Node): void => {
        if (position !== undefined) {
            return;
        }
        const name = (node as ts.NamedDeclaration).name;
        if (name !== undefined && ts.isIdentifier(name) && name.text === symbol && isDeclarationLike(node)) {
            position = name.getStart(sourceFile);
            return;
        }
        ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return position;
};

// Apply a file's spans right-to-left so earlier replacements don't shift later offsets. prefix/suffix cover the
// shorthand-property case ({ foo } → { foo: bar }), which the language service reports on the rename location.
const applyToFile = (file: string, locations: readonly ts.RenameLocation[], newName: string): void => {
    const original = ts.sys.readFile(file);
    if (original === undefined) {
        throw new Error(`cannot read ${file} to apply the rename`);
    }
    let text = original;
    for (const location of locations.toSorted((a, b) => b.textSpan.start - a.textSpan.start)) {
        const start = location.textSpan.start;
        const end = start + location.textSpan.length;
        text = `${text.slice(0, start)}${location.prefixText ?? ""}${newName}${location.suffixText ?? ""}${text.slice(end)}`;
    }
    ts.sys.writeFile(file, text);
};

// Rename every usage of the declared symbol across its TS project via the language service (the same edit VS Code
// runs), then write each touched file. Throws when the symbol isn't declared in the file or can't be renamed.
export const rename = (project: Project, fileName: string, symbol: string, newName: string): RenameResult => {
    const sourceFile = project.service.getProgram()?.getSourceFile(fileName);
    if (sourceFile === undefined) {
        throw new Error(`file is not part of the TypeScript project: ${fileName}`);
    }
    const position = declarationPosition(sourceFile, symbol);
    if (position === undefined) {
        throw new Error(`no declaration named "${symbol}" in ${fileName}`);
    }
    const locations = project.service.findRenameLocations(fileName, position, false, false, { providePrefixAndSuffixTextForRename: true });
    if (locations === undefined || locations.length === 0) {
        throw new Error(`"${symbol}" cannot be renamed at its declaration (it may be external or ambient)`);
    }
    const byFile = new Map<string, ts.RenameLocation[]>();
    for (const location of locations) {
        const list = byFile.get(location.fileName) ?? [];
        list.push(location);
        byFile.set(location.fileName, list);
    }
    for (const [file, locs] of byFile) {
        applyToFile(file, locs, newName);
    }
    return { changedFiles: [...byFile.keys()], edits: locations.length };
};
