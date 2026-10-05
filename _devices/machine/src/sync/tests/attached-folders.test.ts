import { WORKSPACE_ROOT } from "@intentic/constants";
import type { DeviceReport } from "@intentic/sandbox-contract";
import { pairingLine, statusSummary } from "../../status.js";
import { projectsHostChange, selectPairings, transportFor } from "../commands.js";
import { attachedKey, isAttachedPairing, type Pairing, pairingKey, pairingProblem, withPairing } from "../config.js";
import { folderRefusal } from "../folders.js";
import { pollingPairings, readyToPrepare, reportCarriers } from "../mirror.js";
import { backupSessionName, sessionName, sessionsByName, syncSessionNames } from "../mutagen.js";
import { buildReport, scopedReport } from "../report.js";
import { pairingSshConfig } from "../ssh.js";

// SEVERAL FOLDERS PER SANDBOX: this computer's own sandbox is enrolled once (the projects host, folderless), and each
// folder attaches to it as a pairing of its own, filed under `<sandboxId>~<name>`. Every rule below is about telling
// the sandbox's identity (its token, alias, forwards, report) from a folder's (its session, lock, restore points).

const SANDBOX = "sandbox-5a1b2c3d4e5f-intentic-dev";
const URL_OF = "https://sandbox-5a1b2c3d4e5f.intentic.dev";

const host: Pairing = { sandboxUrl: URL_OF, sandboxId: SANDBOX, mode: "sync", syncToken: "ist_one", projectsHost: true };

const attached = (name: string, localDir: string, extra: Partial<Pairing> = {}): Pairing => ({
    sandboxUrl: URL_OF,
    sandboxId: SANDBOX,
    key: attachedKey(SANDBOX, name),
    mode: "sync",
    syncToken: "ist_one",
    localDir,
    remoteDir: `${WORKSPACE_ROOT}/${name}`,
    project: true,
    direction: "to-sandbox",
    deliver: "auto",
    ...extra,
});

const shop = attached("shop", "/home/ada/code/shop");
const blog = attached("blog", "/home/ada/code/blog");
const elsewhere: Pairing = { sandboxUrl: "https://sandbox-0738cd6b5027.intentic.dev", sandboxId: "sandbox-0738cd6b5027-intentic-dev", mode: "sync", localDir: "/home/ada/intentic/work" };

describe("pairing keys", () => {
    it("files every pairing made before folders could attach under its sandbox id, as before", () => {
        expect(pairingKey(elsewhere)).toBe(elsewhere.sandboxId);
        expect(pairingKey(host)).toBe(SANDBOX);
        expect(pairingKey(shop)).toBe(`${SANDBOX}~shop`);
        expect([elsewhere, host, shop].map(isAttachedPairing)).toEqual([false, false, true]);
    });

    // Nothing an existing pairing has is renamed, so no session of one is recreated and no restore point moves.
    it("names an existing pairing's sessions exactly as it always has", () => {
        expect(sessionName(elsewhere.sandboxId)).toBe("intentic-sandbox-0738cd6b5027-intentic-dev");
        expect(syncSessionNames(elsewhere)).toEqual(["intentic-sandbox-0738cd6b5027-intentic-dev", "intentic-sandbox-0738cd6b5027-intentic-dev-state"]);
    });

    it("gives each attached folder a session no sandbox and no other folder can hold", () => {
        const names = ["shop", "blog", "my.app", "my_app", "my-app", "state"].map((name) => sessionName(attachedKey(SANDBOX, name)));
        expect(new Set(names).size).toBe(names.length);
        expect(names[0]).toMatch(/^intentic-sandbox-5a1b2c3d4e5f-intentic-dev--shop-[0-9a-f]{8}$/);
        // A folder named `state` is not the sandbox's state backup.
        expect(names).not.toContain(backupSessionName(SANDBOX));
        // Letters, digits and dashes only, what Mutagen takes for a name.
        expect(names.every((name) => /^[a-z][a-z0-9-]*$/i.test(name))).toBe(true);
        expect(syncSessionNames(shop)).toEqual([sessionName(`${SANDBOX}~shop`)]);
    });

    // The host holds no folder, so naming sessions for it would make `sync terminate` fail whole.
    it("names no session for the projects host", () => {
        expect(syncSessionNames(host)).toEqual([]);
    });

    it("writes one ssh alias per sandbox, however many of its folders ride ssh", () => {
        const config = pairingSshConfig([host, shop, blog, elsewhere]);
        expect(config.match(/^Host /gm)).toHaveLength(2);
    });
});

