// The one door to the daemon's plain-JSON routes: a call is its contract key, so the path, the body and the answer's
// schema all come from the route table, and a route that needs a value in its path cannot be called without it.
import { ZodError } from "zod";

const sandboxJson = jest.fn<(path: string, init?: RequestInit) => Promise<object>>();
const sandboxUpload = jest.fn<(path: string, body: Blob, options?: object) => Promise<void>>();
jest.mock(`../sandboxClient`, () => ({
    sandboxJson: (path: string, init?: RequestInit) => sandboxJson(path, init),
    sandboxUpload: (path: string, body: Blob, options?: object) => sandboxUpload(path, body, options),
}));

const { sandboxRaw } = await import(`../sandboxRaw`);
const { sandboxRawUpload } = await import(`../sandboxRawUpload`);

// The call as the client received it: its path, and the init when there was one.
const sent = (): readonly [string, RequestInit | undefined] => {
    const [path, init] = sandboxJson.mock.calls.at(-1) ?? [``, undefined];
    return [path, init];
};

beforeEach(() => {
    sandboxJson.mockReset();
    sandboxUpload.mockReset();
});

describe(`sandboxRaw`, () => {
    it(`reads a route by its key, with no request options when none were asked for`, async () => {
        sandboxJson.mockResolvedValue({ runners: [] });
        expect(await sandboxRaw(`GET /system/runners`)).toEqual({ runners: [] });
        expect(sandboxJson.mock.calls.at(-1)).toEqual([`/system/runners`]);
    });

    it(`fills a route's {param} as one encoded path segment`, async () => {
        sandboxJson.mockResolvedValue({ ok: true });
        await sandboxRaw(`DELETE /system/hosts/{id}`, { params: { id: `my laptop/1` } });
        expect(sent()[0]).toBe(`/system/hosts/my%20laptop%2F1`);
        expect(sent()[1]).toEqual({ method: `DELETE` });
    });

    it(`appends the query, and names a peer's pairing by it`, async () => {
        sandboxJson.mockResolvedValue({ token: `t`, expiresIn: 600 });
        await sandboxRaw(`POST /system/webext/pair`, { query: { id: `work browser` } });
        expect(sent()).toEqual([`/system/webext/pair?id=work+browser`, { method: `POST` }]);
    });

    it(`sends a JSON input under its content type, beside any header the route reads by name`, async () => {
        sandboxJson.mockResolvedValue({ members: [] });
        await sandboxRaw(`POST /members`, { input: { email: `a@example.com`, role: `viewer` }, headers: { "x-intentic-base-hash": `abc` } });
        expect(sent()).toEqual([
            `/members`,
            { method: `POST`, headers: { "content-type": `application/json`, "x-intentic-base-hash": `abc` }, body: JSON.stringify({ email: `a@example.com`, role: `viewer` }) },
        ]);
    });

    it(`hands a bytes route its body as it is, and a document route its text`, async () => {
        sandboxJson.mockResolvedValue({ ok: true });
        const archive = new Blob([`tar`]);
        await sandboxRaw(`POST /workspace/upload`, { query: { path: `notes/a b.md` }, input: archive, headers: { "x-intentic-base-hash": `h1` } });
        expect(sent()).toEqual([`/workspace/upload?path=notes%2Fa+b.md`, { method: `POST`, body: archive, headers: { "x-intentic-base-hash": `h1` } }]);

        sandboxJson.mockResolvedValue({ changed: false });
        await sandboxRaw(`POST /definition/diff`, { input: `name = "x"` }).catch(() => undefined);
        expect(sent()[1]).toEqual({ method: `POST`, body: `name = "x"` });
    });

    it(`carries the caller's signal on a read`, async () => {
        sandboxJson.mockResolvedValue({ hosts: [] });
        const signal = new AbortController().signal;
        await sandboxRaw(`GET /system/hosts`, { signal });
        expect(sent()).toEqual([`/system/hosts`, { signal }]);
    });

    it(`refuses an answer the route's own schema does not accept, so a shape drift is an error and not a cast`, async () => {
        sandboxJson.mockResolvedValue({ runners: `none` });
        await expect(sandboxRaw(`GET /system/runners`)).rejects.toBeInstanceOf(ZodError);
    });

    it(`cannot name a route with a {param} without its value`, async () => {
        sandboxJson.mockResolvedValue({ ok: true });
        // @ts-expect-error a route with a {param} takes `params`; the compiler refuses the call that leaves it out
        await expect(sandboxRaw(`DELETE /system/hosts/{id}`)).rejects.toThrow(`needs a value for {id}`);
        // @ts-expect-error and one that names another route's value
        await expect(sandboxRaw(`DELETE /system/hosts/{id}`, { params: { machine: `x` } })).rejects.toThrow(`needs a value for {id}`);
    });
});

describe(`sandboxRawUpload`, () => {
    it(`uploads to the route's own path, in parts, with its query`, async () => {
        const file = new Blob([`bytes`]);
        const onProgress = jest.fn();
        await sandboxRawUpload(`POST /workspace/upload`, file, { query: { path: `a.txt`, mtime: `7` }, onProgress });
        expect(sandboxUpload.mock.calls.at(-1)).toEqual([`/workspace/upload?path=a.txt&mtime=7`, file, { onProgress }]);
    });

    it(`sends a tar whole, with no query to add an offset to`, async () => {
        const tar = new Blob([`tar`]);
        await sandboxRawUpload(`POST /workspace/upload-archive`, tar, { whole: true });
        expect(sandboxUpload.mock.calls.at(-1)).toEqual([`/workspace/upload-archive`, tar, { whole: true }]);
    });
});
