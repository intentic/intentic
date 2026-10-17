import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Over a real socket, with a client that offers permessage-deflate as every browser and ws do: a peer link is
// negotiated deflated and its frames arrive whole; a media socket's offer is dropped, so it stays raw. Probed under
// Node (__fixtures__/peer-deflate-probe.ts), the daemon's runtime: Bun's own `ws` never negotiates an extension at all.

const probe = fileURLToPath(new URL("__fixtures__/peer-deflate-probe.ts", import.meta.url));

type Probed = Record<string, { extensions: string; whole: boolean }>;

test("a peer link is negotiated deflated; every other socket is served raw, whatever the client offers", () => {
    // SAFETY: the probe prints exactly one JSON object of this shape and nothing else.
    const probed = JSON.parse(execFileSync("node", ["--import", "tsx", probe], { encoding: "utf8", timeout: 60_000 })) as Probed;
    for (const path of ["/system/hosts/connect", "/system/runners/connect"]) {
        expect(probed[path]).toEqual({ extensions: "permessage-deflate", whole: true });
    }
    for (const path of ["/browser/view", "/speech/listen", "/system/hosts/connect/extra"]) {
        expect(probed[path]).toEqual({ extensions: "", whole: true });
    }
});
