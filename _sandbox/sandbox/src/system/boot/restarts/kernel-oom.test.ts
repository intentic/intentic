import { kernelLinesOf, oomKillsOf } from "../../resources/kernel-oom-lines.js";
import { VERIFIED_CONTAINER_ID, verifiedDmesg } from "../../resources/kernel-oom-lines.testing.js";
import { containerIdOf, epochOfKernel, kernelZeroEpochMs, memcgIsDaemonLeaf, memcgIsOurs } from "./kernel-oom.js";

/* Which sandbox a kernel OOM kill hit, and when: the 2026-11-05 kill's cgroup, and the stamp it was printed with. The
   lines themselves are read by kernel-oom-lines.ts, tested beside it. */

const ID = "a8c75cbac8dc3f2e1a7b5c9d0e4f6a8b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f";
const MEMCG = `/wsl-user/distro-4261/docker/${ID}/workload`;

const MOUNTINFO = [
    "2625 2612 0:97 / / rw,relatime - overlay overlay rw,lowerdir=32110/fs",
    "2635 2625 8:64 /var/lib/docker/volumes/intentic-history/_data /history rw,relatime - ext4 /dev/sde rw",
    `2637 2625 8:64 /var/lib/docker/containers/${ID}/hostname /etc/hostname rw,relatime - ext4 /dev/sde rw`,
    `2638 2625 8:64 /var/lib/docker/containers/${ID}/hosts /etc/hosts rw,relatime - ext4 /dev/sde rw`,
].join("\n");

test("the container finds its own id in where its /etc/hostname is mounted from, else its cgroup path, else its hostname", () => {
    expect(containerIdOf({ mountinfo: MOUNTINFO, procSelfCgroup: "0::/workload\n", hostname: "a8c75cbac8dc\n" })).toBe(ID);
    const podman = `33 1 0:5 /var/lib/containers/storage/overlay-containers/${ID}/userdata/hostname /etc/hostname rw - ext4 /dev/sda rw`;
    expect(containerIdOf({ mountinfo: podman })).toBe(ID);
    // No cgroup namespace: the machine's path shows, in a systemd scope or bare.
    expect(containerIdOf({ procSelfCgroup: `0::/system.slice/docker-${ID}.scope/workload\n` })).toBe(ID);
    expect(containerIdOf({ procSelfCgroup: `0::/docker/${ID}\n` })).toBe(ID);
    expect(containerIdOf({ procSelfCgroup: "0::/workload\n", hostname: "a8c75cbac8dc\n" })).toBe("a8c75cbac8dc");
    expect(containerIdOf({ procSelfCgroup: "0::/workload\n", hostname: "my-sandbox\n" })).toBeUndefined();
});

test("the night's kill was in this container by its id, full or short; another container's is not ours", () => {
    expect(memcgIsOurs(MEMCG, ID)).toBe(true);
    expect(memcgIsOurs(MEMCG, "a8c75cbac8dc")).toBe(true);
    expect(memcgIsOurs(`/system.slice/docker-${ID}.scope/daemon`, ID)).toBe(true);
    expect(memcgIsOurs(`/wsl-user/distro-4261/docker/${"b".repeat(64)}/workload`, ID)).toBe(false);
    expect(memcgIsOurs("/workload", ID)).toBe(false);
    expect(memcgIsOurs(undefined, ID)).toBe(false);
    // A sandbox that is its own machine (no container around it): its own leaves at the root are its.
    expect(memcgIsOurs("/workload", undefined)).toBe(true);
    expect(memcgIsOurs("/workload/build", undefined)).toBe(true);
    expect(memcgIsOurs("/user.slice/user-1000.slice", undefined)).toBe(false);
    expect(memcgIsDaemonLeaf(`/docker/${ID}/daemon`)).toBe(true);
    expect(memcgIsDaemonLeaf(MEMCG)).toBe(false);
});

test("the verification's kill on a real kernel was in the container it ran in, by the cgroup the kernel printed", () => {
    const [kill] = oomKillsOf(kernelLinesOf(verifiedDmesg()));
    expect(memcgIsOurs(kill?.taskMemcg, VERIFIED_CONTAINER_ID)).toBe(true);
    expect(memcgIsOurs(kill?.taskMemcg, VERIFIED_CONTAINER_ID.slice(0, 12))).toBe(true);
    expect(memcgIsOurs(kill?.taskMemcg, ID)).toBe(false);
    expect(memcgIsDaemonLeaf(kill?.taskMemcg)).toBe(false);
});

test("a kernel stamp is dated from the monotonic clock's zero", () => {
    const zero = kernelZeroEpochMs(1_793_852_538_000, 236_326_000);
    expect(zero).toBe(1_793_852_538_000 - 236_326_000);
    expect(new Date(epochOfKernel(236_305_229_131, Date.parse("2026-11-05T04:21:57.000Z") - 236_305_229.131)).toISOString()).toBe("2026-11-05T04:21:57.000Z");
});
