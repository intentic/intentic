import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

// A minimal anti-detection init script, run in every page before its own scripts. Headed full Chromium under
// Xvfb already looks like a real browser (real window.chrome, plugins, normal UA); this patches the residual
// tells a GPU-less server still leaks — chiefly WebGL reporting SwiftShader, plus a belt-and-braces webdriver /
// languages fix. Kept tiny and hand-written (no puppeteer-extra dep). Used inline by the login context
// (addInitScript) and written to disk for @playwright/mcp's --init-script.
export const STEALTH_INIT = `(() => {
  try { Object.defineProperty(navigator, 'webdriver', { get: () => undefined }); } catch {}
  // WebGL vendor/renderer → a common real GPU (Xvfb has no GPU, so Chromium reports SwiftShader — a headless/VM tell).
  const patchGL = (proto) => {
    if (!proto) return;
    const getParameter = proto.getParameter;
    proto.getParameter = function (param) {
      if (param === 37445) return 'Intel Inc.';                 // UNMASKED_VENDOR_WEBGL
      if (param === 37446) return 'Intel Iris OpenGL Engine';   // UNMASKED_RENDERER_WEBGL
      return getParameter.call(this, param);
    };
  };
  try { patchGL(window.WebGLRenderingContext && WebGLRenderingContext.prototype); } catch {}
  try { patchGL(window.WebGL2RenderingContext && WebGL2RenderingContext.prototype); } catch {}
  try { Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] }); } catch {}
  try { if (navigator.plugins && navigator.plugins.length === 0) Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] }); } catch {}
  try { if (!window.chrome) window.chrome = { runtime: {} }; } catch {}
})();
`;

const stealthScriptPath = (root: string): string => join(root, ".intentic", "browser", "stealth.js");

// Write the stealth script to disk (idempotent) so @playwright/mcp can load it via --init-script; returns the path.
export const ensureStealthScript = async (root: string): Promise<string> => {
    const path = stealthScriptPath(root);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, STEALTH_INIT);
    return path;
};
