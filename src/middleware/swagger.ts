import { createHmac, timingSafeEqual } from "crypto";
import { getJwtSecret, getTurnstileConfig } from "../services/auth";

// Swagger UI lives at GET /swagger and its spec at GET /swagger/json (both registered by
// @elysiajs/swagger). Both stay reachable (public) but their content is gated: a visitor
// needs either a valid admin `session` cookie or the `swagger_unlock` cookie issued by
// POST /swagger/unlock after the master PIN is verified.

export const SWAGGER_UNLOCK_COOKIE = "swagger_unlock";
const UNLOCK_TTL_SECONDS = 12 * 60 * 60; // unlock stays valid for 12 hours

const b64u = (input: string | Buffer) => Buffer.from(input).toString("base64url");

function hmac(secret: string, data: string): Buffer {
  return createHmac("sha256", secret).update(data).digest();
}

function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      return decodeURIComponent(part.slice(eq + 1).trim());
    }
  }
  return undefined;
}

// Minimal HS256 verify (signature + expiry). Same secret as the admin session JWT,
// but no Elysia jwt plugin needed here, so it cannot collide with middleware/auth.ts.
function verifyToken(token: string | undefined, secret: string): Record<string, any> | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const head = parts[0];
  const body = parts[1];
  const sig = parts[2];
  if (!head || !body || !sig) return null;

  const expected = hmac(secret, `${head}.${body}`);
  let given: Buffer;
  try {
    given = Buffer.from(sig, "base64url");
  } catch (e) {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (payload && typeof payload.exp === "number" && payload.exp <= Math.floor(Date.now() / 1000)) {
      return null; // expired
    }
    return payload;
  } catch (e) {
    return null;
  }
}

export function signSwaggerUnlockToken(): string {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64u(JSON.stringify({ role: "swagger", iat: now, exp: now + UNLOCK_TTL_SECONDS }));
  return `${head}.${body}.${b64u(hmac(getJwtSecret(), `${head}.${body}`))}`;
}

/** Admin UI session OR a previously issued swagger unlock cookie. */
export function hasSwaggerAccess(request: Request): boolean {
  const secret = getJwtSecret();
  const session = verifyToken(readCookie(request, "session"), secret);
  if (session && session.role === "admin") return true;
  const unlock = verifyToken(readCookie(request, SWAGGER_UNLOCK_COOKIE), secret);
  return Boolean(unlock && unlock.role === "swagger");
}

export function swaggerUnlockCookieHeader(): string {
  return `${SWAGGER_UNLOCK_COOKIE}=${signSwaggerUnlockToken()}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${UNLOCK_TTL_SECONDS}`;
}

// --- Progressive failure delay for POST /swagger/unlock -------------------------
// 1st failure -> 5s, 2nd -> 15s, 3rd -> 20s, then +5s per extra failure, capped at 60s.
// Counters reset after 5 minutes without a failure, or on a successful unlock.
const UNLOCK_RESET_MS = 5 * 60 * 1000;
const MAX_COOLDOWN_SECONDS = 60;
const unlockFailures = new Map<string, { count: number; lastAt: number }>();

function clientKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0];
    if (first && first.trim()) return first.trim();
  }
  const realIp = request.headers.get("x-real-ip");
  if (realIp && realIp.trim()) return realIp.trim();
  return "local";
}

/** Seconds the caller must wait after `fails` consecutive failures. */
export function unlockCooldownSeconds(fails: number): number {
  if (fails <= 0) return 0;
  if (fails === 1) return 5;
  if (fails === 2) return 15;
  return Math.min(20 + (fails - 3) * 5, MAX_COOLDOWN_SECONDS);
}

function currentFailure(request: Request): { count: number; lastAt: number } | undefined {
  const key = clientKey(request);
  const entry = unlockFailures.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.lastAt > UNLOCK_RESET_MS) {
    unlockFailures.delete(key);
    return undefined;
  }
  return entry;
}

/** Sleeps out any outstanding cooldown; returns the ms actually waited (0 = no wait). */
export async function swaggerUnlockDelay(request: Request): Promise<number> {
  const entry = currentFailure(request);
  if (!entry || entry.count <= 0) return 0;
  const waitMs = entry.lastAt + unlockCooldownSeconds(entry.count) * 1000 - Date.now();
  if (waitMs <= 0) return 0;
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  return waitMs;
}

