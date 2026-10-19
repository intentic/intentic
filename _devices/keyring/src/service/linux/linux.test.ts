import { linuxServicePaths, POLKIT_ACTION, SERVICE_USER } from "./paths-linux.js";
import { pkcheckArgs, polkitAnswerOf, startTimeOf, uidOf } from "./polkit-linux.js";
import { doorAclArgs, othersInstalledLinux, passwdEntry, policyText, unitText } from "./unit-linux.js";

/* The Linux service's pure parts: where it keeps things, the unit and polkit action install writes, the ACLs that open
   the door to one uid, and how pkcheck is asked and read. systemd, polkit and setfacl themselves are not run here. */

describe("the Linux service's places", () => {
    test("are fixed, outside the user's home, and named by uid", () => {
        const paths = linuxServicePaths("1000");
        expect(paths.exe).toBe("/usr/lib/intentic-keyring/intentic-keyring");
        expect(paths.vaultDir).toBe("/var/lib/intentic-keyring/1000");
        expect(paths.socket).toBe("/run/intentic-keyring/1000/door.sock");
        expect(paths.marker).toBe("/var/lib/intentic-keyring/1000.installed");
        expect(paths.unitName).toBe("intentic-keyring@1000.service");
        expect(paths.policyFile).toBe("/usr/share/polkit-1/actions/dev.intentic.keyring.policy");
    });

    test("refuse anything that is not a uid", () => {
        expect(() => linuxServicePaths("../etc")).toThrow();
        expect(() => linuxServicePaths("")).toThrow();
    });
});

describe("the unit and the polkit action", () => {
    test("run one instance per user as the service's own user, in folders systemd makes 0700", () => {
        const unit = unitText(linuxServicePaths("1000"));
        expect(unit).toContain(`User=${SERVICE_USER}`);
        expect(unit).toContain("ExecStart=/usr/lib/intentic-keyring/intentic-keyring service run --user %i");
        expect(unit).toContain("StateDirectory=intentic-keyring/%i");
        expect(unit).toContain("StateDirectoryMode=0700");
        expect(unit).toContain("RuntimeDirectory=intentic-keyring/%i");
        expect(unit).toContain("ProtectHome=yes");
    });

    test("ask the person's own password every time, and let only the service's user ask about another's process", () => {
        const policy = policyText();
        expect(policy).toContain(`<action id="${POLKIT_ACTION}">`);
        expect(policy).toContain("<allow_active>auth_self</allow_active>");
        expect(policy).not.toContain("auth_self_keep");
        expect(policy).toContain(`<annotate key="org.freedesktop.policykit.owner">unix-user:${SERVICE_USER}</annotate>`);
    });
});

test("the door opens to the one uid: its folder entered, its socket written, its token read", () => {
    expect(doorAclArgs(linuxServicePaths("1000"))).toEqual([
        ["-m", "u:1000:--x", "/run/intentic-keyring/1000"],
        ["-m", "u:1000:rw-", "/run/intentic-keyring/1000/door.sock"],
        ["-m", "u:1000:r--", "/run/intentic-keyring/1000/door.json"],
    ]);
});

test("a passwd line gives the home and primary group, and a broken one nothing", () => {
    expect(passwdEntry("ada:x:1000:1000:Ada,,,:/home/ada:/bin/bash\n")).toEqual({ uid: 1000, gid: 1000, home: "/home/ada" });
    expect(passwdEntry("ada:x:1000")).toBeUndefined();
});

test("the shared parts stay while another user's marker is left", () => {
    expect(othersInstalledLinux(["1000", "1000.installed"], "1000")).toBe(false);
    expect(othersInstalledLinux(["1000.installed", "1001.installed"], "1000")).toBe(true);
});

describe("asking polkit", () => {
    test("names the helper's process without a race, and says what is asked", () => {
        const args = pkcheckArgs({ pid: 42, start: "123456", uid: "1000" }, { title: "Release GITHUB_TOKEN?", message: "intentic-dev asks.\nIt goes there." });
        expect(args).toContain("42,123456,1000");
        expect(args).toContain("--allow-user-interaction");
        expect(args.slice(-2)).toEqual(["message", "intentic-dev asks. It goes there."]);
    });

    test("reads pkcheck's exits: 0 yes, 1 and 3 no, anything else cannot ask", () => {
        expect(polkitAnswerOf(0, false)).toBe("yes");
        expect(polkitAnswerOf(1, false)).toBe("no");
        expect(polkitAnswerOf(3, false)).toBe("no");
        expect(polkitAnswerOf(2, false)).toBe("cannot-ask");
        expect(polkitAnswerOf(127, false)).toBe("cannot-ask");
        expect(polkitAnswerOf(null, true)).toBe("cannot-ask");
    });

    test("reads a process's start time past a name with spaces and parentheses, and its real uid", () => {
        const stat = "4242 (my (odd) prog) S 1 4242 4242 0 -1 4194560 100 0 0 0 1 2 0 0 20 0 1 0 98765 1000 200";
        expect(startTimeOf(stat)).toBe("98765");
        expect(uidOf("Name:\tbash\nUid:\t1000\t1000\t1000\t1000\nGid:\t1000\n")).toBe("1000");
    });
});
