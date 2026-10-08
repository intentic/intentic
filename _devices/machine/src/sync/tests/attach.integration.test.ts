import { mkdtempSync } from "node:fs";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKSPACE_ROOT } from "@intentic/constants";
import { buildApplication, buildRouteMap, run } from "@stricli/core";

// `sync attach` and `sync detach` on a throwaway home: config.ts fixes its paths at import time, so HOME points at a
// temp dir before the imports below. Docker and the resident agent are the seams' (attach-commands.ts), so nothing here
// starts an agent or asks an engine.
process.env["HOME"] = mkdtempSync(join(tmpdir(), "attach-"));
process.env["USERPROFILE"] = process.env["HOME"];
const home = process.env["HOME"];
const { agentHome } = await import("@intentic/local-agent");
const { readState, upsertPairing } = await import("../config.js");
const { attachCommands, attachFolder, detachFolder, planAttach } = await import("../attach-commands.js");
const { listingRecordPath } = await import("../project/project-local.js");
const { restoreDir } = await import("../restore-points.js");
const { sessionName } = await import("../mutagen.js");

const machineDir = agentHome("machine").dir;
const syncStatePath = join(machineDir, "sync.json");
const SANDBOX = "sandbox-5a1b2c3d4e5f-intentic-dev";
const URL_OF = "https://sandbox-5a1b2c3d4e5f.intentic.dev";
const CONTAINER = "intentic-sandbox-sandbox-5a1b2c3d4e5f";
const shop = join(home, "code", "shop");
const blog = join(home, "code", "blog");

const host = { sandboxUrl: URL_OF, sandboxId: SANDBOX, mode: "sync" as const, syncToken: "ist_one", projectsHost: true as const };
const quiet = (): void => undefined;
const here = { locate: async () => CONTAINER, home, ensureAgent: async () => undefined };

beforeAll(async () => {
    await mkdir(join(shop, "src"), { recursive: true });
    await mkdir(blog, { recursive: true });
    await symlink(shop, join(home, "shop-link"));
});

beforeEach(async () => {
    await mkdir(machineDir, { recursive: true });
    await writeFile(syncStatePath, JSON.stringify({ pairings: [host] }));
});

afterEach(() => {
    process.exitCode = 0;
});

