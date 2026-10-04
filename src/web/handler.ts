import { Elysia } from "elysia";
import { join } from "path";
import { existsSync } from "fs";

// ---------------------------------------------------------------------------
// Frontend asset serving
//
// PRODUCTION  — Assets are pre-built once by `bun run build:web` and written
//               to dist-web/main.js + dist-web/main.css.  They are read from
//               disk on the first request and cached in memory as Uint8Arrays.
//               Bun.build() is NEVER called at runtime → eliminates the
//               150-300 MB startup spike that would otherwise OOM a 1 GB host.
//
// DEVELOPMENT — Bun.build() is called on the first request (and again if the
//               last build is > 1 s old), so hot-reload still works exactly
//               as before.
// ---------------------------------------------------------------------------

const IS_PROD = process.env.NODE_ENV === "production";

// dist-web/ lives at the project root (next to src/)
const DIST_DIR = join(import.meta.dir, "../../dist-web");
const DIST_JS  = join(DIST_DIR, "main.js");
const DIST_CSS = join(DIST_DIR, "main.css");

// In-memory cache of the compiled assets (both dev and prod paths use this)
let cachedJs: Uint8Array | null = null;
let cachedCss: Uint8Array | null = null;
let lastBuildTime = 0;

// ---------------------------------------------------------------------------
// Load pre-built assets from dist-web/ (production only)
// ---------------------------------------------------------------------------
async function loadPrebuildAssets(): Promise<{ js: Uint8Array | null; css: Uint8Array | null }> {
  if (!cachedJs && existsSync(DIST_JS)) {
    cachedJs = new Uint8Array(await Bun.file(DIST_JS).arrayBuffer());
  }
  if (!cachedCss && existsSync(DIST_CSS)) {
    cachedCss = new Uint8Array(await Bun.file(DIST_CSS).arrayBuffer());
  }
  return { js: cachedJs, css: cachedCss };
}

// ---------------------------------------------------------------------------
// Runtime build (development only)
// ---------------------------------------------------------------------------
async function runtimeBuild(force = false): Promise<{ js: Uint8Array | null; css: Uint8Array | null }> {
  const now = Date.now();
  if (!force && cachedJs && cachedCss && now - lastBuildTime < 1000) {
    return { js: cachedJs, css: cachedCss };
  }

  try {
    const entryPath = join(import.meta.dir, "main.tsx");
    const result = await Bun.build({
      entrypoints: [entryPath],
      target: "browser",
      minify: false,
      sourcemap: "inline",
      define: {
        "process.env.NODE_ENV": JSON.stringify("development"),
      },
    });

    if (!result.success) {
      console.error("[Web Bundler] Build failed:", result.logs);
      if (cachedJs && cachedCss) return { js: cachedJs, css: cachedCss };
      throw new Error(`Frontend bundle failed: ${result.logs.map((l) => l.message).join("\n")}`);
    }

    for (const output of result.outputs) {
      if (output.kind === "entry-point") {
        cachedJs = new Uint8Array(await output.arrayBuffer());
      } else if (output.kind === "asset" && output.path.endsWith(".css")) {
        cachedCss = new Uint8Array(await output.arrayBuffer());
      }
    }

    lastBuildTime = now;
  } catch (err) {
    console.error("[Web Bundler] Error during build:", err);
  }

  return { js: cachedJs, css: cachedCss };
}

// ---------------------------------------------------------------------------
// Public entry-point (called from src/index.ts preheat)
// ---------------------------------------------------------------------------
export async function bundleFrontend(force = false): Promise<{ js: Uint8Array | null; css: Uint8Array | null }> {
  if (IS_PROD) {
    // Production: just read from dist-web/, never build at runtime
    return loadPrebuildAssets();
  }
  return runtimeBuild(force);
}

export const htmlTemplate = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/public/favicon.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Rizuu-Router | High Performance AI Gateway</title>
    <link rel="stylesheet" href="/_web/main.css" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/_web/main.js"></script>
  </body>
</html>`;

export const webHandler = new Elysia()
  // Bundled JS route
  .get("/_web/main.js", async ({ set }) => {
    const { js } = await bundleFrontend();
    if (!js) {
      set.status = 500;
      return "Bundle error";
    }
    const cacheControl = IS_PROD ? "public, max-age=86400" : "no-cache";
    return new Response(js as unknown as BodyInit, {
      headers: {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": cacheControl,
      },
    });
  })
  // Bundled CSS route
  .get("/_web/main.css", async ({ set }) => {
    const { css } = await bundleFrontend();
    if (!css) {
      set.status = 500;
      return "Bundle error";
    }
    const cacheControl = IS_PROD ? "public, max-age=86400" : "no-cache";
    return new Response(css as unknown as BodyInit, {
      headers: {
        "Content-Type": "text/css; charset=utf-8",
        "Cache-Control": cacheControl,
      },
    });
  })
  // Serve static public assets from src/web/public
  .get("/public/*", ({ params, set }) => {
    const publicPath = (params as Record<string, string>)["*"] || "";
    const filePath = join(import.meta.dir, "public", publicPath);
    if (publicPath && existsSync(filePath)) {
      return Bun.file(filePath);
    }
    set.status = 404;
    return "Not found";
  })
  // Fallback for favicon
  .get("/favicon.svg", () => {
    const filePath = join(import.meta.dir, "public/favicon.svg");
    if (existsSync(filePath)) {
      return Bun.file(filePath);
    }
    return new Response(null, { status: 404 });
  });
