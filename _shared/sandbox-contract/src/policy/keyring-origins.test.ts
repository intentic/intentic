import { KEYRING_NAME_RE, type KeyringOrigin } from "../schemas/keyring.js";
import {
    type CaptureCandidate,
    entriesFor,
    entryNameFor,
    findCaptureTarget,
    gitOrigin,
    mergeRules,
    originKey,
    originsOfRules,
    rememberSwitchFor,
    rulesForOrigin,
    rulesServe,
    titleForOrigin,
} from "./keyring-origins.js";

const NONE = { programs: [], packages: [], hosts: [], askpass: [] };

const entry = (name: string, origin: KeyringOrigin, username?: string): CaptureCandidate => ({ name, rules: rulesForOrigin(origin), username, title: titleForOrigin(origin) });

describe("origins and rules", () => {
    test("a site keeps its host, without www and case", () => {
        expect(rulesForOrigin({ kind: "site", host: "WWW.GitHub.com" })).toEqual({ ...NONE, hosts: ["github.com"] });
        expect(originKey({ kind: "site", host: "www.github.com." })).toBe(originKey({ kind: "site", host: "github.com" }));
    });

    test("terminal places become askpass matchers, and read back as the same places", () => {
        const places: KeyringOrigin[] = [
            { kind: "ssh", target: "radar@build-01" },
            { kind: "ssh-key", path: "/home/radar/.ssh/id_ed25519" },
            { kind: "sudo" },
            { kind: "sudo", user: "root" },
        ];
        for (const place of places) {
            expect(originsOfRules({ ...NONE, ...rulesForOrigin(place) })).toEqual([place]);
        }
    });

    test("git answers for every repository on its host", () => {
        expect(gitOrigin("https://github.com/intentic/intentic.git")).toBe("https://github.com");
        const rules = rulesForOrigin({ kind: "git", url: "https://github.com/intentic/intentic" });
        expect(rules).toEqual({ ...NONE, askpass: ["git:https://github.com"], hosts: ["github.com"] });
        expect(rulesServe(rules, { kind: "git", url: "https://github.com/other/repo" })).toBe(true);
        // Its site is said once, by the git chip.
        expect(originsOfRules(rules)).toEqual([{ kind: "git", url: "https://github.com" }]);
    });

    test("a sandbox terminal's prompt places nothing on this computer", () => {
        expect(rulesForOrigin({ kind: "prompt", text: "Password:", command: "npm login", sandbox: "https://x.intentic.dev" })).toEqual(NONE);
    });

    test("merging adds a place without repeating one", () => {
        const a = rulesForOrigin({ kind: "site", host: "github.com" });
        const b = rulesForOrigin({ kind: "git", url: "https://github.com" });
        expect(mergeRules(a, b)).toEqual({ ...NONE, hosts: ["github.com"], askpass: ["git:https://github.com"] });
    });
});

describe("serving a place", () => {
    test("a saved site fills its subdomains, and a wildcard its domain", () => {
        expect(rulesServe({ ...NONE, hosts: ["github.com"] }, { kind: "site", host: "gist.github.com" })).toBe(true);
        expect(rulesServe({ ...NONE, hosts: ["*.corp.example"] }, { kind: "site", host: "corp.example" })).toBe(true);
        expect(rulesServe({ ...NONE, hosts: ["github.com"] }, { kind: "site", host: "notgithub.com" })).toBe(false);
    });

    test("a program matches by its file name, without case or folder", () => {
        expect(rulesServe({ ...NONE, programs: ["C:\\Program Files\\Fortinet\\FortiClient.exe"] }, { kind: "program", program: "forticlient.EXE" })).toBe(true);
    });
});

describe("the entry a capture updates", () => {
    const github = entry("GITHUB_COM", { kind: "site", host: "github.com" }, "radarsu");
    const work = entry("GITHUB_COM_WORK", { kind: "site", host: "github.com" }, "radar-work");

    test("the same place and account is an update", () => {
        expect(findCaptureTarget([github, work], { kind: "site", host: "www.github.com" }, "Radarsu")?.name).toBe("GITHUB_COM");
    });

    test("another account at the same place is a new entry", () => {
        expect(findCaptureTarget([github], { kind: "site", host: "github.com" }, "someone-else")).toBeUndefined();
    });

    test("a sandbox prompt is found again by its title", () => {
        const origin: KeyringOrigin = { kind: "prompt", text: "Password:", command: "npm login", sandbox: "https://x.intentic.dev" };
        expect(findCaptureTarget([entry("NPM_LOGIN", origin)], origin, undefined)?.name).toBe("NPM_LOGIN");
    });

    test("a need offers the asked-for account first", () => {
        expect(entriesFor([github, work], { kind: "site", host: "github.com" }, "radar-work").map((found) => found.name)).toEqual(["GITHUB_COM_WORK", "GITHUB_COM"]);
    });
});

describe("titles and names", () => {
    test("each place reads as a person would say it", () => {
        expect(titleForOrigin({ kind: "site", host: "www.github.com" })).toBe("github.com");
        expect(titleForOrigin({ kind: "program", program: "C:\\x\\FortiClient.exe" })).toBe("FortiClient");
        expect(titleForOrigin({ kind: "program", program: "FortiClient.exe", label: "FortiClient VPN" })).toBe("FortiClient VPN");
        expect(titleForOrigin({ kind: "ssh", target: "radar@build-01" })).toBe("ssh radar@build-01");
        expect(titleForOrigin({ kind: "git", url: "https://github.com/a/b" })).toBe("git github.com");
        expect(titleForOrigin({ kind: "prompt", text: "Password for npm: ", command: "npm login" })).toBe("npm login");
        expect(titleForOrigin({ kind: "site", host: "github.com" }, "  GitHub ")).toBe("GitHub");
    });

    test("a name takes the title, then the account, then a number", () => {
        const taken = new Set<string>();
        const name = (title: string, user?: string): string => {
            const made = entryNameFor(title, user, (candidate) => taken.has(candidate));
            taken.add(made);
            return made;
        };
        expect(name("github.com", "radarsu@example.com")).toBe("GITHUB_COM");
        expect(name("github.com", "radarsu@example.com")).toBe("GITHUB_COM_RADARSU");
        expect(name("github.com", "radarsu@example.com")).toBe("GITHUB_COM_RADARSU_2");
        expect(name("ssh radar@build-01")).toBe("SSH_RADAR_BUILD_01");
        expect(name("1Password")).toBe("_1PASSWORD");
        expect(name("Zürich Bank")).toBe("ZURICH_BANK");
        expect(name("···")).toBe("PASSWORD");
    });

    test("every name fits a reference", () => {
        for (const title of ["a".repeat(400), "ąę", "--", "x y z", "9"]) {
            expect(entryNameFor(title, "u", () => false)).toMatch(KEYRING_NAME_RE);
        }
    });
});

test("deliberate acts need no remember switch", () => {
    expect(rememberSwitchFor("browser")).toBe("browser");
    expect(rememberSwitchFor("git")).toBe("terminal");
    expect(rememberSwitchFor("terminal")).toBe("sandbox");
    expect(rememberSwitchFor("import")).toBeUndefined();
});
