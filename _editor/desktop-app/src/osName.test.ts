import { osNameOf } from "./osName";

// This computer's header names the OS as people do, not as Node's `process.platform` does.
it(`names each platform the machine agent reports by its product name, and an unknown one as it came`, () => {
    expect([`win32`, `linux`, `darwin`, `freebsd`, `aix`, ``].map(osNameOf)).toEqual([`Windows`, `Linux`, `macOS`, `FreeBSD`, `aix`, ``]);
});
