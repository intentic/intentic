import type { Pairing } from "../config.js";
import { keyComment, labelValue, ownerLabel, syncEnvironmentFrom } from "../environment.js";
import { answeredGone, dockerStep, GONE_RECHECK_MS, GONE_RETIRE_MS, goneStep, keptHere, localVerdict, retiresAt, trashedSlugs } from "../gone.js";
import { comparableFolder, comparableOverlap, siblingClash, siblingClashSentence, siblingFoldersIn } from "../siblings.js";
import { tunnelTargets } from "../tunnel.js";

// (2026-10-05) A SANDBOX THAT NO LONGER EXISTS, as positive evidence says it, and what every rule built on that does. One
// PC held 13 pairings, 10 for sandboxes deleted elsewhere, each polled, logged and reported to forever.

const verdict = (status: number, said?: string): Response =>
    new Response("", { status, headers: said === undefined ? {} : { "x-intentic-edge": said } });

describe("answeredGone", () => {
    it("is the edge's final verdict and nothing else", () => {
        expect(answeredGone(verdict(502, "unknown-sandbox"))).toBe(true);
        // A sandbox that is restarting or not dialled in yet comes back by itself.
        expect(answeredGone(verdict(502, "no-tunnel"))).toBe(false);
        expect(answeredGone(verdict(502, "dropped"))).toBe(false);
        // A 502 from anything else on the path carries no verdict, and one of a word the edge never says is not one.
        expect(answeredGone(verdict(502))).toBe(false);
        expect(answeredGone(verdict(502, "gone-for-good"))).toBe(false);
        // An answer that is OK is never a verdict, whatever rides on it.
        expect(answeredGone(verdict(200, "unknown-sandbox"))).toBe(false);
    });
});

describe("goneStep", () => {
    const since = 1_000_000;

    it("has nothing to say of a sandbox nobody said is gone", () => {
        expect(goneStep({}, since)).toBeUndefined();
    });

    it("asks a gone sandbox again at most hourly", () => {
        expect(goneStep({ goneSince: since }, since + GONE_RECHECK_MS - 1)).toBe("wait");
        expect(goneStep({ goneSince: since }, since + GONE_RECHECK_MS)).toBe("recheck");
        expect(goneStep({ goneSince: since, goneCheckedAt: since + 5 * GONE_RECHECK_MS }, since + 5 * GONE_RECHECK_MS + 1)).toBe("wait");
    });

    it("retires it past the trash window, but only on a verdict asked within the hour", () => {
        const late = since + GONE_RETIRE_MS + 1;
        expect(goneStep({ goneSince: since, goneCheckedAt: late - 60_000 }, late)).toBe("retire");
        // An agent that was off for the week asks once before retiring anything.
        expect(goneStep({ goneSince: since, goneCheckedAt: since }, late)).toBe("recheck");
        expect(retiresAt(since)).toBe(since + GONE_RETIRE_MS);
    });
});

describe("localVerdict", () => {
    const slugs = ["sandbox-2e8d89d75865", "2e8d89d75865"];

    it("is here when ic lists it under any of its slugs", () => {
        expect(localVerdict(slugs, ["2e8d89d75865"], undefined)).toBe("here");
    });

    it("is trashed when ic's trash holds it, and gone only when ic answered both and neither holds it", () => {
        expect(localVerdict(slugs, [], ["sandbox-2e8d89d75865"])).toBe("trashed");
        expect(localVerdict(slugs, ["another"], ["another-too"])).toBe("gone");
    });

    // Docker Desktop not started yet answers no listing: never read as absence.
    it("knows nothing when either listing did not answer", () => {
        expect(localVerdict(slugs, undefined, [])).toBe("unknown");
        expect(localVerdict(slugs, [], undefined)).toBe("unknown");
    });
});

describe("keptHere", () => {
    it("is a sandbox reached through Docker, or one ic has listed here before, and nothing else", () => {
        expect(keptHere({ transport: "docker", container: "intentic-sandbox-x" })).toBe(true);
        expect(keptHere({ icSlug: "x" })).toBe(true);
        // A hosted sandbox, or one on another computer: absent from every listing here, which says nothing.
        expect(keptHere({})).toBe(false);
        expect(keptHere({ transport: "docker" })).toBe(false);
    });
});

