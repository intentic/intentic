// THE LAST PICTURE OF EACH TAB, FOR AN INSTANT SWITCH. A tab switch is a round trip (the strip's `bind`, Chromium
// bringing the tab in front, its first paint, castd, the decoder), so the tab being switched to is shown at once from
// what it last looked like, until a live frame of it arrives. Pictures are big (a 2560x1600 screen is 16 MB), so the
// cache is capped by bytes and lets go of the least recently used; a picture let go of is closed, which frees it.

export interface Still {
    readonly width: number;
    readonly height: number;
    readonly close: () => void;
}

export interface StillCache<Picture extends Still> {
    // Keeps `picture` as `key`'s, replacing (and closing) any it had.
    readonly put: (key: string, picture: Picture) => void;
    // `key`'s picture, now the most recently used; undefined when none is held.
    readonly take: (key: string) => Picture | undefined;
    readonly bytes: () => number;
    readonly keys: () => readonly string[];
    readonly clear: () => void;
}

const STILL_CACHE_BYTES = 64 * 1024 * 1024;

const sizeOf = (picture: Still): number => picture.width * picture.height * 4;

export const stillCache = <Picture extends Still>(capBytes: number = STILL_CACHE_BYTES): StillCache<Picture> => {
    // A Map iterates in insertion order: re-inserting on use makes its first key the least recently used.
    const held = new Map<string, Picture>();
    let total = 0;
    const drop = (key: string): void => {
        const picture = held.get(key);
        if (picture !== undefined) {
            held.delete(key);
            total -= sizeOf(picture);
            picture.close();
        }
    };
    return {
        put: (key, picture) => {
            drop(key);
            // One picture over the whole cap is not kept at all: it would evict everything and then itself.
            if (sizeOf(picture) > capBytes) {
                picture.close();
                return;
            }
            held.set(key, picture);
            total += sizeOf(picture);
            for (const oldest of held.keys()) {
                if (total <= capBytes) {
                    break;
                }
                drop(oldest);
            }
        },
        take: (key) => {
            const picture = held.get(key);
            if (picture !== undefined) {
                held.delete(key);
                held.set(key, picture);
            }
            return picture;
        },
        bytes: () => total,
        keys: () => [...held.keys()],
        clear: () => {
            for (const key of held.keys()) {
                drop(key);
            }
        },
    };
};
