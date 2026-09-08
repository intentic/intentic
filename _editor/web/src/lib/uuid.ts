// A UUID that works even where `crypto.randomUUID()` does not: that api is secure-context-only, undefined on plain http
// (a self-hosted LAN instance). `crypto.getRandomValues()` has no such restriction, so the fallback hand-shapes a v4
// UUID from its bytes; `Math.random` is never used, a collision is worse than a throw.

const HEX = Array.from({ length: 256 }, (_, byte) => byte.toString(16).padStart(2, `0`));

export const uuid = (): string => {
    if (typeof crypto.randomUUID === `function`) {
        return crypto.randomUUID();
    }
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    // The two fields a v4 UUID pins: version 4 in the high nibble of byte 6, variant 10xx in byte 8.
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    const hex = [...bytes].map((byte) => HEX[byte]!);
    return `${hex.slice(0, 4).join(``)}-${hex.slice(4, 6).join(``)}-${hex.slice(6, 8).join(``)}-${hex.slice(8, 10).join(``)}-${hex.slice(10).join(``)}`;
};
