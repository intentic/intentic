import ts from "typescript";
import type { Project } from "./project.js";

export interface Diagnostic {
    readonly file: string;
    readonly line: number;
    readonly column: number;
    readonly category: string;
    readonly code: number;
    readonly message: string;
}

const format = (diagnostic: ts.Diagnostic, fallbackFile: string): Diagnostic => {
    const position =
        diagnostic.file !== undefined && diagnostic.start !== undefined ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start) : undefined;
    return {
        file: diagnostic.file?.fileName ?? fallbackFile,
        line: position !== undefined ? position.line + 1 : 0,
        column: position !== undefined ? position.character + 1 : 0,
        category: ts.DiagnosticCategory[diagnostic.category].toLowerCase(),
        code: diagnostic.code,
        message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    };
};

// Syntactic + semantic diagnostics for each requested file. The program resolves workspace imports (via the
// project's customConditions), so a break introduced by an edit elsewhere still surfaces on the files checked here.
export const diagnose = (project: Project, fileNames: readonly string[]): Diagnostic[] => {
    const out: Diagnostic[] = [];
    for (const fileName of fileNames) {
        for (const diagnostic of [...project.service.getSyntacticDiagnostics(fileName), ...project.service.getSemanticDiagnostics(fileName)]) {
            out.push(format(diagnostic, fileName));
        }
    }
    return out;
};