describe("trashedSlugs", () => {
    it("reads ic's own trash lines, and nothing of the live listing above them", () => {
        const listing = [
            "running   sandbox-live",
            "stopped   sandbox-asleep",
            "",
            "removed, still recoverable ('ic sandbox restore <slug>'):",
            "removed   sandbox-8a8171848c91 (6 day(s) left)",
            "removed   my-blog (1 day(s) left)",
        ].join("\n");
        expect(trashedSlugs(listing)).toEqual(["sandbox-8a8171848c91", "my-blog"]);
        expect(trashedSlugs("running   sandbox-live\n")).toEqual([]);
    });
});

describe("dockerStep", () => {
    const missing = { container: "missing" as const, enrolled: true, answering: true };

    it("keeps a container that serves, one that is only stopped, and one the engine could not be asked about", () => {
        for (const container of ["serves", "stopped", "unknown"] as const) {
            expect(dockerStep({ container, local: "gone", enrolled: true, answering: false })).toBe("keep");
        }
    });

    it("follows ic once the container is gone from the engine", () => {
        // Listed: a swap is moving it under its name.
        expect(dockerStep({ ...missing, local: "here" })).toBe("keep");
        expect(dockerStep({ ...missing, local: "trashed" })).toBe("pause-trashed");
        expect(dockerStep({ ...missing, local: "gone", answering: false })).toBe("gone");
    });

    // (2026-10-06) ic here holding it nowhere while it answers at its address is a sandbox that moved, not one gone.
    it("reads ic's \"gone\" as a move while the sandbox still answers", () => {
        expect(dockerStep({ ...missing, local: "gone" })).toBe("ssh");
        expect(dockerStep({ ...missing, local: "gone", enrolled: false })).toBe("pause-missing");
    });

    it("moves onto ssh only for a sandbox that still answers at its address, with an enrollment to ride", () => {
        expect(dockerStep({ ...missing, local: "unknown" })).toBe("ssh");
        expect(dockerStep({ ...missing, local: "unknown", answering: false })).toBe("pause-missing");
        expect(dockerStep({ ...missing, local: "unknown", enrolled: false })).toBe("pause-missing");
    });
});

describe("tunnelTargets", () => {
    // A gone sandbox's listener would only answer ssh with a socket that fails.
    it("opens no transport for a sandbox said to be gone", () => {
        const pairing: Pairing = { sandboxUrl: "https://a.dev", sandboxId: "a", mode: "sync", syncToken: "tok" };
        expect(tunnelTargets([{ pairing, base: "https://a.dev" }])).toHaveLength(1);
        expect(tunnelTargets([{ pairing: { ...pairing, goneSince: 1 }, base: "https://a.dev" }])).toEqual([]);
    });
});

// WHICH ENVIRONMENT OF A PC this agent is, and the names derived from it.
describe("syncEnvironmentFrom", () => {
    it("names Windows, macOS, a plain Linux and a WSL distro", () => {
        expect(syncEnvironmentFrom("win32", undefined, undefined, undefined)).toEqual({ name: "windows", wsl: false });
        expect(syncEnvironmentFrom("darwin", undefined, undefined, undefined)).toEqual({ name: "macos", wsl: false });
        expect(syncEnvironmentFrom("linux", "Linux version 6.8.0-generic", undefined, undefined)).toEqual({ name: "linux", wsl: false });
        expect(syncEnvironmentFrom("linux", "Linux version 6.6.87.2-microsoft-standard-WSL2", "Ubuntu-24.04", undefined)).toEqual({
            name: "Ubuntu-24.04",
            wsl: true,
        });
        expect(syncEnvironmentFrom("linux", "microsoft-standard-WSL2", undefined, 'NAME="Arch Linux"\n', true)).toEqual({
            name: "Arch Linux",
            wsl: true,
        });
    });

    // Docker Desktop runs every Linux container on WSL's kernel: that alone is no distro.
    it("reads a container on Docker Desktop's kernel as plain Linux", () => {
        expect(
            syncEnvironmentFrom("linux", "Linux version 6.18.40.1-microsoft-standard-WSL2", undefined, 'NAME="Debian GNU/Linux"\n', false),
        ).toEqual({
            name: "linux",
            wsl: false,
        });
    });
});