describe("sync attach", () => {
    it("records the folder as a copy-first project of this computer's sandbox, delivering by itself, through Docker", async () => {
        expect(await attachFolder({ sandboxUrl: `${URL_OF}/`, dir: shop, name: "shop" }, quiet, here)).toEqual({
            ok: true,
            pairing: `${SANDBOX}~shop`,
            remoteDir: `${WORKSPACE_ROOT}/shop`,
            folder: shop,
        });
        expect((await readState()).pairings).toEqual([
            host,
            {
                sandboxUrl: URL_OF,
                sandboxId: SANDBOX,
                key: `${SANDBOX}~shop`,
                mode: "sync",
                syncToken: "ist_one",
                localDir: shop,
                remoteDir: `${WORKSPACE_ROOT}/shop`,
                project: true,
                direction: "to-sandbox",
                deliver: "auto",
                transport: "docker",
                container: CONTAINER,
            },
        ]);
    });

    // The desktop app finds its folder in `status --json` by the path it passed, so that is the path recorded; links are
    // resolved only to tell whether two spellings are one folder.
    it("records the folder as it was given, and knows it again by any spelling", async () => {
        const viaLink = join(home, "shop-link");
        expect((await attachFolder({ sandboxUrl: URL_OF, dir: viaLink, name: "shop" }, quiet, here)).folder).toBe(viaLink);
        expect((await readState()).pairings.find((pairing) => pairing.key !== undefined)?.localDir).toBe(viaLink);
        expect((await attachFolder({ sandboxUrl: URL_OF, dir: shop, name: "shop" }, quiet, here)).folder).toBe(shop);
        await expect(planAttach((await readState()).pairings, { sandboxUrl: URL_OF, dir: viaLink, name: "other" }, here)).rejects.toThrow("is already attached as");
    });

    it("attaches several folders to the one sandbox, and the same folder again as a no-op", async () => {
        await attachFolder({ sandboxUrl: URL_OF, dir: shop, name: "shop" }, quiet, here);
        await attachFolder({ sandboxUrl: URL_OF, dir: blog, name: "blog" }, quiet, here);
        await attachFolder({ sandboxUrl: URL_OF, dir: shop, name: "shop" }, quiet, here);
        expect((await readState()).pairings.map((pairing) => pairing.key ?? pairing.sandboxId)).toEqual([SANDBOX, `${SANDBOX}~blog`, `${SANDBOX}~shop`]);
    });

    it("keeps a folder's own choice of direction when it is attached again", async () => {
        await attachFolder({ sandboxUrl: URL_OF, dir: shop, name: "shop" }, quiet, here);
        const { pairings } = await readState();
        await writeFile(syncStatePath, JSON.stringify({ pairings: pairings.map((pairing) => (pairing.key === undefined ? pairing : { ...pairing, direction: "both" })) }));
        await attachFolder({ sandboxUrl: URL_OF, dir: shop, name: "shop" }, quiet, here);
        expect((await readState()).pairings.find((pairing) => pairing.key !== undefined)?.direction).toBe("both");
    });

    it("rides ssh where the sandbox's container is not on this machine's engine", async () => {
        const pairing = await planAttach([host], { sandboxUrl: URL_OF, dir: shop, name: "shop" }, { ...here, locate: async () => undefined });
        expect(pairing.transport).toBeUndefined();
        expect(pairing.container).toBeUndefined();
    });

    it("says so when this computer's sandbox is not set up for folders", async () => {
        await expect(planAttach([], { sandboxUrl: URL_OF, dir: shop, name: "shop" }, here)).rejects.toThrow("this computer's sandbox is not set up for folders yet");
        const workspace = { ...host, projectsHost: undefined, localDir: join(home, "intentic", "w") };
        await expect(planAttach([workspace], { sandboxUrl: URL_OF, dir: shop, name: "shop" }, here)).rejects.toThrow("not set up for folders yet");
    });

    it("refuses a name the sandbox keeps for itself, or one that is not a folder name", async () => {
        await expect(planAttach([host], { sandboxUrl: URL_OF, dir: shop, name: "public" }, here)).rejects.toThrow(`"public" cannot name a folder in the sandbox`);
        await expect(planAttach([host], { sandboxUrl: URL_OF, dir: shop, name: "../etc" }, here)).rejects.toThrow("cannot name a folder in the sandbox");
        await expect(planAttach([host], { sandboxUrl: URL_OF, dir: shop, name: ".hidden" }, here)).rejects.toThrow("cannot name a folder in the sandbox");
    });

    it("refuses the home folder, a folder that is not there, and one that is a file", async () => {
        await expect(planAttach([host], { sandboxUrl: URL_OF, dir: home, name: "home" }, here)).rejects.toThrow("is your whole home folder");
        await expect(planAttach([host], { sandboxUrl: URL_OF, dir: join(home, "nowhere"), name: "x" }, here)).rejects.toThrow("is not there");
        await writeFile(join(home, "a-file"), "x");
        await expect(planAttach([host], { sandboxUrl: URL_OF, dir: join(home, "a-file"), name: "x" }, here)).rejects.toThrow("is not there");
    });

    it("refuses a name already attached for another folder, and a folder already attached or inside one", async () => {
        await attachFolder({ sandboxUrl: URL_OF, dir: shop, name: "shop" }, quiet, here);
        const { pairings } = await readState();
        await expect(planAttach(pairings, { sandboxUrl: URL_OF, dir: blog, name: "shop" }, here)).rejects.toThrow(`${shop} is already attached as ${WORKSPACE_ROOT}/shop`);
        await expect(planAttach(pairings, { sandboxUrl: URL_OF, dir: shop, name: "shop2" }, here)).rejects.toThrow(`which is already attached as ${WORKSPACE_ROOT}/shop`);
        await expect(planAttach(pairings, { sandboxUrl: URL_OF, dir: join(shop, "src"), name: "src" }, here)).rejects.toThrow("overlaps");
    });

    it("refuses a folder another sandbox's pairing syncs", async () => {
        const other = { sandboxUrl: "https://sandbox-0738cd6b5027.intentic.dev", sandboxId: "sandbox-0738cd6b5027-intentic-dev", mode: "sync" as const, localDir: blog };
        await expect(planAttach([host, other], { sandboxUrl: URL_OF, dir: blog, name: "blog" }, here)).rejects.toThrow(`which already syncs with ${other.sandboxId}`);
    });

    it("answers in one JSON object, a refusal as `ok: false` with exit code 1", async () => {
        const out: string[] = [];
        const app = buildApplication(buildRouteMap({ routes: attachCommands, docs: { brief: "attach" } }), {
            name: "intentic-machine",
            scanner: { caseStyle: "allow-kebab-for-camel" },
        });
        await run(app, ["attach", "--sandbox-url", "https://nowhere.example.dev", "--dir", shop, "--name", "shop", "--json"], {
            process: { stdout: { write: (text: string) => void out.push(text) }, stderr: { write: () => undefined } },
        });
        expect(out.map((line) => JSON.parse(line) as unknown)).toEqual([
            {
                ok: false,
                error: "This computer's sandbox is not set up for folders yet: no sandbox at https://nowhere.example.dev was enrolled here with `intentic-machine sync setup --projects-host`.",
            },
        ]);
        expect(process.exitCode).toBe(1);
    });
});

