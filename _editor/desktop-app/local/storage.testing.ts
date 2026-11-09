// The browser's storage as a page has it, for the local face's suites: plain names, nothing scoped, in memory. One copy
// for every suite here that stands a window's storage up (folderSession.test.ts, platform.test.ts).

export const memoryStorage = (): Storage => {
    const items = new Map<string, string>();
    return {
        get length() {
            return items.size;
        },
        clear: () => items.clear(),
        getItem: (key) => items.get(key) ?? null,
        key: (index) => [...items.keys()][index] ?? null,
        removeItem: (key) => void items.delete(key),
        setItem: (key, value) => void items.set(key, String(value)),
    };
};
