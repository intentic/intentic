import { createHash } from "node:crypto";

/* Linux caps an interface name at IFNAMSIZ-1 = 15 bytes. */
const INTERFACE_MAX = 15;

export const interfaceNameOf = (candidate: string, tag: string): string =>
    candidate.length <= INTERFACE_MAX
        ? candidate
        : `${tag}-${createHash("sha256")
              .update(candidate)
              .digest("hex")
              .slice(0, INTERFACE_MAX - tag.length - 1)}`;
