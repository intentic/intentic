// THE OS BY THE NAME PEOPLE KNOW IT, for This computer's header (machine.ts `hardware`). The machine agent's report names
// it as Node's `process.platform` does (_devices/machine/src/sync/report.ts): nobody calls their PC `win32` or their Mac
// `darwin`, and the header read "omen · win32" until 2026-10-12. The names are the products' own, the same in every
// language, as the workspace's Devices rows give them (the web's features/sandbox/devices/deviceFacts.ts). One this
// table does not know is shown as the agent said it, rather than as nothing.
const OS_NAMES: ReadonlyMap<string, string> = new Map([
    [`win32`, `Windows`],
    [`linux`, `Linux`],
    [`darwin`, `macOS`],
    [`freebsd`, `FreeBSD`],
    [`openbsd`, `OpenBSD`],
]);

/** `os` as the machine agent reports it (`win32`, `linux`, `darwin`), by its product name. */
export const osNameOf = (os: string): string => OS_NAMES.get(os) ?? os;
