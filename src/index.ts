import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { swagger } from "@elysiajs/swagger";
import { initDatabase } from "./db";
import { authRoutes } from "./routes/auth";
import { keysRoutes } from "./routes/keys";
import { routerApiKeysRoutes } from "./routes/api-keys";
import { upstreamRoutes } from "./routes/upstreams";
import { telemetryRoutes } from "./routes/telemetry";
import { adminRoutes } from "./routes/admin";
import { proxyRoutes } from "./routes/proxy";
import { apiProvidersRoutes } from "./routes/api-providers";
import { existsSync, watch } from "fs";
import { join } from "path";
import { webHandler, htmlTemplate, bundleFrontend } from "./web/handler";
import { hasSwaggerAccess, swaggerUnlockCookieHeader, renderSwaggerLockPage, swaggerUnlockDelay, recordSwaggerFailure, recordSwaggerSuccess } from "./middleware/swagger";
import { verifyPin, getTurnstileConfig, verifyTurnstileToken } from "./services/auth";

// Initialize database schema and default PIN
await initDatabase();

// Pre-load frontend assets on startup
// - PRODUCTION: reads pre-built dist-web/ files from disk (fast, no memory spike)
// - DEVELOPMENT: runs Bun.build() in the background (same as before)
if (process.env.NODE_ENV !== "production") {
  bundleFrontend().catch((err) => console.error("[Frontend] Bundle preheat error:", err));
} else {
  bundleFrontend().catch((err) => console.error("[Frontend] Failed to load pre-built assets:", err));
}

// Watch .env for changes in both development and production
const envPath = join(process.cwd(), ".env");
if (existsSync(envPath)) {
  let debounceTimer: any = null;
  watch(envPath, (eventType) => {
    if (eventType === "change" || eventType === "rename") {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        console.log("\x1b[33m%s\x1b[0m", "⚙️  [.env] Configuration change detected! Reloading process...");
        process.exit(0);
      }, 300);
    }
  });
}

const port = parseInt(process.env.PORT || "3000", 10);
const host = process.env.HOST || "0.0.0.0";

const app = new Elysia()
  .use(
    cors({
      origin: true,
      credentials: true,
      allowedHeaders: ["Content-Type", "Authorization", "x-api-key", "anthropic-version", "anthropic-beta"],
    })
  )
  // Swagger gate: page & spec stay reachable (public), but the content is locked until the
  // visitor has an admin session cookie or the swagger_unlock cookie from POST /swagger/unlock.
  // Registered BEFORE .use(swagger()) so the plugin's routes inherit this hook.
  .onBeforeHandle(async ({ request, set }) => {
    const pathname = new URL(request.url).pathname;
    if (pathname !== "/swagger" && pathname !== "/swagger/json") return;
    if (hasSwaggerAccess(request)) return;
    if (pathname === "/swagger") {
      return new Response(renderSwaggerLockPage(), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }
    set.status = 401;
    return {
      error: {
        message: "Akses ditolak: Token tidak disediakan",
        type: "invalid_request_error",
        code: "invalid_api_key",
      },
    };
  })
  .use(
    swagger({
      path: "/swagger",
      documentation: {
        info: {
          title: "Rizuu-Router API Gateway",
          version: "1.0.0",
          description:
            "Ultra-low latency AI Gateway & Router for OpenAI and Anthropic compatible endpoints with real-time stream passthrough and token telemetry.",
        },
        tags: [
          { name: "Proxy", description: "AI proxy endpoints (OpenAI & Anthropic)" },
          { name: "Auth", description: "Authentication & PIN management" },
          { name: "Keys", description: "Client access keys management" },
          { name: "Router Keys", description: "Router integration API keys management" },
          { name: "Upstreams", description: "Upstream provider keys management" },
          { name: "API Providers", description: "BandelBanget and external API providers management" },
          { name: "Telemetry", description: "Token usage and latency metrics" },
          { name: "Admin", description: "Database backup, restore, and system metrics" },
        ],
      },
    })
  )
  // Swagger unlock: verify the master PIN, then hand out the HTTP-only unlock cookie
  .post("/swagger/unlock", async ({ request, set, headers }) => {
    // Progressive delay after failed attempts: 5s, 15s, 20s, then +5s each (capped at 60s).
    const waitedMs = await swaggerUnlockDelay(request);
    if (waitedMs > 0) set.headers["X-Unlock-Wait-Ms"] = String(waitedMs);
    let password = "";
    let turnstileToken = "";
    try {
      const body = (await request.json()) as { password?: unknown; turnstileToken?: unknown };
      password = typeof body?.password === "string" ? body.password : "";
      turnstileToken = typeof body?.turnstileToken === "string" ? body.turnstileToken : "";
    } catch (e) {
      password = "";
      turnstileToken = "";
    }

    // Cloudflare Turnstile — same gate as the admin login screen, checked before the PIN.
    const { enabled } = getTurnstileConfig();
    if (enabled) {
      const clientIp =
        headers["cf-connecting-ip"] ||
        (typeof headers["x-forwarded-for"] === "string"
          ? headers["x-forwarded-for"].split(",")[0]?.trim()
          : undefined) ||
        headers["x-real-ip"];
      const turnstileCheck = await verifyTurnstileToken(turnstileToken, clientIp);
      if (!turnstileCheck.success) {
        recordSwaggerFailure(request);
        set.status = 403;
        return { ok: false, error: { message: turnstileCheck.error || "Turnstile verification failed" } };
      }
    }

    const unlocked = password ? await verifyPin(password) : false;
    if (!unlocked) {
      recordSwaggerFailure(request);
      set.status = 401;
      return { ok: false, error: { message: "Password salah." } };
    }
    recordSwaggerSuccess(request);
    set.headers["Set-Cookie"] = swaggerUnlockCookieHeader();
    return { ok: true };
  })
  // Health & Info Endpoint
  .get("/health", () => ({ status: "ok", timestamp: Date.now() }))
  // Register Route Modules
  .use(authRoutes)
  .use(keysRoutes)
  .use(routerApiKeysRoutes)
  .use(upstreamRoutes)
  .use(apiProvidersRoutes)
  .use(telemetryRoutes)
  .use(adminRoutes)
  .use(proxyRoutes)
  // Dynamic Web Frontend Handler
  .use(webHandler)
  // Catch-all SPA route: serves dynamic HTML template (no dist needed)
  .get("*", ({ set }) => {
    set.headers["Content-Type"] = "text/html; charset=utf-8";
    return htmlTemplate;
  });

app.listen({ port, hostname: host }, () => {
  console.log(`🐱 Rizuu-Router AI Gateway is running at http://${host}:${port}`);
  console.log(`📖 Interactive OpenAPI Docs at http://${host}:${port}/swagger`);
});

export type App = typeof app;
