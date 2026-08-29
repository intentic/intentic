import { expect, test } from "vitest";
import {
    labelHostname,
    panelFromHost,
    portHostname,
    portLabel,
    portSlotFromHost,
    portUrl,
    previewHostname,
    previewLabel,
    previewUrl,
    sandboxHostname,
    sandboxIdFromUrl,
    syncFolder,
} from "./hostnames.js";

const ID = "abc123def456";

test("preview and port hostnames round-trip through their Host-header parsers", () => {
    expect(panelFromHost(`${previewHostname("shop--web", ID, "example.com")}:443`, ID)).toBe("shop--web");
    expect(portSlotFromHost(`${portHostname("a", ID, "example.com")}:443`, ID)).toBe("a");
    // The id-less form (loopback tests / provider-deployed workspaces fronting the proxy themselves).
    expect(panelFromHost("preview-app.example.com", undefined)).toBe("app");
    expect(portSlotFromHost("port-a.example.com", undefined)).toBe("a");
});

test("the two schemes never bleed into each other, and stray/wrong-id hosts parse to nothing", () => {
    expect(portSlotFromHost(`preview-app-${ID}.example.com`, ID)).toBeUndefined();
    expect(panelFromHost(`port-a-${ID}.example.com`, ID)).toBeUndefined();
    expect(panelFromHost("app.example.com", ID)).toBeUndefined();
    expect(panelFromHost(`preview-app-000000000000.example.com`, ID)).toBeUndefined();
    expect(portSlotFromHost(`port-a-000000000000.example.com`, ID)).toBeUndefined();
    expect(panelFromHost(undefined, ID)).toBeUndefined();
});

test("labels are the mintable unit: hostname = <label>-<id>.<zone> for both schemes", () => {
    expect(labelHostname(previewLabel("app"), ID, "example.com")).toBe(previewHostname("app", ID, "example.com"));
    expect(labelHostname(portLabel("a"), ID, "example.com")).toBe(portHostname("a", ID, "example.com"));
});

test("the local sync folder carries the very id the sandbox's URL does", () => {
    const url = `https://${sandboxHostname(ID, "intentic.dev")}`;
    expect(sandboxIdFromUrl(url)).toBe(ID);
    expect(syncFolder("Radarsu Local", url)).toBe(`~/intentic/radarsu-local-${ID}`);
    // A bare host (no scheme) and a port are both accepted: the daemon/CLI and the browser pass different shapes.
    expect(sandboxIdFromUrl(`${sandboxHostname(ID, "intentic.dev")}:443`)).toBe(ID);
    // Own-Cloudflare: the owner's chosen subdomain IS the id, so the folder still matches what they browse to.
    expect(syncFolder("shop", "https://dev-box.example.com")).toBe("~/intentic/shop-dev-box");
});

test("sandbox ids that can't be read off a URL leave the folder named for the sandbox alone", () => {
    expect(sandboxIdFromUrl(undefined)).toBeUndefined();
    expect(sandboxIdFromUrl("")).toBeUndefined();
    expect(sandboxIdFromUrl("not a url")).toBeUndefined();
    expect(sandboxIdFromUrl("https://sandbox-.intentic.dev")).toBeUndefined();
    expect(syncFolder("My Repo", undefined)).toBe("~/intentic/my-repo");
    expect(syncFolder("", undefined)).toBe("~/intentic/sandbox");
});

test("preview/port URLs require both a zone and a sandbox id", () => {
    expect(previewUrl("app", "example.com", ID)).toBe(`https://preview-app-${ID}.example.com`);
    expect(portUrl("a", "example.com", ID)).toBe(`https://port-a-${ID}.example.com`);
    expect(portUrl("a", undefined, ID)).toBeUndefined();
    expect(portUrl("a", "", ID)).toBeUndefined();
    expect(portUrl("a", "example.com", undefined)).toBeUndefined();
});
