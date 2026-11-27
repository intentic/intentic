import { readFile, writeFile } from "node:fs/promises";
import { errorMessage } from "@intentic/base/errors";

// TCP's own path-MTU black-hole detection (RFC 4821 packetization-layer PMTUD), for this sandbox's network namespace.
// A tunnel that carries less than the 1500 bytes the interface reports, and drops the rest without the ICMP
// "fragmentation needed" that would tell TCP to shrink, hangs every request bigger than one packet while small ones
// work: a git push through an IPsec tunnel that carried 1195 bytes sat 65 s until the server gave up, and ls-remote
// never noticed. Mode 1 leaves TCP alone until it sees that (full-size segments retransmitted with no answer), then
// drops to tcp_base_mss (1024) and probes back up, so the transfer stalls for seconds instead of failing.
// The sysctl belongs to the network namespace, so this changes nothing outside the container.
const TCP_MTU_PROBING_PATH = "/proc/sys/net/ipv4/tcp_mtu_probing";

// Turns detection on; why it could not (a read-only /proc/sys) comes back as text, since a tunnel works without it.
// A value already non-zero (2 probes on every connection) was set on purpose and is left alone.
export const enableTcpMtuProbing = async (path: string = TCP_MTU_PROBING_PATH): Promise<string | undefined> => {
    try {
        if ((await readFile(path, "utf8")).trim() !== "0") {
            return undefined;
        }
        await writeFile(path, "1\n");
        return undefined;
    } catch (error) {
        return errorMessage(error);
    }
};
