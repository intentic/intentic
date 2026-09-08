import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { BrowserFingerprint } from "./fingerprint.js";
import { statePath } from "../../workspace/layout/state-paths.js";

// Init script run before a page's own scripts; patches only the residual tells of a GPU-less container (WebGL
// vendor/renderer, hardwareConcurrency, deviceMemory, navigator.webdriver) using the per-owner device from
// fingerprint.ts.
// Hand-written, no puppeteer-extra: every patched value must be one a real machine could produce, since an impossible
// value is a stronger tell than an unusual one.
// Shared by both launch paths (the owner's own login window and @playwright/mcp), which use one profile and must agree.
export const stealthInit = (fingerprint: BrowserFingerprint): string => `(() => {
  const define = (target, prop, value) => {
    try { Object.defineProperty(target, prop, { get: () => value, configurable: true }); } catch {}
  };
  define(navigator, 'webdriver', undefined);
  // WebGL vendor/renderer. Xvfb has no GPU, so Chromium reports SwiftShader, which is a server tell no desktop
  // shares. The replacement is an ANGLE-formatted pair as Chromium on Linux actually spells it.
  const patchGL = (proto) => {
    if (!proto) return;
    const getParameter = proto.getParameter;
    proto.getParameter = function (param) {
      if (param === 37445) return ${JSON.stringify(fingerprint.webglVendor)};   // UNMASKED_VENDOR_WEBGL
      if (param === 37446) return ${JSON.stringify(fingerprint.webglRenderer)}; // UNMASKED_RENDERER_WEBGL
      return getParameter.call(this, param);
    };
    // getParameter is patched, and a page that reads its source sees native code either way: Chromium's own
    // toString is kept rather than the wrapper's, which would print the patch itself.
    try { proto.getParameter.toString = () => 'function getParameter() { [native code] }'; } catch {}
  };
  try { patchGL(window.WebGLRenderingContext && WebGLRenderingContext.prototype); } catch {}
  try { patchGL(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype); } catch {}
  // The container sees the HOST's cores, routinely 32 or 64; no laptop reports that. deviceMemory is capped at
  // 8 by the spec, so 8 is what every machine with 16 GiB or more says.
  define(navigator, 'hardwareConcurrency', ${String(fingerprint.hardwareConcurrency)});
  define(navigator, 'deviceMemory', ${String(fingerprint.deviceMemory)});
  // Matches the context's own locale (both come from the same fingerprint), so the header and the property
  // cannot contradict each other.
  define(navigator, 'languages', Object.freeze(${JSON.stringify(fingerprint.languages)}));
  try { if (!window.chrome) window.chrome = { runtime: {} }; } catch {}
})();
`;

// One script per profile owner, matching the profile dir; a shared file would leak one browser's device to all.
const stealthScriptPath = (root: string, owner: string): string => statePath(root, ".intentic/local/browser/", `${owner}.stealth.js`);

// Rewrites the owner's script to disk on every launch, so a derivation change lands without clearing state; returns the
// path for --init-script.
export const ensureStealthScript = async (root: string, owner: string, fingerprint: BrowserFingerprint): Promise<string> => {
    const path = stealthScriptPath(root, owner);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, stealthInit(fingerprint), { mode: 0o600 });
    return path;
};
