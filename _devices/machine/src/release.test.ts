import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { agentAssetUrl, archToken, exe, isLeftover, launcherAssetUrl, osToken, probeVersion } from "./release.js";

describe("release asset URLs", () => {
    // Two environments of one PC downloading "latest" a minute apart can land on two releases; a tag cannot.
    it("name one tag, never the moving `latest`", () => {
        expect(agentAssetUrl("1.305.0")).toBe(
            `https://github.com/intentic/intentic/releases/download/v1.305.0/intentic-machine-${osToken()}-${archToken()}${exe}`,
        );
        expect(launcherAssetUrl("1.305.0")).toBe(
            `https://github.com/intentic/intentic/releases/download/v1.305.0/intentic-launch-windows-${archToken()}.exe`,
        );
        expect(agentAssetUrl("1.305.0")).not.toContain("latest");
    });
});

describe("isLeftover", () => {
    it("names what a finished swap or an extracted tarball leaves behind", () => {
        for (const name of [
            "intentic-machine.exe.old",
            "intentic-machine.exe.previous",
            "intentic-machine.previous",
            "intentic-launch.exe.old",
            "intentic-launch.exe.tmp",
            "intentic-launch.exe.previous",
            "mutagen.exe.old",
            "mutagen.tar.gz",
        ]) {
            expect(isLeftover(name), name).toBe(true);
        }
    });

    // A versioned part file is an interrupted download the next attempt resumes; Mutagen needs its agents bundle.
    it("keeps the binaries, resumable downloads and Mutagen's agent bundle", () => {
        for (const name of [
            "intentic-machine.exe",
            "intentic-machine",
            "intentic-launch.exe",
            "mutagen.exe",
            "mutagen-agents.tar.gz",
            "intentic-machine.exe.new-1.305.0",
            "intentic-machine.exe.part-1.305.0.exe",
            "upgrade.lock",
        ]) {
            expect(isLeftover(name), name).toBe(false);
        }
    });
});

describe.skipIf(process.platform === "win32")("probeVersion", () => {
    const script = (body: string): string => {
        const path = join(mkdtempSync(join(tmpdir(), "probe-")), "agent");
        writeFileSync(path, `#!/bin/sh\n${body}\n`);
        chmodSync(path, 0o755);
        return path;
    };

    it("reads the bare version a working agent prints", () => {
        expect(probeVersion(script(`echo 1.305.0`))).toEqual({ kind: "version", version: "1.305.0" });
    });

    // A captive-portal page or a truncated body downloads fine and must never become the agent.
    it("calls a file that will not run unusable", () => {
        const path = join(mkdtempSync(join(tmpdir(), "probe-")), "agent");
        writeFileSync(path, "<html>sign in to the wifi</html>");
        chmodSync(path, 0o755);
        expect(probeVersion(path).kind).not.toBe("version");
    });

    it("tells an agent too old for `version` from one that answered nonsense", () => {
        expect(probeVersion(script(`echo "No command registered for version" >&2; exit 1`))).toEqual({ kind: "no-version-command" });
        expect(probeVersion(script(`echo hello`))).toEqual({ kind: "unusable" });
    });
});
