import { expect, test } from "vitest";
import { isReadOnly, mountAt, parseMountinfo } from "./mountinfo.js";

// Real mountinfo lines, not an assumed shape: the overlay root a container boots on, a cifs mount each way, and a
// mount point with a space in it (escaped as \040 by the kernel).
const TABLE = `2857 2844 0:140 / / rw,relatime - overlay overlay rw,lowerdir=48143/fs:48138/fs,upperdir=/x/fs,workdir=/x/work
2858 2857 0:155 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw
3001 2857 0:210 / /mnt/netdisk/archive ro,relatime - cifs //nas.local/archive ro,vers=3.1.1,cache=strict,username=agent,uid=0,noforceuid,gid=0,noforcegid,addr=192.168.1.20,file_mode=0644,dir_mode=0755,soft,nounix,serverino,mapposix,rsize=4194304,wsize=4194304,bsize=1048576,echo_interval=60,actimeo=1,closetimeo=1
3002 2857 0:211 / /mnt/netdisk/scratch rw,relatime - cifs //nas.local/scratch rw,vers=3.1.1,cache=strict,username=agent,uid=0,gid=0,soft
3003 2857 0:212 / /mnt/netdisk/with\\040space rw,relatime shared:5 - cifs //nas.local/spaced rw,vers=3.0
`;

test("parses mount point, fs type, source and both option layers off a real table", () => {
    const entries = parseMountinfo(TABLE);
    expect(entries.map((entry) => entry.mountPoint)).toEqual(["/", "/proc", "/mnt/netdisk/archive", "/mnt/netdisk/scratch", "/mnt/netdisk/with space"]);
    const archive = mountAt(entries, "/mnt/netdisk/archive");
    expect(archive?.fsType).toBe("cifs");
    expect(archive?.source).toBe("//nas.local/archive");
    expect(archive?.mountOptions).toEqual(["ro", "relatime"]);
    expect(archive?.superOptions).toContain("vers=3.1.1");
    // An optional field (shared:5) between the options and the separator must not shift the fs type.
    expect(mountAt(entries, "/mnt/netdisk/with space")?.fsType).toBe("cifs");
});

test("read-only is true when either the mount or the superblock says ro", () => {
    const entries = parseMountinfo(TABLE);
    expect(isReadOnly(mountAt(entries, "/mnt/netdisk/archive")!)).toBe(true);
    expect(isReadOnly(mountAt(entries, "/mnt/netdisk/scratch")!)).toBe(false);
    // A bind remount flips only the per-mount flag; a `remount,ro` flips only the superblock's. Both must count.
    expect(isReadOnly({ mountPoint: "/x", fsType: "cifs", source: "//a/b", mountOptions: ["rw"], superOptions: ["ro"] })).toBe(true);
    expect(isReadOnly({ mountPoint: "/x", fsType: "cifs", source: "//a/b", mountOptions: ["ro"], superOptions: ["rw"] })).toBe(true);
});

test("the last mount at a point wins, and garbage lines are dropped rather than fatal", () => {
    const stacked = `${TABLE}3004 2857 0:213 / /mnt/netdisk/archive rw,relatime - cifs //other/archive rw\nnot a mountinfo line\n\n`;
    const entries = parseMountinfo(stacked);
    expect(mountAt(entries, "/mnt/netdisk/archive")?.source).toBe("//other/archive");
    expect(mountAt(entries, "/mnt/netdisk/missing")).toBeUndefined();
    expect(parseMountinfo("")).toEqual([]);
});
