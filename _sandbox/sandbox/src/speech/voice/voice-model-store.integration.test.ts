import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchLike } from "../model-store.js";
import { createVoiceModelStore } from "./voice-model-store.js";
import type { LocalVoiceModel } from "./voice-models.js";

/* A voice model fetched as its release archive over a fake network and a fake unpack, onto a real disk: checked by its
   pinned digest, found again by its completion mark, and never half there. */

const ARCHIVE = new TextEncoder().encode("pretend this is a tar.bz2 of a voice");

const model = (bytes: Uint8Array<ArrayBuffer> = ARCHIVE): LocalVoiceModel => ({
    id: "vits-piper-xx_XX-test-medium",
    kind: "piper",
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    attribution: "a test voice",
});

interface Serving {
    readonly fetch: FetchLike;
    readonly urls: string[];
}

const serving = (body: Uint8Array<ArrayBuffer>): Serving => {
    const urls: string[] = [];
    return {
        urls,
        fetch: async (url) => {
            urls.push(url);
            return new Response(body, { status: 200 });
        },
    };
};

// Unpacks into the one directory the release's archives hold.
const fakeUnpack = async (_archive: string, into: string): Promise<void> => {
    mkdirSync(join(into, "vits-piper-xx_XX-test-medium"));
    writeFileSync(join(into, "vits-piper-xx_XX-test-medium", "voice.onnx"), "weights");
};

test("a missing model is fetched from its release, checked, unpacked and marked complete", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "voices-"));
    const { fetch, urls } = serving(ARCHIVE);
    const store = createVoiceModelStore({ cacheDir, fetch, unpack: fakeUnpack, log: () => {} });
    expect(await store.state(model())).toEqual({ state: "absent" });
    const dir = await store.ensure(model());
    expect(dir).toBe(join(cacheDir, "vits-piper-xx_XX-test-medium"));
    expect(urls).toEqual(["https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-xx_XX-test-medium.tar.bz2"]);
    expect(readFileSync(join(dir, "voice.onnx"), "utf8")).toBe("weights");
    expect(readFileSync(join(dir, "NOTICE"), "utf8")).toContain("a test voice");
    expect(existsSync(join(cacheDir, "vits-piper-xx_XX-test-medium.tar.bz2"))).toBe(false);
    expect(await store.state(model())).toEqual({ state: "ready", dir });
    // Found again without the network.
    await createVoiceModelStore({ cacheDir, fetch: () => Promise.reject(new Error("must not fetch")), log: () => {} }).ensure(model());
});

test("an archive that is not the pinned one is refused and leaves nothing behind", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "voices-"));
    const tampered = new TextEncoder().encode("pretend this is a tar.bz2 of a VOICE");
    const store = createVoiceModelStore({ cacheDir, fetch: serving(tampered).fetch, unpack: fakeUnpack, log: () => {} });
    const failure = await store.ensure(model()).catch((error: Error) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("arrived corrupt");
    expect(await store.state(model())).toMatchObject({ state: "failed" });
    expect(existsSync(join(cacheDir, "vits-piper-xx_XX-test-medium"))).toBe(false);
});

test("however many ask at once, it is fetched once", async () => {
    const cacheDir = mkdtempSync(join(tmpdir(), "voices-"));
    const { fetch, urls } = serving(ARCHIVE);
    const store = createVoiceModelStore({ cacheDir, fetch, unpack: fakeUnpack, log: () => {} });
    const dirs = await Promise.all([store.ensure(model()), store.ensure(model()), store.ensure(model())]);
    expect(new Set(dirs).size).toBe(1);
    expect(urls).toHaveLength(1);
});
