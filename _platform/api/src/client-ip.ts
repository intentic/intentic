import { isIP } from "node:net";
import type { Config } from "./config.js";

// The caller's address as the proxy in front reports it (api.trustedIpHeader), and nothing else: the socket's peer is
// the proxy, and any other forwarded header is the caller's to write. Undefined when the header is absent or not an
// address, which is a platform with no proxy, not a caller to distrust.
export const clientIp = (headers: Headers, config: Pick<Config, "api">): string | undefined => {
    const header = config.api.trustedIpHeader.trim().toLowerCase();
    if (header === ``) {
        return undefined;
    }
    const value = headers.get(header)?.trim() ?? ``;
    return value !== `` && isIP(value) !== 0 ? value : undefined;
};
