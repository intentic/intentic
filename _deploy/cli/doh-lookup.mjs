// Local-resolver workaround used ONLY by `pnpm demo:up` (passed to the CLI children via NODE_OPTIONS
// --import). The engine talks to Forgejo/Komodo over their public URLs (https://git.<zone>,
// https://deploy.<zone>); right after the demo creates those DNS records this machine's resolver can still
// negative-cache them, so the engine's fetch() fails. This hook routes lookups for the demo zone through
// Cloudflare DoH over HTTPS (no port-53 / root needed) so the freshly created hostnames resolve immediately.
// It only intercepts names in DEMO_DOH_ZONE; everything else falls through to the real resolver.
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const dns = require("node:dns");
const dnsPromises = require("node:dns/promises");

const zone = process.env.DEMO_DOH_ZONE ?? process.env.CLOUDFLARE_ZONE ?? "intentic.dev";
const inZone = (host) => typeof host === "string" && (host === zone || host.endsWith(`.${zone}`));

const resolveDoh = async (host) => {
    const response = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=A`, {
        headers: { accept: "application/dns-json" },
    });
    const body = await response.json();
    return (body.Answer ?? []).filter((answer) => answer.type === 1).map((answer) => answer.data);
};

const realLookup = dns.lookup;
dns.lookup = (hostname, options, callback) => {
    const cb = typeof options === "function" ? options : callback;
    const opts = typeof options === "function" ? {} : (options ?? {});
    if (!inZone(hostname)) {
        return realLookup(hostname, options, callback);
    }
    resolveDoh(hostname)
        .then((ips) => {
            if (ips.length === 0) {
                realLookup(hostname, options, callback);
                return;
            }
            if (opts.all) {
                cb(
                    null,
                    ips.map((address) => ({ address, family: 4 })),
                );
            } else {
                cb(null, ips[0], 4);
            }
        })
        .catch(() => realLookup(hostname, options, callback));
};

const realPromisesLookup = dnsPromises.lookup;
dnsPromises.lookup = async (hostname, options) => {
    if (!inZone(hostname)) {
        return realPromisesLookup(hostname, options);
    }
    const ips = await resolveDoh(hostname).catch(() => []);
    if (ips.length === 0) {
        return realPromisesLookup(hostname, options);
    }
    return (options ?? {}).all ? ips.map((address) => ({ address, family: 4 })) : { address: ips[0], family: 4 };
};
