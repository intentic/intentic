// The host clause of memory-room.mjs's verdict, apart so that file stays under its size: why work nobody is waiting on
// should wait for the machine this sandbox runs on. Pure; memory-room.mjs `hostWait` is its one caller.
const GIB = 1024 ** 3;
const gib = (bytes) => `${(bytes / GIB).toFixed(1)} GiB`;

// (2026-11-02) Why work nobody is waiting on should wait for the machine this sandbox runs on, or undefined while it need
// not. Everything else here reads the sandbox's own cgroup and the kernel under it, which on a Windows PC is Docker
// Desktop's WSL2 VM: on 2026-11-02 that VM read as roomy while Windows had 1.1 GB left and froze for 43 s. The daemon adds
// `reading.host` from what the host's agent last said (hosts/host-memory.ts), only while that is fresh, so a reading
// without it is "no host to answer to", never "no room". Work waits while starting it would take the host below its
// reserve, the line under which the host's agent starts giving the VM's cache back. Only the work's own cost counts here:
// the person's share in `needBytes` is room inside the sandbox, which the sandbox's own figures already keep.
//
// (2026-11-26, the shinobi-society audit) ONLY WHAT THE VM WOULD TAKE BACK FROM THE HOST COUNTS. rog gives its VM 22 GiB
// of 31.4 and the VM keeps it, so Windows sat under its 3.1 GiB line all day, and 698 of 743 heavy commands since the
// daemon's start waited the full two minutes here and then started anyway: a fixed delay that spared Windows nothing.
// Work inside the VM takes from Windows only the VM's free memory that free page reporting has already handed back
// (`vmReportableBytes`, the guest's free blocks at or above the reporting order): its page cache and its stranded free
// memory are charged to Windows already, and a build that reclaims them takes nothing more. So the work is charged the
// smaller of its cost and what is reportable, after the work that just started has taken its share of that; and work
// that would take nothing is never held, though Windows may already be under its line. A reading without the guest's
// figures (no machine agent that reads them, a PC with room, which the agent does not probe) charges the whole cost, as
// before. The guest's figures may be up to ten minutes old (VM_FIGURES_FRESH_MS in @intentic/machine): whatever the VM
// handed back since then, Windows' own available, which is read on every heartbeat, has gained as well.
export const hostShortOf = (host, costBytes, reservedBytes) => {
    if (host === undefined) {
        return undefined;
    }
    const reportable = host.vmReportableBytes ?? Number.POSITIVE_INFINITY;
    const pending = Math.min(reservedBytes, reportable);
    const charge = Math.min(costBytes, reportable - pending);
    if (charge <= 0 || host.availableBytes - host.reserveBytes - pending >= charge) {
        return undefined;
    }
    const held = pending > 0 ? `, ${gib(pending)} of it held for work that just started` : "";
    const taken = Number.isFinite(reportable) && charge < costBytes ? `; this work would take ${gib(charge)} of it back into the WSL VM` : "";
    return `${host.name}, the machine this sandbox runs on, is low on memory: it has ${gib(host.availableBytes)} available of ${gib(host.totalBytes)}${held}${taken}, and heavy work waits while starting it would leave it under ${gib(host.reserveBytes)}`;
};