export function recordSwaggerFailure(request: Request): void {
  const key = clientKey(request);
  const now = Date.now();
  const entry = unlockFailures.get(key);
  if (!entry || now - entry.lastAt > UNLOCK_RESET_MS) {
    unlockFailures.set(key, { count: 1, lastAt: now });
    return;
  }
  entry.count = Math.min(entry.count + 1, 100);
  entry.lastAt = now;
}

export function recordSwaggerSuccess(request: Request): void {
  unlockFailures.delete(clientKey(request));
}

const escapeAttr = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/"/g, "&quot;");

/** Shown at GET /swagger when the visitor has no session and no unlock cookie. */
export function renderSwaggerLockPage(): string {
  // Same Turnstile setup as the admin login screen: rendered only when configured.
  const { siteKey, enabled } = getTurnstileConfig();
  const turnstileWidget = enabled
    ? `<div class="cf-turnstile" data-sitekey="${escapeAttr(siteKey)}" data-size="flexible" data-callback="onTurnstileSuccess" data-expired-callback="onTurnstileExpired"></div>
  <script>
    window.__swaggerTurnstileToken = "";
    function onTurnstileSuccess(token) { window.__swaggerTurnstileToken = token; }
    function onTurnstileExpired() { window.__swaggerTurnstileToken = ""; }
  </script>
  <script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>`
    : "";
  return `<!doctype html>
<html lang="id">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Swagger Terkunci — Rizuu-Router</title>
<style>
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         background: #09090b; color: #e4e4e7;
         font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  .card { background: #18181b; border: 1px solid #27272a; border-radius: 12px; padding: 1.75rem;
          width: 320px; box-shadow: 0 10px 25px rgba(0,0,0,.5); }
  h1 { font-size: 15px; margin: 0 0 .35rem; }
  p { font-size: 12.5px; color: #a1a1aa; margin: 0 0 1.1rem; line-height: 1.5; }
  input { width: 100%; box-sizing: border-box; background: #09090b; border: 1px solid #3f3f46;
          color: #f4f4f5; border-radius: 8px; padding: .55rem .7rem; font-size: 13px; outline: none; }
  input:focus { border-color: #3b82f6; }
  button { width: 100%; margin-top: .75rem; background: linear-gradient(180deg,#3b82f6,#2563eb);
           border: 1px solid #1d4ed8; color: #fff; font-weight: 600; font-size: 13px;
           border-radius: 8px; padding: .55rem; cursor: pointer; }
  button:disabled { opacity: .6; cursor: default; }
  .err { color: #f87171; font-size: 12px; margin-top: .6rem; min-height: 1em; }
</style>
</head>
<body>
<div class="card">
  <h1>Swagger terkunci</h1>
  <p>Masukkan password (Master PIN) untuk membuka dokumentasi API, atau login di halaman admin untuk membukanya otomatis.</p>
  <form id="unlock">
    <input id="password" type="password" inputmode="numeric" autocomplete="current-password" placeholder="Master PIN" autofocus />
    ${turnstileWidget}
    <button id="submit" type="submit">Buka dokumentasi</button>
    <div class="err" id="error"></div>
  </form>
</div>
<script>
  var form = document.getElementById("unlock");
  var errorBox = document.getElementById("error");
  var submit = document.getElementById("submit");
  form.addEventListener("submit", async function (e) {
    e.preventDefault();
    errorBox.textContent = "";
    submit.disabled = true;
    try {
      var widget = document.querySelector(".cf-turnstile");
      var token = window.__swaggerTurnstileToken || "";
      if (widget && !token) {
        errorBox.textContent = "Selesaikan verifikasi Turnstile terlebih dahulu.";
        return;
      }
      var res = await fetch("/swagger/unlock", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          password: document.getElementById("password").value,
          turnstileToken: token
        })
      });
      if (res.ok) { location.reload(); return; }
      var data = await res.json().catch(function () { return null; });
      errorBox.textContent = (data && ((data.error && data.error.message) || data.message)) || "Gagal membuka dokumentasi.";
    } catch (err) {
      errorBox.textContent = "Gagal terhubung ke server.";
    } finally {
      submit.disabled = false;
    }
  });
</script>
</body>
</html>
`;
}
