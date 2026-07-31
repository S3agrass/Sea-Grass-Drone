// Builds the directory Firebase actually serves for seagrassrobotics.com.
//
// One domain, two applications:
//   /          -> site/        the marketing pages (hand-written HTML)
//   /desktop/  -> dist/        the GCS, exactly as `vite build` produced it
//
// This assembles into hosting/ rather than building the GCS straight into
// dist/desktop, because electron/main.cjs loads ../dist/index.html — repointing
// vite's outDir would silently break the desktop app. dist stays where every
// other consumer expects it and gets copied from.
//
// The GCS needs no adjusting to live under a sub-path: vite is configured with
// base: './' (relative asset URLs) and App.jsx uses HashRouter, so routes are
// /desktop/#/fleet and no server-side SPA rewrite is involved.

import { cp, rm, mkdir, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const site = join(root, "site");
const out = join(root, "hosting");

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

if (!(await exists(dist))) {
  console.error("dist/ is missing — run `vite build` before assembling.");
  process.exit(1);
}

// Rebuilt from scratch every time: a stale file here is a file that keeps being
// served long after it left the source tree.
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

await cp(site, out, { recursive: true });
await cp(dist, join(out, "desktop"), { recursive: true });

console.log("hosting/ assembled — site at /, GCS at /desktop/");
