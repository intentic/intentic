import { addPlan, type AddFlags, backendConfig, editPatch, type EditFlags, editTakesValue, KeyringCliError, listOf, shareMode, shareTarget, unshareTarget } from "./flags.js";

// What `keyring add`, `edit`, `share` and `backend` make of their flags, before anything reaches the keyring: the rules a
// new entry starts with, which rules an edit changes, and which sandbox a share names.

const addFlags = (overrides: Partial<AddFlags> = {}): AddFlags => ({ stdin: false, anyField: false, replace: false, json: false, ...overrides });
const editFlags = (overrides: Partial<EditFlags> = {}): EditFlags => ({ stdin: false, json: false, ...overrides });

const usage = (run: () => void): string => {
    try {
        run();
    } catch (error) {
        expect(error).toBeInstanceOf(KeyringCliError);
        expect(error).toMatchObject({ code: "usage" });
        return error instanceof Error ? error.message : "";
    }
    throw new Error("expected a usage refusal");
};

describe("add", () => {
    it("starts a password typed only into a password field, asked about everywhere, with a value to read", () => {
        expect(addPlan("VPN_PASSWORD", addFlags())).toEqual({
            name: "VPN_PASSWORD",
            rules: { kind: "password", programs: [], packages: [], hosts: [], anyField: false, askpass: [], askpassRememberMinutes: 0 },
            replace: false,
            needsValue: true,
        });
    });

    it("takes every rule flag, repeatable ones as lists", () => {
        const plan = addPlan(
            "VPN_PASSWORD",
            addFlags({
                kind: "text",
                program: ["FortiClient.exe", "mstsc.exe"],
                package: ["com.fortinet.forticlient"],
                host: ["*.corp.example"],
                anyField: true,
                username: "ana",
                askpass: ["ssh:ana@bastion", "sudo"],
                rememberMinutes: 5,
                replace: true,
            }),
        );
        expect(plan.rules).toEqual({
            kind: "text",
            programs: ["FortiClient.exe", "mstsc.exe"],
            packages: ["com.fortinet.forticlient"],
            hosts: ["*.corp.example"],
            anyField: true,
            username: "ana",
            askpass: ["ssh:ana@bastion", "sudo"],
            askpassRememberMinutes: 5,
        });
        expect(plan.replace).toBe(true);
    });

    it("reads a backed entry's value from its manager at each use, so none is read now", () => {
        const plan = addPlan("GH_TOKEN", addFlags({ backend: "1password", ref: "op://Work/GitHub/token" }));
        expect(plan.backend).toEqual({ backend: "1password", ref: "op://Work/GitHub/token" });
        expect(plan.needsValue).toBe(false);
        expect(addPlan("DB", addFlags({ backend: "bitwarden", ref: "db" })).backend).toEqual({ backend: "bitwarden", ref: "db", field: "password" });
        expect(addPlan("KP", addFlags({ backend: "keepassxc", ref: "Work/DB", attribute: "UserName" })).backend).toEqual({
            backend: "keepassxc",
            ref: "Work/DB",
            attribute: "UserName",
        });
    });

    it("refuses what does not fit, by the flag's own name", () => {
        expect(usage(() => addPlan("1BAD", addFlags()))).toContain("is not a name");
        expect(usage(() => addPlan("X", addFlags({ package: ["not a package"] })))).toContain("--package");
        expect(usage(() => addPlan("X", addFlags({ askpass: ["telnet:host"] })))).toContain("--askpass");
        expect(usage(() => addPlan("X", addFlags({ rememberMinutes: 999 })))).toContain("--remember-minutes");
        expect(usage(() => addPlan("X", addFlags({ ref: "op://x" })))).toContain("--backend");
        expect(usage(() => addPlan("X", addFlags({ backend: "1password" })))).toContain("--ref");
        expect(usage(() => addPlan("X", addFlags({ backend: "1password", ref: "op://x/y", field: "totp" })))).toContain("--field");
        expect(usage(() => addPlan("X", addFlags({ backend: "bitwarden", ref: "db", attribute: "x" })))).toContain("--attribute");
        expect(usage(() => addPlan("X", addFlags({ backend: "bitwarden", ref: "db", stdin: true })))).toContain("--stdin");
        expect(usage(() => addPlan("X", addFlags({ backend: "1password", ref: "not-a-reference" })))).toContain("--ref");
    });
});

