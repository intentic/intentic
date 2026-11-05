/* A KILL AT THE WORKLOAD LEAF'S OWN BOUND, AS A REAL KERNEL PRINTED IT (2026-11-05). From the day's verification: a
   throwaway Alpine container on a Docker Desktop host, its own swap unbounded, the workload bounds applied, and
   `stress-ng` asking 4 GiB past a 4 GiB cap. The cgroup OOM inside /workload killed it; these are the kernel's two lines
   as dmesg printed them, word for word. The pid is the VM's. */

export const VERIFIED_CONTAINER_ID = "784aaf3e3df142e610e409bfe00f46a36e80e73c6149aeb69034f010b7e7083e";
export const VERIFIED_WORKLOAD_MEMCG = `/wsl-user/distro-9486/docker/${VERIFIED_CONTAINER_ID}/workload`;
export const VERIFIED_KILL_PID = 3622;

const OOM_KILL_LINE = `[1561485.718547] oom-kill:constraint=CONSTRAINT_MEMCG,nodemask=(null),cpuset=${VERIFIED_CONTAINER_ID},mems_allowed=0,oom_memcg=${VERIFIED_WORKLOAD_MEMCG},task_memcg=${VERIFIED_WORKLOAD_MEMCG},task=stress-ng-vm,pid=3622,uid=0`;
const KILLED_LINE =
    "[1561485.721680] Memory cgroup out of memory: Killed process 3622 (stress-ng-vm) total-vm:8426700kB, anon-rss:3112052kB, file-rss:544kB, shmem-rss:0kB, UID:0 pgtables:8204kB oom_score_adj:1000";

/** The two lines as dmesg printed them, one after the other. */
export const verifiedDmesg = (): string => `${OOM_KILL_LINE}\n${KILLED_LINE}\n`;
