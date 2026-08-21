/* A UUID, IN EVERY CONTEXT THE APP IS ACTUALLY SERVED FROM.
 *
 * `crypto.randomUUID()` is a SECURE-CONTEXT api: it exists on https and on localhost, and is simply undefined
 * anywhere else. That "anywhere else" is not exotic, it is a self-hosted instance reached at
 * `http://192.168.1.x:port`, which is how someone on their own network opens this app. There, every one of these
 * call sites throws, and they are the ones that start a conversation, attach a file, open a terminal tab, claim
 * a floating window and identify a liveness client: the whole app, dead at the first gesture, with a stack trace
 * naming a browser api rather than anything the reader did. A floating window made it worst, because the throw
 * lands in the route's setup: the window boots, crashes, self-heals by wiping this origin's stored state and
 * reloading, and comes back to an empty rectangle.
 *
 * `crypto.getRandomValues()` has no such restriction: it is on `Crypto` rather than on `SubtleCrypto`, and every
 * browser offers it on plain http. So the real generator is used where it exists and the same bytes are shaped
 * by hand where it does not, which is a v4 UUID either way, from the same entropy source, with no api that can
 * be missing. `Math.random` is deliberately NOT a fallback: an id that collides is worse than one that throws,
 * and there is no browser where both crypto calls are gone.
 *
 * One helper, imported everywhere, rather than a guard at each call site: the ones that matter are exactly the
 * ones nobody thinks about. */

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