describe("pairingProblem", () => {
    it("lets the projects host and a folder attached to it through", () => {
        expect(pairingProblem(host)).toBeUndefined();
        expect(pairingProblem(shop)).toBeUndefined();
        expect(pairingProblem({ ...host, transport: "docker", container: "intentic-sandbox-sandbox-5a1b2c3d4e5f" })).toBeUndefined();
    });

    it("refuses a projects host that holds a folder", () => {
        expect(pairingProblem({ ...host, localDir: "/home/ada" })).toContain("holds no folder of its own");
        expect(pairingProblem({ ...host, remoteDir: `${WORKSPACE_ROOT}/shop`, project: true })).toContain("holds no folder of its own");
        expect(pairingProblem({ ...host, key: `${SANDBOX}~shop` })).toContain("holds no folder of its own");
    });

    // A key that named another folder or another sandbox would point this one's restore points and session elsewhere.
    it("refuses a key that is not its sandbox and its folder", () => {
        expect(pairingProblem({ ...shop, key: `${SANDBOX}~blog` })).toContain("<sandboxId>~<name>");
        expect(pairingProblem({ ...shop, key: "sandbox-other~shop" })).toContain("<sandboxId>~<name>");
        expect(pairingProblem({ ...elsewhere, key: `${elsewhere.sandboxId}~work` })).toContain("<sandboxId>~<name>");
    });
});

describe("withPairing", () => {
    it("adds a folder beside its sandbox's host and the other folders", () => {
        expect(withPairing([host, shop], blog)).toEqual([host, shop, blog]);
    });

    it("replaces only the pairing under the same key", () => {
        const moved = attached("shop", "/home/ada/code/shop-2");
        expect(withPairing([host, shop, blog], moved)).toEqual([host, blog, moved]);
    });

    // The daemon keeps one token per machine key: enrolling again rotates it for every pairing of that sandbox.
    it("rotates the sync token of every pairing of the sandbox that enrolled again, and of no other", () => {
        const next = withPairing([host, shop, blog, { ...elsewhere, syncToken: "ist_other" }], { ...host, syncToken: "ist_two" });
        expect(next.filter((pairing) => pairing.sandboxId === SANDBOX).map((pairing) => pairing.syncToken)).toEqual(["ist_two", "ist_two", "ist_two"]);
        expect(next.find((pairing) => pairing.sandboxId === elsewhere.sandboxId)?.syncToken).toBe("ist_other");
    });
});

describe("selectPairings", () => {
    it("selects every pairing of the sandbox it names: its host and each folder attached to it", () => {
        const state = { pairings: [host, shop, elsewhere, blog] };
        expect(selectPairings(state, SANDBOX)).toEqual([host, shop, blog]);
        expect(selectPairings(state, "5a1b2c")).toEqual([host, shop, blog]);
        expect(selectPairings(state, "0738")).toEqual([elsewhere]);
        expect(() => selectPairings(state, "sandbox")).toThrow("matches more than one paired sandbox");
    });
});