describe("edit", () => {
    it("changes only the rules whose flag was given, each list whole", () => {
        const patch = editPatch(editFlags({ program: ["putty.exe"], anyField: "off", rememberMinutes: 0 }));
        expect(patch).toMatchObject({ programs: ["putty.exe"], anyField: false, askpassRememberMinutes: 0 });
        expect(patch.hosts).toBeUndefined();
        expect(patch.kind).toBeUndefined();
        expect(JSON.parse(JSON.stringify(patch))).toEqual({ programs: ["putty.exe"], anyField: false, askpassRememberMinutes: 0 });
    });

    it("empties a list given as a lone empty value", () => {
        expect(listOf([""])).toEqual([]);
        expect(listOf(undefined)).toBeUndefined();
        expect(editPatch(editFlags({ host: [""] })).hosts).toEqual([]);
    });

    it("takes a new value from stdin with --stdin, from the terminal when nothing else was asked, and otherwise none", () => {
        expect(editTakesValue(editFlags({ stdin: true }), editPatch(editFlags({ stdin: true })))).toBe("stdin");
        expect(editTakesValue(editFlags(), editPatch(editFlags()))).toBe("terminal");
        const rules = editFlags({ anyField: "on" });
        expect(editTakesValue(rules, editPatch(rules))).toBe("none");
    });
});

describe("share and unshare", () => {
    const work = { sandboxUrl: "https://work.example.intentic.dev", id: "laptop" };
    const home = { sandboxUrl: "https://home.example.intentic.dev", id: "laptop-home" };
    const links = [work, home];

    it("names a linked sandbox by its address or its link's id", () => {
        expect(shareTarget(links, "laptop-home")).toEqual(home);
        expect(shareTarget(links, "https://WORK.example.intentic.dev/")).toEqual(work);
    });

    it("refuses a sandbox this computer is not linked to, listing the ones it is", () => {
        expect(usage(() => shareTarget(links, "https://other.example"))).toContain("laptop (https://work.example.intentic.dev)");
        expect(usage(() => shareTarget([], "https://other.example"))).toContain("No sandbox is linked");
        expect(usage(() => shareTarget(links, undefined))).toContain("--sandbox");
    });

    it("unshares from a sandbox no longer linked, by its address", () => {
        expect(unshareTarget(links, "laptop")).toBe("https://work.example.intentic.dev");
        expect(unshareTarget(links, "https://gone.example")).toBe("https://gone.example");
        expect(usage(() => unshareTarget(links, "no-such-id"))).toContain("not an address");
    });

    it("reads each of the three modes, and nothing else", () => {
        expect(shareMode("copy")).toBe("copy");
        expect(usage(() => shareMode("always"))).toContain("each-use, while-here or copy");
    });
});

describe("backend", () => {
    it("fills in each manager's own command, and refuses a flag that is another's", () => {
        expect(backendConfig("1password", { json: false })).toEqual({ backend: "1password", cli: "op" });
        expect(backendConfig("keepassxc", { database: "/home/ana/k.kdbx", passwordEntry: "KP_MASTER", json: false })).toEqual({
            backend: "keepassxc",
            cli: "keepassxc-cli",
            database: "/home/ana/k.kdbx",
            passwordEntry: "KP_MASTER",
        });
        expect(usage(() => backendConfig("1password", { database: "/x", json: false }))).toContain("--database");
        expect(usage(() => backendConfig("bitwarden", { json: false }))).toContain("--password-entry");
    });
});