describe("labels", () => {
    it("holds a value to Mutagen's rule: 63 characters at most, of letters, digits, '-', '_' and '.', ending on either side in a letter or digit", () => {
        expect(labelValue("m-0123-windows")).toBe("m-0123-windows");
        expect(labelValue("--Arch Linux!!")).toBe("Arch-Linux");
        const long = labelValue(`m-${"a".repeat(80)}-Ubuntu`);
        expect(long.length).toBeLessThanOrEqual(63);
        expect(long).toMatch(/^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/);
        // Two long values with one head stay apart.
        expect(labelValue(`m-${"a".repeat(80)}-Debian`)).not.toBe(long);
    });

    it("names the owner as this computer and this environment of it", () => {
        expect(ownerLabel("m-6b0e0b9c-6f8f-4ad5-9f10-0f1e2d3c4b5a", "windows")).toBe("m-6b0e0b9c-6f8f-4ad5-9f10-0f1e2d3c4b5a-windows");
        expect(ownerLabel("m-6b0e0b9c-6f8f-4ad5-9f10-0f1e2d3c4b5a", "windows")).not.toBe(
            ownerLabel("m-6b0e0b9c-6f8f-4ad5-9f10-0f1e2d3c4b5a", "Ubuntu"),
        );
    });

    it("comments a new key with the hostname and the environment, one authorized_keys token", () => {
        expect(keyComment("ROG", "windows")).toBe("ROG-windows");
        expect(keyComment("ROG", "Ubuntu")).toBe("ROG-Ubuntu");
        expect(keyComment("My PC", "Arch Linux")).toBe("My-PC-Arch-Linux");
    });
});

// ONE FOLDER, ONE SYNC, across the two sides of a PC.
describe("comparableFolder", () => {
    it("spells a drive folder the same from Windows and from a distro, case folded as NTFS folds it", () => {
        expect(comparableFolder("C:\\Users\\dev\\Code\\App", "windows")).toBe("drive:c/users/dev/code/app");
        expect(comparableFolder("/mnt/c/Users/dev/code/app", "wsl", "Ubuntu")).toBe("drive:c/users/dev/code/app");
    });

    it("spells a folder in a distro's own filesystem the same from both sides, its case kept", () => {
        expect(comparableFolder("\\\\wsl.localhost\\Ubuntu\\home\\ada\\App", "windows")).toBe("wsl:ubuntu/home/ada/App");
        expect(comparableFolder("\\\\wsl$\\Ubuntu\\home\\ada\\App", "windows")).toBe("wsl:ubuntu/home/ada/App");
        expect(comparableFolder("/home/ada/App", "wsl", "Ubuntu")).toBe("wsl:ubuntu/home/ada/App");
    });

    it("has no spelling for a share neither side can name", () => {
        expect(comparableFolder("\\\\fileserver\\team\\app", "windows")).toBeUndefined();
    });

    it("overlaps the same folder and one inside the other, and nothing else", () => {
        expect(comparableOverlap("drive:c/code/app", "drive:c/code/app")).toBe(true);
        expect(comparableOverlap("drive:c/code", "drive:c/code/app")).toBe(true);
        expect(comparableOverlap("drive:c/code/app", "drive:c/code/app2")).toBe(false);
        expect(comparableOverlap("wsl:ubuntu/home/ada/App", "wsl:ubuntu/home/ada/app")).toBe(false);
    });
});

describe("siblingClash", () => {
    const fromDistro = [{ environment: "wsl:Ubuntu", localDir: "/mnt/c/Code/app", sandboxId: "sandbox-a" }];
    const fromWindows = [{ environment: "windows", localDir: "C:\\Code\\app", sandboxId: "sandbox-b" }];

    it("finds a distro's folder from the Windows side, and the Windows side's from a distro", () => {
        expect(siblingClash("C:\\code\\APP\\src", { side: "windows" }, fromDistro)).toEqual(fromDistro[0]);
        expect(siblingClash("/mnt/c/code", { side: "wsl", distro: "Ubuntu" }, fromWindows)).toEqual(fromWindows[0]);
        expect(siblingClash("D:\\code\\app", { side: "windows" }, fromDistro)).toBeUndefined();
    });

    it("says which side holds the folder, in words", () => {
        const clash = fromDistro[0];
        expect(clash === undefined ? "" : siblingClashSentence("C:\\code\\app", clash)).toContain("WSL distro Ubuntu already syncs with sandbox-a");
    });

    it("reads another side's sync.json for its folders only, and an unreadable one as unread", () => {
        expect(
            siblingFoldersIn(
                JSON.stringify({
                    pairings: [
                        { sandboxId: "a", localDir: "/x" },
                        { sandboxId: "b", projectsHost: true },
                    ],
                }),
                "wsl:Ubuntu",
            ),
        ).toEqual([{ environment: "wsl:Ubuntu", localDir: "/x", sandboxId: "a" }]);
        expect(siblingFoldersIn("{ torn", "wsl:Ubuntu")).toBeUndefined();
        expect(siblingFoldersIn("{}", "wsl:Ubuntu")).toBeUndefined();
    });
});