describe("projectsHostChange", () => {
    it("refuses a folder flag beside --projects-host", () => {
        expect(projectsHostChange(undefined, { projectsHost: true, dir: "/home/ada/code", project: false })).toContain("takes no --dir, --remote-dir or --project");
        expect(projectsHostChange(undefined, { projectsHost: true, project: true })).toContain("takes no --dir");
        expect(projectsHostChange(undefined, { projectsHost: true, project: false })).toBeUndefined();
    });

    it("refuses turning a sandbox that syncs a folder into the projects host, and the other way round", () => {
        expect(projectsHostChange(elsewhere, { projectsHost: true, project: false })).toContain(`already syncs ${elsewhere.localDir}`);
        expect(projectsHostChange(host, { project: false })).toContain("is this computer's sandbox for folders");
        // Set up again as what it is, it is a token rotated.
        expect(projectsHostChange(host, { projectsHost: true, project: false })).toBeUndefined();
        const mirrorOnly: Pairing = { sandboxUrl: elsewhere.sandboxUrl, sandboxId: elsewhere.sandboxId, mode: "mirror" };
        expect(projectsHostChange(mirrorOnly, { projectsHost: true, project: false })).toBeUndefined();
    });
});

describe("transportFor the projects host", () => {
    it("reaches the computer's own sandbox through Docker when its container runs here", async () => {
        expect(await transportFor("auto", { projectsHost: true }, URL_OF, async () => "intentic-sandbox-sandbox-5a1b2c3d4e5f")).toEqual({
            transport: "docker",
            container: "intentic-sandbox-sandbox-5a1b2c3d4e5f",
        });
        expect(await transportFor("auto", { projectsHost: true }, URL_OF, async () => undefined)).toEqual({});
    });
});

describe("pollingPairings", () => {
    // One poll per sandbox: the host polls for its folders, a sandbox with folders and no host is polled by its first.
    it("polls each sandbox once, through its own pairing when it has one", () => {
        expect([...pollingPairings([shop, host, blog, elsewhere])].toSorted()).toEqual([SANDBOX, elsewhere.sandboxId].toSorted());
        expect([...pollingPairings([shop, blog])]).toEqual([`${SANDBOX}~shop`]);
    });
});

// The daemon makes `/work/<name>` a repository of its own when a report names it, so a folder's first copy waits for
// that report to be taken: otherwise the sandbox's root repository could commit the folder's files as its own.
describe("readyToPrepare", () => {
    const fresh = (): boolean => true;

    it("holds a new folder's session until its sandbox took a report naming it, asking once per sandbox", async () => {
        const asked: string[] = [];
        const refuse = async (pairing: Pairing): Promise<boolean> => {
            asked.push(pairingKey(pairing));
            return false;
        };
        expect(await readyToPrepare([host, shop, blog, elsewhere], fresh, refuse)).toEqual([host, elsewhere]);
        expect(asked).toEqual([`${SANDBOX}~shop`]);
        expect(await readyToPrepare([host, shop, blog, elsewhere], fresh, async () => true)).toEqual([host, shop, blog, elsewhere]);
    });

    // An agent restarted over a folder already syncing has nothing to wait for: its sandbox was told before its first copy.
    it("asks nothing for a folder whose session already exists", async () => {
        const asked: string[] = [];
        const ready = await readyToPrepare([shop], () => false, async (pairing) => {
            asked.push(pairingKey(pairing));
            return false;
        });
        expect(ready).toEqual([shop]);
        expect(asked).toEqual([]);
    });
});

describe("reportCarriers", () => {
    it("posts once per sandbox, skipping a pairing with no token and a sandbox with no report route", () => {
        const dialed = [shop, host, blog, elsewhere].map((pairing) => ({ pairing, base: pairing.sandboxUrl }));
        expect(reportCarriers(dialed, new Set()).map(({ pairing }) => pairingKey(pairing))).toEqual([`${SANDBOX}~shop`]);
        expect(reportCarriers(dialed, new Set([SANDBOX]))).toEqual([]);
    });
});

