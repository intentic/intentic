import { probeRoutes } from "./probe.routes.js";

const ping = async (): Promise<void> => undefined;

// ICO's header: reserved 0, type 1 (icon), then the image count.
test("GET /favicon.ico answers an ICO of three sizes, cacheable, with no session", async () => {
    const res = await probeRoutes({ ping }).request(`/favicon.ico`);
    expect(res.status).toBe(200);
    expect(res.headers.get(`content-type`)).toBe(`image/x-icon`);
    expect(res.headers.get(`cache-control`)).toContain(`public`);
    const bytes = Buffer.from(await res.arrayBuffer());
    expect([bytes.readUInt16LE(0), bytes.readUInt16LE(2), bytes.readUInt16LE(4)]).toEqual([0, 1, 3]);
});

test("GET /health reads the database and says ok, or 503 with why when it cannot", async () => {
    expect(await (await probeRoutes({ ping }).request(`/health`)).json()).toEqual({ status: `ok` });
    const down = async (): Promise<void> => {
        throw new Error(`connection refused`);
    };
    const res = await probeRoutes({ ping: down }).request(`/health`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: `error`, message: `connection refused` });
});
