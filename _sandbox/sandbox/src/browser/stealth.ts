import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { BrowserFingerprint } from "./fingerprint.js";
import { statePath } from "../workspace/state-paths.js";

/* The init script, run in every page before its own scripts. It closes the gap between what a browser on a
 * GPU-less server in a container reports and what the same browser on somebody's desk reports.
 *
 * Headed full Chromium under Xvfb already carries a real user agent, a real `window.chrome` and a real plugin
 * list, so this is a short list rather than a framework: the residual tells are the GPU (Xvfb has none, so
 * Chromium falls back to SwiftShader, which no desktop reports), the core count and memory of a server, and
 * the automation flag. The values come from fingerprint.ts, which derives ONE STABLE DEVICE per profile owner
 * from a per-sandbox secret. That is the whole difference from the hand-written constants this replaces: those
 * were identical in every install of this product, which made them a signature for it.
 *
 * Kept small and hand-written on purpose (no puppeteer-extra dependency). Every patch here has to be one a real
 * machine could produce; a lie that no hardware could tell is worse than the truth, because detectors weight
 * internal contradictions above unusual values. That is why the old `navigator.plugins = [1,2,3,4,5]` line is
 * gone: a plugin array of bare integers is not a shape any browser has ever returned, and headed Chromium
 * ships a real PDF viewer entry anyway, so the branch was only ever able to make things worse.
 *
 * Used by both launch paths, which SHARE a profile and must therefore agree: inline via `addInitScript` in the
 * owner's own login window, and on disk for @playwright/mcp's `--init-script`. */
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

// One script per profile owner, because one device per profile owner. The name carries the owner for the same
// reason the profile directory does: a shared file would hand every browser the first one's machine.
const stealthScriptPath = (root: string, owner: string): string => statePath(root, ".intentic/local/browser/", `${owner}.stealth.js`);

// Write the owner's script to disk (idempotent, rewritten every launch so a change to the derivation lands
// without anyone clearing state) so @playwright/mcp can load it via `--init-script`; returns the path.
export const ensureStealthScript = async (root: string, owner: string, fingerprint: BrowserFingerprint): Promise<string> => {
    const path = stealthScriptPath(root, owner);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, stealthInit(fingerprint), { mode: 0o600 });
    return path;
};