describe("the report of a computer whose folders attach to its sandbox", () => {
    const AGENT = { running: true, pid: 1, build: "1.0.0", installed: "1.0.0" };
    const sessions = sessionsByName([
        { name: sessionName(`${SANDBOX}~shop`), status: "watching", alpha: {}, beta: {}, ignore: {} },
        { name: sessionName(`${SANDBOX}~blog`), status: "staging-beta", alpha: {}, beta: {}, ignore: {} },
    ]);
    const built: DeviceReport = buildReport(
        { pairings: [host, shop, blog, { ...elsewhere, mirroredPorts: [{ port: 5173, host: "127.0.0.1" }] }, { ...host, sandboxId: "x", sandboxUrl: "https://x.dev", mirroredPorts: [{ port: 3000, host: "127.0.0.1" }] }] },
        sessions,
        AGENT,
        1,
    );

    it("reads each attached folder's own session, and none for the host", () => {
        expect(built.pairings.slice(0, 3)).toEqual([
            { sandboxId: SANDBOX, mode: "sync", projectsHost: true, mirroring: "on" },
            { sandboxId: SANDBOX, mode: "sync", localDir: shop.localDir, remoteDir: `${WORKSPACE_ROOT}/shop`, deliver: "auto", mirroring: "on", mutagenStatus: "watching" },
            { sandboxId: SANDBOX, mode: "sync", localDir: blog.localDir, remoteDir: `${WORKSPACE_ROOT}/blog`, deliver: "auto", mirroring: "on", mutagenStatus: "staging-beta" },
        ]);
    });

    // The daemon keeps one report per machine: a slice of one pairing would lose it every other folder.
    it("hands the sandbox every pairing of its own, host and folders, and nothing of another's", () => {
        const scoped = scopedReport(built, SANDBOX);
        expect(scoped.pairings.map((pairing) => pairing.localDir)).toEqual([undefined, shop.localDir, blog.localDir]);
        expect(scoped.ports).toEqual([]);
        expect(scopedReport(built, "x").ports.map((port) => port.port)).toEqual([3000]);
    });

    it("counts sandboxes rather than pairings, and says what each line is", () => {
        expect(statusSummary(1, 0, built, 1)).toBe("syncing 3 sandboxes");
        expect(pairingLine(built.pairings[0]!)).toBe(`  ${SANDBOX}  (this computer's sandbox: folders attach to it)`);
        expect(pairingLine(built.pairings[1]!)).toBe(`  ${SANDBOX}  ${shop.localDir} ↔ ${WORKSPACE_ROOT}/shop  [watching, landed work delivered here]`);
    });
});

describe("folderRefusal", () => {
    it("refuses a disk, the home folder, one holding it, everyone's homes and the system's folders", () => {
        expect(folderRefusal("/", "/home/ada", "linux")).toBe("/ is a whole disk. Pick the folder of one project in it.");
        expect(folderRefusal("/home/ada", "/home/ada", "linux")).toContain("is your whole home folder");
        expect(folderRefusal("/home", "/home/ada", "linux")).toContain("holds your home folder");
        expect(folderRefusal("/var/home", "/var/home/ada", "linux")).toContain("holds your home folder");
        expect(folderRefusal("/var/home", "/home/ada", "linux")).toContain("holds everyone's home folders");
        expect(folderRefusal("/var/home/bob", "/home/ada", "linux")).toContain("is a whole home folder");
        expect(folderRefusal("/usr/local/src/app", "/home/ada", "linux")).toContain("belongs to the system");
        expect(folderRefusal("/etc", "/home/ada", "linux")).toContain("belongs to the system");
        expect(folderRefusal(String.raw`C:\\`, String.raw`C:\Users\ada`, "win32")).toContain("is a whole disk");
        expect(folderRefusal(String.raw`c:\program files\app`, String.raw`C:\Users\ada`, "win32")).toContain("belongs to the system");
        expect(folderRefusal(String.raw`C:\USERS\ADA`, String.raw`C:\Users\ada`, "win32")).toContain("is your whole home folder");
    });

    it("lets a project folder through, in a home or anywhere of the owner's", () => {
        expect(folderRefusal("/home/ada/code/shop", "/home/ada", "linux")).toBeUndefined();
        expect(folderRefusal("/var/home/ada/code/shop", "/var/home/ada", "linux")).toBeUndefined();
        expect(folderRefusal("/srv/projects/shop", "/home/ada", "linux")).toBeUndefined();
        expect(folderRefusal("/Users/ada/Library-of-things", "/Users/ada", "darwin")).toBeUndefined();
        expect(folderRefusal(String.raw`D:\work\shop`, String.raw`C:\Users\ada`, "win32")).toBeUndefined();
    });
});
