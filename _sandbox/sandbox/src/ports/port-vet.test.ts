import type { ListeningPort } from "./port-scan.js";
import { daemonListenerPorts, portRefusal } from "./port-vet.js";

/* The ports never handed an outside address (2026-11-23): the daemon's own listeners, for this sandbox's forwards and
   for a runner's, whose loopback listener answers its whole unauthenticated API. */

const config = { sandbox: { port: 8787 }, preview: { port: 8789 }, local: { port: 8788 } } as const;
const listening = (port: number): ListeningPort => ({ port, host: "127.0.0.1", forwardable: true, pid: 1, command: "intentic-netd" });

test("the daemon's own listeners, the loopback one included, are never forwarded however they listen", () => {
    const reserved = daemonListenerPorts(config);
    expect([...reserved].toSorted()).toEqual([22, 8787, 8788, 8789]);
    for (const port of reserved) {
        expect(portRefusal(port, [listening(port)], reserved)).toContain("belongs to the sandbox itself");
    }
    expect(portRefusal(5173, [listening(5173)], reserved)).toBeUndefined();
});
