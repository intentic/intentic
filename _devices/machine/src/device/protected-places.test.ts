import { posix, win32 } from "node:path";
import { protectedAt, protectedPlaces, protectedWithin } from "./protected-places.js";

/* Which places the file tools keep out of, judged without a disk: every platform's names under a home, how a root opens
   one, and the spellings Windows and macOS read as the same name. */

const HOME = "/home/me";
const places = protectedPlaces(HOME, {}, "linux");
const at = (path: string, roots: readonly string[] = [HOME]): string | undefined => protectedAt(path, places, roots, "linux")?.path;

test("a credential folder under the home folder is kept out of, by the place it is in", () => {
    expect(at("/home/me/.ssh/id_ed25519")).toBe("/home/me/.ssh");
    expect(at("/home/me/.ssh")).toBe("/home/me/.ssh");
    expect(at("/home/me/.aws/credentials")).toBe("/home/me/.aws");
    expect(at("/home/me/.config/gcloud/application_default_credentials.json")).toBe("/home/me/.config/gcloud");
    expect(at("/home/me/.docker/config.json")).toBe("/home/me/.docker/config.json");
    expect(at("/home/me/.claude/.credentials.json")).toBe("/home/me/.claude/.credentials.json");
    expect(at("/home/me/.intentic/machine/device.json")).toBe("/home/me/.intentic");
    expect(at("/home/me/.config/google-chrome/Default/Cookies")).toBe("/home/me/.config/google-chrome");
    expect(at("/home/me/.mozilla/firefox/abc.default/logins.json")).toBe("/home/me/.mozilla/firefox");
});

test("what sits beside a protected place is not in it", () => {
    expect(at("/home/me/projects/app/.env")).toBeUndefined();
    expect(at("/home/me/.docker/daemon.json")).toBeUndefined();
    expect(at("/home/me/.claude/settings.json")).toBeUndefined();
    expect(at("/home/me/.sshrc")).toBeUndefined();
});

// The daemon's provider-key import reads these with read_file (migrations/provider-keys.ts); keeping them out would end it.
test("the files the provider-key import reads stay readable", () => {
    for (const file of [
        ".hermes/.env",
        ".hermes/auth.json",
        ".local/share/opencode/auth.json",
        ".gemini/.env",
        ".codex/auth.json",
        ".openclaw/agents/main/agent/auth-profiles.json",
    ]) {
        expect(at(`/home/me/${file}`)).toBeUndefined();
    }
});

// An unnarrowed card reads as the home folder, so a root that merely holds a place cannot be what opens it.
test("a root opens a place only by naming it or a folder inside it, and then only what that root holds", () => {
    expect(at("/home/me/.ssh/id_ed25519", [HOME, "/home/me/.ssh"])).toBeUndefined();
    expect(at("/home/me/.ssh/id_ed25519", ["/"])).toBe("/home/me/.ssh");
    expect(at("/home/me/.ssh/public/key.pub", ["/home/me/.ssh/public"])).toBeUndefined();
    expect(at("/home/me/.ssh/id_ed25519", ["/home/me/.ssh/public"])).toBe("/home/me/.ssh");
});

test("Windows' own credential stores and browser profiles are kept out of, wherever its environment puts them", () => {
    const windows = protectedPlaces("C:\\Users\\Me", { APPDATA: "D:\\Roaming", LOCALAPPDATA: "C:\\Users\\Me\\AppData\\Local" }, "win32");
    const hit = (path: string): string | undefined => protectedAt(path, windows, ["C:\\Users\\Me", "D:\\"], "win32")?.path;
    expect(hit("D:\\Roaming\\Microsoft\\Credentials\\ABC")).toBe("D:\\Roaming\\Microsoft\\Credentials");
    expect(hit("D:\\Roaming\\Microsoft\\Protect\\S-1-5-21\\key")).toBe("D:\\Roaming\\Microsoft\\Protect");
    expect(hit("C:\\Users\\Me\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Login Data")).toBe("C:\\Users\\Me\\AppData\\Local\\Google\\Chrome");
    expect(hit("C:\\Users\\Me\\AppData\\Local\\Microsoft\\Edge\\User Data\\Default\\Cookies")).toBe("C:\\Users\\Me\\AppData\\Local\\Microsoft\\Edge");
    expect(hit("D:\\Roaming\\Mozilla\\Firefox\\Profiles\\x\\key4.db")).toBe("D:\\Roaming\\Mozilla\\Firefox");
    expect(hit("C:\\Users\\Me\\Documents\\notes.txt")).toBeUndefined();
});

// NTFS ignores case, and Windows opens `.ssh.`, `.ssh ` and `.netrc::$DATA` as the names without the suffix.
test("on Windows a place is matched in any case and in every spelling Windows opens as it", () => {
    const windows = protectedPlaces("C:\\Users\\Me", {}, "win32");
    const hit = (path: string): string | undefined => protectedAt(path, windows, ["C:\\Users\\Me"], "win32")?.path;
    expect(hit("c:\\users\\me\\.SSH\\id_rsa")).toBe("C:\\Users\\Me\\.ssh");
    expect(hit("C:\\Users\\Me\\.ssh.\\authorized_keys")).toBe("C:\\Users\\Me\\.ssh");
    expect(hit("C:\\Users\\Me\\.ssh \\authorized_keys")).toBe("C:\\Users\\Me\\.ssh");
    expect(hit("C:\\Users\\Me\\.netrc::$DATA")).toBe("C:\\Users\\Me\\.netrc");
    expect(hit("C:\\Users\\Me\\APPDATA\\ROAMING\\microsoft\\credentials\\x")).toBe(win32.join("C:\\Users\\Me", "AppData", "Roaming", "Microsoft", "Credentials"));
});

test("on macOS a place is matched in any case, and on Linux only as it is spelled", () => {
    const mac = protectedPlaces("/Users/me", {}, "darwin");
    expect(protectedAt("/Users/me/library/KEYCHAINS/login.keychain-db", mac, ["/Users/me"], "darwin")?.path).toBe("/Users/me/Library/Keychains");
    expect(protectedAt("/Users/me/Library/Application Support/Google/Chrome/Default/Cookies", mac, ["/Users/me"], "darwin")?.path).toBe(
        posix.join("/Users/me", "Library", "Application Support", "Google", "Chrome"),
    );
    expect(at("/home/me/.SSH/id_rsa")).toBeUndefined();
});

test("XDG_CONFIG_HOME moves the config folder's places, and the default one stays protected", () => {
    const moved = protectedPlaces(HOME, { XDG_CONFIG_HOME: "/data/config" }, "linux");
    expect(protectedAt("/data/config/gcloud/credentials.db", moved, ["/"], "linux")?.path).toBe("/data/config/gcloud");
    expect(protectedAt("/home/me/.config/gcloud/credentials.db", moved, ["/"], "linux")?.path).toBe("/home/me/.config/gcloud");
});

// A tar of a folder, or its move to the trash, takes everything under it: opening part of a place does not open the rest.
test("a folder taken whole names the places inside it that no root opens all of", () => {
    const within = (folder: string, roots: readonly string[]): string[] => protectedWithin(folder, places, roots, "linux").map((place) => place.path);
    expect(within("/home/me/.config", [HOME])).toEqual(expect.arrayContaining(["/home/me/.config/gcloud", "/home/me/.config/google-chrome"]));
    expect(within("/home/me", [HOME, "/home/me/.ssh"])).not.toContain("/home/me/.ssh");
    expect(within("/home/me", [HOME, "/home/me/.ssh/public"])).toContain("/home/me/.ssh");
    expect(within("/home/me/projects", [HOME])).toEqual([]);
});
