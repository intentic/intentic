import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import type { GitRunner } from "@intentic/base/git";
import { fileDismissalsStore } from "./dismissals-store.js";
import { MOVED_EXTENSIONS } from "./moved-extensions.js";
import { capabilityRecommendations } from "./recommend.js";

// e-urzad and prawo left the image (2026-11-23), and the bug intake left the daemon for the issues extension
// (2026-11-26): a sandbox that used one is offered its repository's install on the Extension tile, once, and a sandbox
// that never did is told nothing.

const noRemotes: GitRunner = async () => ({ stdout: "", stderr: "" });

const sandbox = async (files: Readonly<Record<string, string>> = {}): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "moved-extensions-"));
    for (const [file, content] of Object.entries(files)) {
        await mkdir(join(root, file, ".."), { recursive: true });
        await writeFile(join(root, file), content);
    }
    return root;
};

const movedOf = (id: string) => {
    const found = MOVED_EXTENSIONS.find((moved) => moved.id === id);
    if (found === undefined) {
        throw new Error(`${id} is not pinned`);
    }
    return found;
};
const eUrzad = movedOf("intentic.e-urzad");
const prawo = movedOf("intentic.prawo");
const ezdCard: Capability = { id: "office-ezd", kind: "cli", config: { provider: "ezd-rp", apiUrl: "https://ezd.example.test" } };
const installed = (url: string): Capability => ({ id: "ext", kind: "extension", config: { url, ref: "a".repeat(40) } });
const offered = async (root: string, active: readonly Capability[], dismissed = fileDismissalsStore(join(root, "dismissals.json"))) =>
    capabilityRecommendations(root, active, await dismissed.list(), noRemotes);

test("the pinned repositories are full commits on the intentic organisation", () => {
    expect(MOVED_EXTENSIONS.map((moved) => moved.id)).toEqual(["intentic.e-urzad", "intentic.prawo", "intentic.issues"]);
    for (const moved of MOVED_EXTENSIONS) {
        expect(moved.url).toMatch(/^https:\/\/github\.com\/intentic\/extension-[a-z-]+$/);
        expect(moved.ref).toMatch(/^[0-9a-f]{40}$/);
    }
});

test("a sandbox that never used either is offered nothing", async () => {
    expect(await offered(await sandbox(), [])).toEqual([]);
});

test("an EZD RP card left behind offers e-Urząd's install, prefilled with its repository and commit", async () => {
    expect(await offered(await sandbox(), [ezdCard])).toEqual([
        {
            entry: "extension",
            evidence: "capability office-ezd (ezd-rp)",
            reason: "e-Urząd moved to its own repository",
            prefill: { url: eUrzad.url, ref: eUrzad.ref },
        },
    ]);
});

test("what it wrote counts as use: its records, its state, its cache", async () => {
    const records = await sandbox({ [`${STATE_DIR}/records/e-urzad/office-ed/delivery-1/meta.json`]: "{}" });
    expect((await offered(records, [])).map((offer) => offer.evidence)).toEqual([`${STATE_DIR}/records/e-urzad/`]);
    const cache = await sandbox({ [`${STATE_DIR}/local/cache/prawo/acts.json`]: "{}" });
    expect((await offered(cache, [])).map((offer) => offer.prefill)).toEqual([{ url: prawo.url, ref: prawo.ref }]);
    const state = await sandbox({ [`${STATE_DIR}/local/runtime/extensions/intentic.prawo/x.json`]: "{}" });
    expect((await offered(state, [])).map((offer) => offer.evidence)).toEqual([`${STATE_DIR}/local/runtime/extensions/intentic.prawo/`]);
});

test("an empty records directory, and a switch nobody touched, are not use", async () => {
    const root = await sandbox({ [`${STATE_DIR}/config/extension-enablement.json`]: JSON.stringify({ "intentic.e-urzad": false }) });
    await mkdir(join(root, `${STATE_DIR}/records/e-urzad`), { recursive: true });
    expect(await offered(root, [])).toEqual([]);
});

