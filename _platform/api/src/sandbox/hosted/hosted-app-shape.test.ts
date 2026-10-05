import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import type { PrismaClient } from "@intentic/prisma";
import type { Config } from "../../config.js";
import { fakeHostedAppLock, testIngressConfig } from "../../testing.js";
import { APP_SHAPE_DESTROYS_PER_PASS, sweepHostedAppShapes } from "./hosted-app-shape.js";
import { hostedInstanceId } from "./hosted.js";

jest.mock(`./hosted-app-lock.js`, () => ({ withHostedAppLock: fakeHostedAppLock }));

// The daily hold of every person's app to its one machine and one disk (hosted-app-shape.ts): what it destroys, and
// everything it only reports.

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as never;

const config = {
    api: { url: `https://api.test` },
    ingress: testIngressConfig,
    hosted: { flyApiToken: `fly`, flyOrg: `intentic`, appPrefix: `intentic-sbx` },
} as unknown as Config;
const INSTANCE = hostedInstanceId(config);

const row = (appName: string, over: Record<string, unknown> = {}) => ({
    appName,
    machineId: `m-row`,
    volumeId: `vol-row`,
    migratingId: null,
    buildingId: null,
    ...over,
});
const prismaWith = (rows: unknown[]) => ({ hostedMachine: { findMany: jest.fn().mockResolvedValue(rows) } }) as unknown as PrismaClient;

// A machine as Fly lists it: whose stamp, and how old.
const machine = (id: string, platform: string | undefined, ageMinutes = 120) => ({
    id,
    state: `started`,
    created_at: new Date(Date.now() - ageMinutes * 60_000).toISOString(),
    config: { metadata: platform === undefined ? {} : { intentic_role: `sandbox`, intentic_platform: platform } },
});

// Fly for these cases: each app's machines and volumes, and every DELETE recorded.
const stubApps = (apps: Record<string, { machines: unknown[]; volumes?: string[] }>) => {
    const deleted: string[] = [];
    stubGlobal(`fetch`, (url: URL | string, init?: RequestInit) => {
        const target = String(url);
        if (init?.method === `DELETE`) {
            deleted.push(target.replace(`https://api.machines.dev/v1/apps/`, ``).replace(`?force=true`, ``));
            return Promise.resolve(new Response(`{}`));
        }
        const [, app, kind] = /\/apps\/([^/]+)\/(machines|volumes)$/.exec(target) ?? [];
        const held = apps[app ?? ``];
        if (held === undefined) {
            return Promise.resolve(new Response(`{"error":"not found"}`, { status: 404 }));
        }
        const body = kind === `machines` ? held.machines : (held.volumes ?? [`vol-row`]).map((id) => ({ id }));
        return Promise.resolve(new Response(JSON.stringify(body)));
    });
    return deleted;
};

afterEach(() => unstubAllGlobals());

describe(`sweepHostedAppShapes`, () => {
    it(`destroys a machine of ours the row does not name, and leaves the row's machine and every volume`, async () => {
        const deleted = stubApps({
            "intentic-sbx-a": { machines: [machine(`m-row`, INSTANCE), machine(`m-stray`, INSTANCE)], volumes: [`vol-row`, `vol-old`] },
        });
        const report = await sweepHostedAppShapes(prismaWith([row(`intentic-sbx-a`)]), config, logger);
        expect(deleted).toEqual([`intentic-sbx-a/machines/m-stray`]);
        expect(report).toMatchObject({ apps: 1, destroyed: [`intentic-sbx-a/m-stray`], strayVolumes: [`intentic-sbx-a/vol-old`], waiting: 0 });
    });

    it(`reports a machine another deployment or nobody stamped, and touches it not`, async () => {
        const deleted = stubApps({
            "intentic-sbx-a": { machines: [machine(`m-row`, INSTANCE), machine(`m-theirs`, `deadbeefcafe`), machine(`m-nobody`, undefined)] },
        });
        const report = await sweepHostedAppShapes(prismaWith([row(`intentic-sbx-a`)]), config, logger);
        expect(deleted).toEqual([]);
        expect(report.foreignMachines).toEqual([`intentic-sbx-a/m-theirs`, `intentic-sbx-a/m-nobody`]);
    });

    it(`leaves a machine made minutes ago: a provision or an adoption may be making it right now`, async () => {
        const deleted = stubApps({ "intentic-sbx-a": { machines: [machine(`m-row`, INSTANCE), machine(`m-new`, INSTANCE, 2)] } });
        await sweepHostedAppShapes(prismaWith([row(`intentic-sbx-a`)]), config, logger);
        expect(deleted).toEqual([]);
    });

    // The row may be the stale half: the health sweep's machine read settles that before anything here acts.
    it(`destroys nothing in an app whose row names a machine the provider does not list`, async () => {
        const deleted = stubApps({ "intentic-sbx-a": { machines: [machine(`m-other`, INSTANCE)] } });
        const report = await sweepHostedAppShapes(prismaWith([row(`intentic-sbx-a`)]), config, logger);
        expect(deleted).toEqual([]);
        expect(report.rowMachineMissing).toEqual([`intentic-sbx-a`]);
    });

    it(`does not read an app mid-change: a build or a move may be making its next machine`, async () => {
        const deleted = stubApps({ "intentic-sbx-a": { machines: [machine(`m-row`, INSTANCE), machine(`m-next`, INSTANCE)] } });
        const report = await sweepHostedAppShapes(prismaWith([row(`intentic-sbx-a`, { migratingId: `mig1` })]), config, logger);
        expect(deleted).toEqual([]);
        expect(report.waiting).toBe(1);
    });

    it(`destroys no more than its cap in one pass, and defers the rest`, async () => {
        const apps = Object.fromEntries(
            Array.from({ length: 12 }, (_, index) => [
                `intentic-sbx-k${index}z`,
                { machines: [machine(`m-row`, INSTANCE), machine(`m-stray`, INSTANCE)] },
            ]),
        );
        const deleted = stubApps(apps);
        const report = await sweepHostedAppShapes(prismaWith(Object.keys(apps).map((app) => row(app))), config, logger);
        expect(deleted).toHaveLength(APP_SHAPE_DESTROYS_PER_PASS);
        expect(report.deferred).toHaveLength(12 - APP_SHAPE_DESTROYS_PER_PASS);
    });

    it(`counts an app the provider will not list as waiting, and carries on with the rest`, async () => {
        const deleted = stubApps({ "intentic-sbx-b": { machines: [machine(`m-row`, INSTANCE), machine(`m-stray`, INSTANCE)] } });
        const report = await sweepHostedAppShapes(prismaWith([row(`intentic-sbx-a`), row(`intentic-sbx-b`)]), config, logger);
        expect(report.waiting).toBe(1);
        expect(deleted).toEqual([`intentic-sbx-b/machines/m-stray`]);
    });
});
