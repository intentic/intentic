import { linuxServicePaths } from "./linux/paths-linux.js";
import { linuxResetScript, setAsideName, windowsResetScript } from "./reset.js";
import { windowsServicePaths } from "./windows/paths-windows.js";

describe("starting Passwords over", () => {
    test("sets the vault aside in a folder named by when, never deleting it", () => {
        const aside = setAsideName(new Date("2026-10-27T16:07:53.123Z"));
        expect(aside).toBe("set-aside-2026-10-27T16-07-53Z");
        const windows = windowsResetScript(windowsServicePaths("S-1-5-21-1-2-3-1001", { ProgramData: "C:\\ProgramData" }), aside);
        expect(windows).toContain("Stop-ScheduledTask -TaskPath '\\Intentic\\' -TaskName 'Keyring-S-1-5-21-1-2-3-1001'");
        expect(windows).toContain("Move-Item -LiteralPath $file.FullName -Destination $aside");
        expect(windows).toContain("Start-ScheduledTask");
        const linux = linuxResetScript(linuxServicePaths("1000"), aside);
        expect(linux).toContain("systemctl stop 'intentic-keyring@1000.service'");
        expect(linux).toContain("-exec mv -t '/var/lib/intentic-keyring/1000/set-aside-2026-10-27T16-07-53Z' -- {} +");
        for (const script of [windows, linux]) {
            expect(script).not.toMatch(/Remove-Item|\brm\b/u);
        }
    });
});
