import type { SmbNetdiskConfig } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { explainMountFailure, smbCredentialsFile, smbMountOptions, smbTarget } from "./smb.js";

// The mount line is the whole access decision: what mount.cifs is told decides what the kernel enforces.

const disk = (over: Partial<SmbNetdiskConfig> = {}): SmbNetdiskConfig => ({
    provider: "smb",
    server: "nas.local",
    share: "projects",
    username: "agent",
    password: "s3cret",
    access: "read",
    version: "auto",
    autoMount: "on",
    ...over,
});

test("a read-only disk is mounted ro, a read-write one rw, and nothing else about the line changes", () => {
    const ro = smbMountOptions(disk(), "/root/.intentic-netdisk/x.cred").split(",");
    const rw = smbMountOptions(disk({ access: "readwrite" }), "/root/.intentic-netdisk/x.cred").split(",");
    expect(ro).toContain("ro");
    expect(ro).not.toContain("rw");
    expect(rw).toContain("rw");
    expect(rw).not.toContain("ro");
    expect(ro.filter((option) => option !== "ro")).toEqual(rw.filter((option) => option !== "rw"));
});

test("the password rides the credentials file, never the mount line; a guest share gets guest instead", () => {
    const options = smbMountOptions(disk({ domain: "CORP" }), "/root/.intentic-netdisk/x.cred");
    expect(options).toContain("credentials=/root/.intentic-netdisk/x.cred");
    expect(options).not.toContain("s3cret");
    expect(options).not.toContain("username=");
    expect(smbCredentialsFile(disk({ domain: "CORP" }))).toBe("username=agent\npassword=s3cret\ndomain=CORP\n");

    const guest = smbMountOptions(disk({ password: undefined }), "/root/.intentic-netdisk/x.cred").split(",");
    expect(guest).toContain("guest");
    expect(guest).toContain("username=agent");
    expect(guest.some((option) => option.startsWith("credentials="))).toBe(false);
    expect(smbCredentialsFile(disk({ password: undefined }))).toBe("username=agent\n");
});

test("soft, root ownership and utf8 always ride; the version only when pinned", () => {
    const auto = smbMountOptions(disk(), "/c").split(",");
    expect(auto).toEqual(expect.arrayContaining(["soft", "uid=0", "gid=0", "iocharset=utf8"]));
    expect(auto.some((option) => option.startsWith("vers="))).toBe(false);
    expect(smbMountOptions(disk({ version: "1.0" }), "/c").split(",")).toContain("vers=1.0");
});

test("the target is //server/share, with the folder inside appended only when given", () => {
    expect(smbTarget(disk())).toBe("//nas.local/projects");
    expect(smbTarget(disk({ path: "2026/q3" }))).toBe("//nas.local/projects/2026/q3");
    expect(smbTarget(disk({ path: "" }))).toBe("//nas.local/projects");
});

test("a mount.cifs failure is explained by its errno, and an unknown one is passed through verbatim", () => {
    expect(explainMountFailure("mount error(13): Permission denied\nRefer to the mount.cifs(8) manual page")).toMatch(/refused the credentials/);
    expect(explainMountFailure("mount error(113): No route to host")).toMatch(/vpn list/);
    expect(explainMountFailure("mount error(1): Operation not permitted")).toMatch(/AppArmor/);
    expect(explainMountFailure("something else entirely")).toBe("something else entirely");
    expect(explainMountFailure("")).toBe("mount.cifs failed without a message");
});
