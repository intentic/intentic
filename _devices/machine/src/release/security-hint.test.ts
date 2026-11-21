import { allowNote, deniedByThePc } from "./security-hint.js";

// (2026-11-20, intentic#49) What a Windows PC whose antivirus refused the agent's files is told, in the installer's words.
const FOLDERS = ["C:\\Users\\Ada\\.intentic\\machine\\bin", "C:\\Users\\Ada\\.intentic\\ic\\bin"];

describe("deniedByThePc", () => {
    it("takes Windows' Access denied, as either errno, for a refusal", () => {
        expect(deniedByThePc("EACCES")).toBe(true);
        expect(deniedByThePc("EPERM")).toBe(true);
        expect(deniedByThePc("ENOENT")).toBe(false);
        expect(deniedByThePc(undefined)).toBe(false);
    });
});

describe("allowNote", () => {
    it("asks for Intentic to be allowed on Windows, naming the file and both folders to allow", () => {
        const note = allowNote("start", "C:\\Users\\Ada\\.intentic\\machine\\bin\\mutagen.exe", "win32", FOLDERS);
        expect(note).toContain("Please allow Intentic on this PC: security software blocks C:\\Users\\Ada\\.intentic\\machine\\bin\\mutagen.exe from starting");
        expect(note).toContain(`Allow the folders ${FOLDERS[0]} and ${FOLDERS[1]}`);
    });

    it("says a removed file was removed, and a refused write was refused", () => {
        expect(allowNote("removed", "bundle.tar.gz", "win32", FOLDERS)).toContain("security software removes bundle.tar.gz as soon as it is put in place.");
        expect(allowNote("write", "bundle.tar.gz", "win32", FOLDERS)).toContain('security software blocks writing bundle.tar.gz (Windows answers "Access denied").');
    });

    it("blames no antivirus off Windows, where a refusal is the file's own permissions", () => {
        const note = allowNote("start", "/home/ada/.intentic/machine/bin/mutagen", "linux", FOLDERS);
        expect(note).not.toContain("security software");
        expect(note).toContain("check its permissions");
    });
});
