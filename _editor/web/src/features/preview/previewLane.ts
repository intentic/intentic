// A preview's address for THIS browser. The daemon hands out one public address per forwarded port or panel, which
// crosses Cloudflare and the tunnel twice even when the browser sits on the sandbox's own machine: hundreds of
// milliseconds a request, and every byte through that machine's upload bandwidth. The daemon's loopback lane, which
// the app already reaches its API over, serves the preview proxy too for plain connections whose Host names a preview
// label, so on that lane a preview has a loopback twin.

// The loopback twin of a public preview address: the same label on a name every browser resolves to loopback without
// DNS (`*.localhost`, a secure context in every major browser), on the port the loopback lane is published at.
// Undefined off the loopback lane, or for an address that carries no preview label.
export const loopbackPreviewUrl = (publicUrl: string, daemonBase: string | undefined, usingLocal: boolean): string | undefined => {
    if (!usingLocal || daemonBase === undefined) {
        return undefined;
    }
    let target: URL;
    let lane: URL;
    try {
        target = new URL(publicUrl);
        lane = new URL(daemonBase);
    } catch {
        return undefined;
    }
    const label = target.hostname.split(`.`)[0] ?? ``;
    if (!/^(?:preview|port|public)-/.test(label)) {
        return undefined;
    }
    const port = lane.port !== `` ? lane.port : lane.protocol === `https:` ? `443` : `80`;
    return `http://${label}.localhost:${port}${target.pathname}${target.search}`;
};
