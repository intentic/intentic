import { runtimeDirToAdopt } from "./user-manager.js";

// (2026-11-17) z440 was set up as root from `su -l` inside an ssh login, which sets no XDG_RUNTIME_DIR: `systemctl --user`
// found no manager, the agent wrote an entry only a desktop reads, and the machine's restart left it down. The runtime
// directory is adopted only where nothing named one and logind has made it.
describe("runtimeDirToAdopt", () => {
    const made = (...dirs: string[]) => (path: string) => dirs.includes(path);

    it("names /run/user/<uid> for a shell that has no runtime directory, once logind has made it", () => {
        expect(runtimeDirToAdopt({}, 0, made("/run/user/0"))).toBe("/run/user/0");
        expect(runtimeDirToAdopt({ XDG_RUNTIME_DIR: "" }, 1000, made("/run/user/1000"))).toBe("/run/user/1000");
    });

    it("leaves a runtime directory a login already named, and adopts none that is not there", () => {
        expect(runtimeDirToAdopt({ XDG_RUNTIME_DIR: "/run/user/1000" }, 1000, made("/run/user/1000"))).toBeUndefined();
        expect(runtimeDirToAdopt({}, 0, made())).toBeUndefined();
        // A platform with no uid to name (Windows) has no such directory either.
        expect(runtimeDirToAdopt({}, undefined, made("/run/user/0"))).toBeUndefined();
    });
});
