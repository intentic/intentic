import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runBounded } from "@intentic/base/process";
import { homeDir } from "@intentic/local-agent";
import { KEYRING_NATIVE_HOST } from "@intentic/sandbox-contract/schemas/keyring-native";
import { binDir } from "../config.js";
import { keyringPath } from "../release.js";
import { KeyringCliError } from "./flags.js";

// THE BROWSER'S WAY TO PASSWORDS: Chrome native messaging's host manifest (`dev.intentic.keyring`), naming a small
// launcher next to the keyring that runs `intentic-keyring native-host`, and letting in the Intentic extension alone.
// Windows reads the manifest's path from the registry, one key per browser under HKCU; Linux from a file in each
// browser's own config folder. Written for every Chromium browser this user has run, and removed the same way.

/**
 * The Intentic extension as the Chrome Web Store published it (`_extensions/browsers/intentic-extension.json`'s store
 * link). Its id is fixed by the store's key; a build loaded unpacked has another and is not let in.
 */
const INTENTIC_EXTENSION_IDS = ["ipdmljdopicihjdlgiiplaiolngbinma"] as const;

export interface BrowserPlace {
    readonly name: string;
    // The user data folder: under %LOCALAPPDATA% on Windows, under ~/.config on Linux. Its presence says the browser ran.
    readonly windowsData: string;
    readonly windowsKey: string;
    readonly linuxConfig: string;
}

const BROWSERS: readonly BrowserPlace[] = [
    { name: "Chrome", windowsData: "Google\\Chrome\\User Data", windowsKey: "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts", linuxConfig: "google-chrome" },
    { name: "Chromium", windowsData: "Chromium\\User Data", windowsKey: "HKCU\\Software\\Chromium\\NativeMessagingHosts", linuxConfig: "chromium" },
    { name: "Brave", windowsData: "BraveSoftware\\Brave-Browser\\User Data", windowsKey: "HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts", linuxConfig: "BraveSoftware/Brave-Browser" },
    { name: "Edge", windowsData: "Microsoft\\Edge\\User Data", windowsKey: "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts", linuxConfig: "microsoft-edge" },
];

export interface NativeHostManifest {
    readonly name: string;
    readonly description: string;
    readonly path: string;
    readonly type: "stdio";
    readonly allowed_origins: readonly string[];
}

/** The manifest Chrome reads. Pure. */
const nativeHostManifest = (launcher: string): NativeHostManifest => ({
    name: KEYRING_NATIVE_HOST,
    description: "Intentic Passwords",
    path: launcher,
    type: "stdio",
    allowed_origins: INTENTIC_EXTENSION_IDS.map((id) => `chrome-extension://${id}/`),
});

/** The launcher Chrome starts: it runs the keyring's `native-host`, passing on what the browser passed. Pure. */
const launcherText = (platform: NodeJS.Platform, keyring: string): string =>
    platform === "win32" ? `@echo off\r\n"${keyring}" native-host %*\r\n` : `#!/bin/sh\nexec '${keyring.replaceAll("'", "'\\''")}' native-host "$@"\n`;

export interface NativeHostPlace {
    readonly platform: NodeJS.Platform;
    readonly home: string;
    readonly localAppData: string;
    readonly bin: string;
    readonly keyring: string;
}

const herePlace = (): NativeHostPlace => ({
    platform: process.platform,
    home: homeDir(),
    localAppData: process.env["LOCALAPPDATA"] ?? join(homeDir(), "AppData", "Local"),
    bin: binDir,
    keyring: keyringPath,
});

const manifestFile = (place: NativeHostPlace): string => join(place.bin, `${KEYRING_NATIVE_HOST}.json`);
const launcherFile = (place: NativeHostPlace): string => join(place.bin, place.platform === "win32" ? "intentic-native-host.bat" : "intentic-native-host");
const linuxManifest = (place: NativeHostPlace, browser: BrowserPlace): string => join(place.home, ".config", browser.linuxConfig, "NativeMessagingHosts", `${KEYRING_NATIVE_HOST}.json`);

/** The browsers this user has run here. */
const installedBrowsers = (place: NativeHostPlace = herePlace()): BrowserPlace[] =>
    BROWSERS.filter((browser) => existsSync(place.platform === "win32" ? join(place.localAppData, browser.windowsData) : join(place.home, ".config", browser.linuxConfig)));

const reg = async (args: readonly string[]): Promise<{ readonly ok: boolean; readonly out: string }> => {
    const result = await runBounded("reg.exe", [...args], { timeoutMs: 20_000 });
    return { ok: result.exitCode === 0, out: result.stdout.text };
};

export interface NativeHostState {
    readonly browsers: readonly string[];
    // The browsers whose manifest points at this keyring.
    readonly ready: readonly string[];
}

export const nativeHostStatus = async (place: NativeHostPlace = herePlace()): Promise<NativeHostState> => {
    const browsers = installedBrowsers(place);
    const ready: string[] = [];
    for (const browser of browsers) {
        if (place.platform === "win32") {
            const read = await reg(["query", `${browser.windowsKey}\\${KEYRING_NATIVE_HOST}`, "/ve"]);
            if (read.ok && read.out.includes(manifestFile(place)) && existsSync(manifestFile(place))) {
                ready.push(browser.name);
            }
        } else if (existsSync(linuxManifest(place, browser))) {
            ready.push(browser.name);
        }
    }
    return { browsers: browsers.map((browser) => browser.name), ready };
};

/** The manifests written for every browser found; refused when there is none, or the platform has no browser host. */
export const installNativeHost = async (place: NativeHostPlace = herePlace()): Promise<NativeHostState> => {
    if (place.platform !== "win32" && place.platform !== "linux") {
        throw new KeyringCliError("unavailable", `Passwords cannot reach a browser on ${place.platform} yet.`);
    }
    const browsers = installedBrowsers(place);
    if (browsers.length === 0) {
        throw new KeyringCliError("unavailable", "No Chrome, Chromium, Brave or Edge has been run by this user here.");
    }
    await mkdir(place.bin, { recursive: true });
    const launcher = launcherFile(place);
    await writeFile(launcher, launcherText(place.platform, place.keyring), { mode: 0o755 });
    const manifest = `${JSON.stringify(nativeHostManifest(launcher), null, 2)}\n`;
    if (place.platform === "win32") {
        await writeFile(manifestFile(place), manifest);
        for (const browser of browsers) {
            const added = await reg(["add", `${browser.windowsKey}\\${KEYRING_NATIVE_HOST}`, "/ve", "/t", "REG_SZ", "/d", manifestFile(place), "/f"]);
            if (!added.ok) {
                throw new KeyringCliError("failed", `Windows would not register Passwords for ${browser.name}.`);
            }
        }
    } else {
        for (const browser of browsers) {
            const file = linuxManifest(place, browser);
            await mkdir(join(file, ".."), { recursive: true });
            await writeFile(file, manifest, { mode: 0o644 });
        }
    }
    return await nativeHostStatus(place);
};

export const uninstallNativeHost = async (place: NativeHostPlace = herePlace()): Promise<NativeHostState> => {
    for (const browser of BROWSERS) {
        if (place.platform === "win32") {
            await reg(["delete", `${browser.windowsKey}\\${KEYRING_NATIVE_HOST}`, "/f"]);
        } else {
            await rm(linuxManifest(place, browser), { force: true });
        }
    }
    await rm(manifestFile(place), { force: true });
    await rm(launcherFile(place), { force: true });
    return { browsers: installedBrowsers(place).map((browser) => browser.name), ready: [] };
};