test("the owner's own switch or settings for it count", async () => {
    const switched = await sandbox({ [`${STATE_DIR}/config/extension-enablement.json`]: JSON.stringify({ "intentic.prawo": true }) });
    expect((await offered(switched, [])).map((offer) => offer.evidence)).toEqual(["intentic.prawo switched on in extension-enablement.json"]);
    const configured = await sandbox({ [`${STATE_DIR}/config/extension-settings.json`]: JSON.stringify({ "intentic.e-urzad": { lang: "pl" } }) });
    expect((await offered(configured, [])).map((offer) => offer.evidence)).toEqual(["intentic.e-urzad settings in extension-settings.json"]);
});

test("installing it from its repository ends the offer, whatever commit it took", async () => {
    const root = await sandbox();
    expect(await offered(root, [ezdCard, installed(`${eUrzad.url}.git`)])).toEqual([]);
    expect(await offered(root, [ezdCard, installed("https://github.com/someone/else")])).toHaveLength(1);
});

test("both used: one offer at a time, and declining each, through the real dismissal store, ends both for good", async () => {
    const root = await sandbox({ [`${STATE_DIR}/local/cache/prawo/acts.json`]: "{}" });
    const store = fileDismissalsStore(join(root, "dismissals.json"));
    const first = await offered(root, [ezdCard], store);
    expect(first.map((offer) => offer.reason)).toEqual(["e-Urząd moved to its own repository"]);
    await store.dismiss({ entry: "extension", evidence: first[0]!.evidence });
    const second = await offered(root, [ezdCard], store);
    expect(second.map((offer) => offer.reason)).toEqual(["Prawo moved to its own repository"]);
    // The store keeps one row per entry, so this replaces the first decline: e-Urząd must not come back with it.
    await store.dismiss({ entry: "extension", evidence: second[0]!.evidence });
    expect(await offered(root, [ezdCard], store)).toEqual([]);
    expect(await offered(root, [ezdCard], store)).toEqual([]);
});

test("installing the first brings the second up next", async () => {
    const root = await sandbox({ [`${STATE_DIR}/local/cache/prawo/acts.json`]: "{}" });
    expect((await offered(root, [ezdCard, installed(eUrzad.url)])).map((offer) => offer.prefill)).toEqual([{ url: prawo.url, ref: prawo.ref }]);
});

// The intake was the daemon's, so a sandbox used it without ever installing the extension: its inbox, or an automation on
// the intake's source, is the sign, and nothing else of the daemon's is.
test("a sandbox that used the daemon's bug intake is offered the issues extension, by its inbox or by an intake", async () => {
    const issues = movedOf("intentic.issues");
    const inbox = await sandbox({ [`${STATE_DIR}/records/issues/4f3a1b2c9d8e7f60.json`]: "{}" });
    expect(await offered(inbox, [])).toEqual([
        {
            entry: "extension",
            evidence: `${STATE_DIR}/records/issues/`,
            reason: "Bug reports moved from the sandbox into the Issues extension",
            prefill: { url: issues.url, ref: issues.ref },
        },
    ]);
    const intake = await sandbox({
        [`${STATE_DIR}/config/automations.json`]: JSON.stringify([
            { id: "chat", trigger: { kind: "listener", provider: "webchat" } },
            { id: "bugs", trigger: { kind: "listener", provider: "issues", allowedOrigins: ["https://shop.example"] } },
        ]),
    });
    expect((await offered(intake, [])).map((offer) => offer.evidence)).toEqual(["an automation on the issues source in automations.json"]);
    const chatOnly = await sandbox({ [`${STATE_DIR}/config/automations.json`]: JSON.stringify([{ id: "chat", trigger: { kind: "listener", provider: "webchat" } }]) });
    expect(await offered(chatOnly, [])).toEqual([]);
    expect(await offered(inbox, [installed(`${issues.url}.git`)])).toEqual([]);
});
