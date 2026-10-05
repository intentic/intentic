import type { DevicePairing } from "@intentic/sandbox-contract";
import { ownNames, pairingIsOurs, writablePath } from "./project-delivery.js";

// Which of a machine's pairings are this sandbox's, and which paths a machine's merge may write into the sandbox's copy.
// A machine reports every sandbox it pairs, so delivery reads the right folder only when these hold; the integration
// suite (tests/project-delivery.integration.test.ts) drives the whole delivery over a real repository.

const URL = "https://sandbox-abc123def456.intentic.dev";
const OURS = "sandbox-abc123def456-intentic-dev";

const pairing = (overrides: Partial<DevicePairing> = {}): DevicePairing => ({
    sandboxId: OURS,
    mode: "sync",
    localDir: "/home/ada/my-app",
    remoteDir: "/work/my-app",
    deliver: "auto",
    ...overrides,
});

describe("ownNames", () => {
    it("names this sandbox as a machine pairs it: its sanitized host, and its short ids", () => {
        expect(ownNames(URL, "f00dfeed0001", [])).toEqual(expect.arrayContaining([OURS, "abc123def456", "f00dfeed0001"]));
    });

    it("takes the ids a volunteered report already filed under this sandbox", () => {
        expect(ownNames("", undefined, ["laptop-box"])).toEqual(["laptop-box"]);
    });

    it("knows no name at all without an address, an id or a report", () => {
        expect(ownNames("", undefined, [])).toEqual([]);
    });
});

describe("pairingIsOurs", () => {
    const names = ownNames(URL, undefined, []);

    it("is ours by its sandbox id, which every folder attached to this sandbox reports", () => {
        expect(pairingIsOurs(pairing(), [pairing()], names)).toBe(true);
    });

    it("is another sandbox's when its id names that one, even for a folder of the same name", () => {
        const theirs = pairing({ sandboxId: "sandbox-999999999999-intentic-dev" });
        expect(pairingIsOurs(theirs, [theirs], names)).toBe(false);
        // Nor does a name that merely begins with ours make it ours.
        const longer = pairing({ sandboxId: `${OURS}-2` });
        expect(pairingIsOurs(longer, [longer], names)).toBe(false);
    });

    it("is ours when it delivers by itself and the machine's projects host beside it is ours", () => {
        const attached = pairing({ sandboxId: "my-app-folder" });
        const host = pairing({ sandboxId: OURS, projectsHost: true, localDir: undefined, remoteDir: undefined, deliver: undefined });
        expect(pairingIsOurs(attached, [host, attached], names)).toBe(true);
        expect(pairingIsOurs({ ...attached, deliver: "off" }, [host, attached], names)).toBe(false);
    });

    it("takes the machine's word when this sandbox knows no name of its own", () => {
        const any = pairing({ sandboxId: "whatever" });
        expect(pairingIsOurs(any, [any], ownNames("", undefined, []))).toBe(true);
    });
});

describe("writablePath", () => {
    it("writes a plain relative path inside the folder", () => {
        expect(writablePath("src/app.ts")).toBe(true);
        expect(writablePath("README.md")).toBe(true);
    });

    it.each(["", "/etc/passwd", "../outside", "src/../../outside", "a//b", "./a", "C:/x", "a\\b", ".git/config", "lib/.git/HEAD", "a\0b"])(
        "refuses %j",
        (path) => {
            expect(writablePath(path)).toBe(false);
        },
    );
});
