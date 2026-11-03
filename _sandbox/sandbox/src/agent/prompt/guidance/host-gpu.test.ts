import { hostGpu, hostGpuGuidance } from "./host-gpu.js";

// The machine as the test states it: which of these paths exist.
const machine =
    (...paths: readonly string[]) =>
    (path: string): boolean =>
        paths.includes(path);

// rog, 2026-11-02: an agent rendered a page on the owner's display GPU with GPU flags, and the PC powered off.
test("on a Windows PC the turn is told it is the owner's display GPU, to ask through gpu-run, and never to force a browser onto it", () => {
    const wsl = machine("/dev/dxg", "/usr/lib/wsl/lib");
    expect(hostGpu(wsl)).toBe(true);
    const text = hostGpuGuidance(wsl);
    expect(text).toContain("owner's DISPLAY GPU, shared with their Windows through WSL");
    expect(text).toContain("`gpu-run <command…>`");
    expect(text).toContain("`--ignore-gpu-blocklist`");
    expect(text).toContain("owner's own browser on their device");
});

// A privileged container sees every device node of the VM, /dev/dxg included, with nothing to drive it.
test("a device node with no driver libraries beside it is no GPU, and a Linux host's NVIDIA GPU is not called a display GPU", () => {
    expect(hostGpu(machine("/dev/dxg"))).toBe(false);
    expect(hostGpu(machine("/dev/nvidiactl"))).toBe(true);
    expect(hostGpuGuidance(machine("/dev/nvidiactl"))).toMatch(/^This sandbox has the NVIDIA GPU of the computer it runs on\. /u);
});
