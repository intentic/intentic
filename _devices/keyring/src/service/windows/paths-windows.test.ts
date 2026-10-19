import { windowsServiceAcls } from "./acl-windows.js";
import { windowsServicePaths, windowsServiceInstalled } from "./paths-windows.js";

const SID = "S-1-5-21-1111111111-2222222222-3333333333-1001";
const env = { ProgramData: "C:\\ProgramData" };

describe("hardened mode's places", () => {
    test("sit under ProgramData, the vault in a folder named for the user", () => {
        const paths = windowsServicePaths(SID, env);
        expect(paths.exe).toContain("Intentic");
        expect(paths.vaultDir.endsWith(SID)).toBe(true);
        expect(paths.taskName).toBe(`Keyring-${SID}`);
    });

    test("refuse anything that is not a security identifier, which names a folder and a task", () => {
        expect(() => windowsServicePaths("..\\..\\Windows", env)).toThrow();
    });

    test("cut inheritance and name every account by SID, so a localised Windows reads them the same", () => {
        for (const call of windowsServiceAcls(windowsServicePaths(SID, env))) {
            expect(call.args[0]).toBe("/inheritance:r");
            for (const grant of call.args.slice(2)) {
                expect(grant).toMatch(/^\*S-1-[\d-]+:/u);
            }
        }
        const vault = windowsServiceAcls(windowsServicePaths(SID, env)).find((call) => call.path.endsWith(SID));
        expect(vault?.args.join(" ")).not.toContain("S-1-5-32-545");
    });

    test("are off where no marker was written", () => {
        expect(windowsServiceInstalled(SID, { ProgramData: "/nonexistent" })).toBe(false);
    });
});