describe("sync detach", () => {
    it("removes the folder's pairing, ends its session and drops its listing record, keeping its restore points", async () => {
        await attachFolder({ sandboxUrl: URL_OF, dir: shop, name: "shop" }, quiet, here);
        await attachFolder({ sandboxUrl: URL_OF, dir: blog, name: "blog" }, quiet, here);
        const key = `${SANDBOX}~shop`;
        await mkdir(join(restoreDir(machineDir, key), "20261005T120000.000Z"), { recursive: true });
        await mkdir(join(machineDir, "hashes"), { recursive: true });
        await writeFile(listingRecordPath(machineDir, key), "{}");
        const ended: string[] = [];

        expect(await detachFolder(join(home, "shop-link"), machineDir, { terminate: async (names) => void ended.push(...names) })).toEqual({ ok: true, pairing: key, folder: shop });
        expect((await readState()).pairings.map((pairing) => pairing.key ?? pairing.sandboxId)).toEqual([SANDBOX, `${SANDBOX}~blog`]);
        expect(ended).toEqual([sessionName(key)]);
        await expect(readFile(listingRecordPath(machineDir, key), "utf8")).rejects.toThrow();
        expect(await readFile(syncStatePath, "utf8")).not.toContain(shop);
        await expect(mkdir(join(restoreDir(machineDir, key), "20261005T120000.000Z"))).rejects.toThrow("EEXIST");
    });

    it("refuses a folder with a sandbox of its own, and one nothing syncs", async () => {
        const own = { sandboxUrl: "https://sandbox-0738cd6b5027.intentic.dev", sandboxId: "sandbox-0738cd6b5027-intentic-dev", mode: "sync" as const, localDir: blog, remoteDir: `${WORKSPACE_ROOT}/blog`, project: true as const };
        await upsertPairing(own);
        await expect(detachFolder(blog, machineDir, { terminate: async () => undefined })).rejects.toThrow("has a sandbox of its own");
        await expect(detachFolder(shop, machineDir, { terminate: async () => undefined })).rejects.toThrow(`no project on this machine syncs ${shop}`);
    });
});
