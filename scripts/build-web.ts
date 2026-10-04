/**
 * scripts/build-web.ts
 *
 * One-shot frontend pre-build script.
 * Run: bun run build:web
 *
 * Writes the minified React bundle to dist-web/main.js + dist-web/main.css.
 * In production the server reads these files from disk instead of calling
 * Bun.build() at runtime, eliminating the 150-300 MB startup memory spike.
 */

import { join } from "path";
import { mkdirSync } from "fs";

const root    = join(import.meta.dir, "..");
const outDir  = join(root, "dist-web");
const entry   = join(root, "src/web/main.tsx");

console.log("⚙️  Building frontend...");
console.log(`   Entry : ${entry}`);
console.log(`   Output: ${outDir}`);

mkdirSync(outDir, { recursive: true });

const result = await Bun.build({
  entrypoints: [entry],
  outdir: outDir,
  target: "browser",
  minify: true,
  sourcemap: "none",
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
});

if (!result.success) {
  console.error("❌  Frontend build FAILED:");
  for (const log of result.logs) {
    console.error(" ", log.message);
  }
  process.exit(1);
}

// Rename any .css artifact to main.css for deterministic serving
for (const output of result.outputs) {
  if (output.kind === "asset" && output.path.endsWith(".css")) {
    const destCss = join(outDir, "main.css");
    // Bun already wrote it; rename if needed
    const src = output.path;
    if (src !== destCss) {
      const data = await Bun.file(src).arrayBuffer();
      await Bun.write(destCss, data);
      // Don't delete the original; it's harmless and avoids ENOENT on some platforms
    }
  }
}

let totalSize = 0;
for (const output of result.outputs) {
  const sizeKb = ((await Bun.file(output.path).arrayBuffer()).byteLength / 1024).toFixed(1);
  console.log(`   ✓ ${output.path.replace(root, "").replace(/\\/g, "/")}  (${sizeKb} KB)`);
  totalSize += parseFloat(sizeKb);
}

console.log(`\n✅  Done. Total: ${totalSize.toFixed(1)} KB  →  dist-web/`);
console.log("   Start with: bun run start\n");
