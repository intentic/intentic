// A conversation's debug bundle is read from the sandbox it runs in, by the route's own key, and saved under the
// conversation's id: the file someone outside the sandbox is handed has to say which conversation it is.
import "@intentic/testing/dom";
import { CONVERSATION_BUNDLE_KIND, type ConversationBundle } from "@intentic/sandbox-contract/schemas/diagnostics";

const BUNDLE: ConversationBundle = {
    kind: CONVERSATION_BUNDLE_KIND,
    version: 1,
    exportedAt: `2026-11-08T10:00:00.000Z`,
    sandbox: { name: `shop` },
    conversation: `wise-fern-usz1`,
    show: { id: `wise-fern-usz1` },
    transcript: { rows: [], total: 0 },
    timeline: `timeline`,
    turns: `turns`,
    errors: `errors`,
    restarts: `restarts`,
    browser: `browser`,
};

const sandboxRaw = jest.fn(async (..._args: unknown[]): Promise<ConversationBundle> => BUNDLE);
const sandboxJsonAt = jest.fn(async (..._args: unknown[]): Promise<ConversationBundle> => BUNDLE);
jest.mock(`../../../../client/sandbox/sandboxRaw`, () => ({ sandboxRaw: (...args: unknown[]) => sandboxRaw(...args) }));
jest.mock(`../../../../client/sandbox/sandboxClient`, () => ({ sandboxJsonAt: (...args: unknown[]) => sandboxJsonAt(...args) }));

const { bundleFileName, downloadBundle } = await import("./agentBundle");

// What each click saved: the object URL's bytes, read back, and the name it was saved under.
const saved: { name: string; body: Blob }[] = [];
const original = HTMLAnchorElement.prototype.click;
const made = new Map<string, Blob>();

beforeEach(() => {
    saved.length = 0;
    made.clear();
    sandboxRaw.mockClear();
    sandboxJsonAt.mockClear();
    globalThis.URL.createObjectURL = jest.fn((blob: Blob) => {
        const url = `blob:${made.size + 1}`;
        made.set(url, blob);
        return url;
    });
    globalThis.URL.revokeObjectURL = jest.fn();
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
        saved.push({ name: this.download, body: made.get(this.href) ?? new Blob() });
    };
});
afterEach(() => {
    HTMLAnchorElement.prototype.click = original;
});

it(`reads the active sandbox's bundle through its raw route and saves it under the conversation's id`, async () => {
    expect(await downloadBundle(`wise-fern-usz1`)).toBe(`wise-fern-usz1-bundle.json`);
    expect(sandboxRaw).toHaveBeenCalledWith(`GET /fleet/{handle}/bundle`, { params: { handle: `wise-fern-usz1` } });
    expect(sandboxJsonAt).not.toHaveBeenCalled();
    expect(saved.map(({ name }) => name)).toEqual([`wise-fern-usz1-bundle.json`]);
    expect(saved[0]?.body.type).toBe(`application/json`);
    expect(JSON.parse(await (saved[0]?.body ?? new Blob()).text())).toEqual(BUNDLE);
});

it(`reads another sandbox's conversation from that sandbox, with the path its id fills`, async () => {
    await downloadBundle(`brave otter`, `sbx-laptop`);
    expect(sandboxRaw).not.toHaveBeenCalled();
    expect(sandboxJsonAt.mock.calls[0]?.slice(0, 2)).toEqual([`sbx-laptop`, `/fleet/brave%20otter/bundle`]);
    expect(saved.map(({ name }) => name)).toEqual([bundleFileName(`brave otter`)]);
});

it(`saves nothing when the sandbox refuses`, async () => {
    sandboxRaw.mockRejectedValueOnce(new Error(`refused`));
    await expect(downloadBundle(`wise-fern-usz1`)).rejects.toThrow(`refused`);
    expect(saved).toEqual([]);
});
