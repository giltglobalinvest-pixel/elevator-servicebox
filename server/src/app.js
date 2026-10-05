// Elevator Servicebox · ERP-Proxy (Node/Hono port of the Val.town proxy)
// Routes, status codes and response bodies match the Val.town version so the
// frontend only needs a new base URL.
import { Hono } from "hono";
import { createSync, DEFAULT_AUFZUG_BASE_URL } from "./sync.js";

const TENANT_MAP = { aufzug: "1", aszendio: "4" };
const CACHE_TTL_MS = 60000;
const SESSION_SHORT = 8 * 60 * 60 * 1000;
const SESSION_LONG = 30 * 24 * 60 * 60 * 1000;
const SESSION_PREFIX = "esbx_session_";

const CORS_PREFLIGHT_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers": "authorization, content-type, x-erp-tenant, x-sync-secret",
  "access-control-allow-methods": "GET, POST, PATCH, PUT, DELETE, OPTIONS",
  "access-control-max-age": "86400",
};

function json(d, s = 200) {
  return new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
}

async function readJsonBody(req) {
  try { return await req.json(); } catch (_) { return {}; }
}

function genToken() {
  const a = new Uint8Array(32); crypto.getRandomValues(a);
  return Array.from(a).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * @param {object} opts
 * @param {(name: string) => string | undefined} opts.env  reads configuration (process.env in production)
 * @param {object} opts.blob  key/value store with getJSON/setJSON/delete/list (see store.js)
 */
export function createApp({ env, blob }) {
  const USER_CACHE = new Map();
  const { atReadAll, runSyncForFirma } = createSync({ env, blob });

  async function setSession(t, d) { await blob.setJSON(SESSION_PREFIX + t, d); }
  async function getSession(t) {
    let d; try { d = await blob.getJSON(SESSION_PREFIX + t); } catch (_) { return null; }
    if (!d) return null;
    if (d.expires && d.expires < Date.now()) { try { await blob.delete(SESSION_PREFIX + t); } catch (_) {} return null; }
    return d;
  }
  async function deleteSession(t) { try { await blob.delete(SESSION_PREFIX + t); } catch (_) {} }

  async function lookupUser(userKey) {
    const c = USER_CACHE.get(userKey);
    if (c && c.expires > Date.now()) return c.user;
    const baseId = env("AIRTABLE_BASE_ID");
    const readKey = env("AIRTABLE_READ_KEY");
    if (!baseId || !readKey) throw new Error("AIRTABLE_BASE_ID/AIRTABLE_READ_KEY env var fehlt");
    const formula = `AND({api_key}='${userKey.replace(/'/g, "\\'")}',{status}='aktiv')`;
    const url = `https://api.airtable.com/v0/${baseId}/User?filterByFormula=${encodeURIComponent(formula)}&maxRecords=1`;
    const res = await fetch(url, { headers: { Authorization: "Bearer " + readKey } });
    if (!res.ok) throw new Error("Airtable User-Lookup HTTP " + res.status);
    const data = await res.json();
    if (!data.records || !data.records.length) {
      USER_CACHE.set(userKey, { user: null, expires: Date.now() + CACHE_TTL_MS });
      return null;
    }
    const r = data.records[0];
    const u = { id: r.id, api_key: r.fields.api_key, name: r.fields.name, role: r.fields.role, is_admin: r.fields.role === "admin" };
    USER_CACHE.set(userKey, { user: u, expires: Date.now() + CACHE_TTL_MS });
    return u;
  }

  async function resolveAuth(token) {
    const s = await getSession(token);
    if (s) return { kind: "session", api_key: s.userApiKey, name: s.name, role: s.role, is_admin: s.isAdmin };
    try {
      const u = await lookupUser(token);
      if (u) return { kind: "direct", api_key: u.api_key, name: u.name, role: u.role, is_admin: u.is_admin };
    } catch (_) {}
    return null;
  }

  const app = new Hono();

  app.onError((err, c) => {
    console.error(c.req.method, c.req.path, err);
    return json({ error: err.message || "Internal error" }, 500);
  });
  app.notFound((c) => json({ error: "Not found", path: c.req.path.replace(/^\/+/, "") }, 404));

  app.options("*", () => new Response(null, { status: 204, headers: CORS_PREFLIGHT_HEADERS }));

  // Unauthenticated liveness check for Railway (new; Val.town had no equivalent)
  app.get("/healthz", () => json({ ok: true }));

  app.post("/auth", async (c) => {
    const b = await readJsonBody(c.req.raw);
    const userKey = (b.user_key || "").toString().trim();
    if (!userKey) return json({ error: "user_key fehlt" }, 400);
    let user; try { user = await lookupUser(userKey); } catch (e) { return json({ error: e.message }, 500); }
    if (!user) return json({ error: "Ungültiger Login-Key oder Account inaktiv" }, 401);
    const t = genToken();
    const ttl = b.long_lived ? SESSION_LONG : SESSION_SHORT;
    await setSession(t, { userApiKey: user.api_key, name: user.name, role: user.role, isAdmin: user.is_admin, expires: Date.now() + ttl });
    return json({ session_token: t, expires_in: Math.floor(ttl / 1000), user });
  });

  // Everything below needs a session/user token, or X-Sync-Secret for cron jobs
  app.use("*", async (c, next) => {
    const syncSecret = (c.req.header("x-sync-secret") || "").trim();
    const validSecret = env("SYNC_SECRET");
    const isCron = !!(syncSecret && validSecret && syncSecret === validSecret);

    let user, tok;
    if (isCron) {
      user = { kind: "cron", api_key: "cron", name: "Cron", role: "system", is_admin: true };
    } else {
      tok = (c.req.header("authorization") || "").replace(/^Bearer\s+/i, "").trim();
      if (!tok) return json({ error: "Missing Bearer token" }, 401);
      user = await resolveAuth(tok);
      if (!user) return json({ error: "Ungültiges Token" }, 401);
    }
    c.set("user", user);
    c.set("token", tok);
    await next();
  });

  app.post("/logout", async (c) => {
    // The Val.town version referenced an out-of-scope variable here and threw,
    // so logout never deleted the session. Fixed: the session is now deleted.
    if (c.get("user").kind === "session") await deleteSession(c.get("token"));
    return json({ ok: true });
  });
  app.all("/me", (c) => json({ user: c.get("user") }));
  app.all("/health", (c) => {
    const user = c.get("user");
    return json({ ok: true, user: { name: user.name, is_admin: user.is_admin } });
  });

  // ── Debug: welche Env-Vars sind gesetzt? (Werte nicht ausgegeben) ──
  app.all("/debug/env", (c) => {
    if (!c.get("user").is_admin) return json({ error: "Nur fuer Admins" }, 403);
    const keys = ["AIRTABLE_READ_KEY", "AIRTABLE_BASE_ID", "AUFZUG_API_KEY", "AUFZUG_API_KEY_AUFZUG", "AUFZUG_API_KEY_ASZENDIO", "AUFZUG_BASE_URL"];
    const out = {};
    for (const k of keys) {
      const v = env(k);
      out[k] = v ? { set: true, length: v.length, preview: v.length > 8 ? v.slice(0, 4) + "..." + v.slice(-2) : "(short)" } : { set: false };
    }
    return json({ env: out, tenant_map: TENANT_MAP });
  });

  // ── Debug-Probe: beliebigen ERP-Pfad testen, raw upstream-response zurueckgeben ──
  app.post("/debug/probe", async (c) => {
    if (!c.get("user").is_admin) return json({ error: "Nur fuer Admins" }, 403);
    const b = await readJsonBody(c.req.raw);
    const firma = (b.firma || "aufzug").toString();
    const probePath = (b.path || "").toString().replace(/^\/+/, "");
    // Tenant aus Body (Firmen-Verwaltung) > TENANT_MAP-Fallback
    const tenant = (b.tenant && String(b.tenant).trim()) || TENANT_MAP[firma];
    if (!tenant) return json({ error: "Kein Tenant fuer Firma " + firma + " (weder Body noch TENANT_MAP)" }, 400);
    const apiKey = env("AUFZUG_API_KEY_" + firma.toUpperCase()) || env("AUFZUG_API_KEY");
    if (!apiKey) return json({ error: "Kein API-Key fuer Firma " + firma + " gesetzt", expected_env: ["AUFZUG_API_KEY_" + firma.toUpperCase(), "AUFZUG_API_KEY"] }, 500);
    const baseUrl = env("AUFZUG_BASE_URL") || DEFAULT_AUFZUG_BASE_URL;
    const target = baseUrl + "/" + probePath;
    const t0 = Date.now();
    let upstreamStatus = null, upstreamBody = "", upstreamErr = null;
    try {
      const r = await fetch(target, { method: "GET", headers: { APIKEY: apiKey, TENANT: tenant, Accept: "application/json" } });
      upstreamStatus = r.status;
      upstreamBody = await r.text();
    } catch (e) { upstreamErr = e.message; }
    return json({
      target,
      tenant,
      tenant_source: b.tenant ? "body" : "TENANT_MAP",
      api_key_source: env("AUFZUG_API_KEY_" + firma.toUpperCase()) ? "AUFZUG_API_KEY_" + firma.toUpperCase() : "AUFZUG_API_KEY",
      api_key_preview: apiKey.length > 8 ? apiKey.slice(0, 4) + "..." + apiKey.slice(-2) : "(short)",
      duration_ms: Date.now() - t0,
      status: upstreamStatus,
      err: upstreamErr,
      body_excerpt: upstreamBody ? upstreamBody.slice(0, 2000) : null,
    });
  });

  // ══════════ AUFZUGSHANDWERK ERP PROXY ══════════
  // ANY /aufzug/<firma>/<path> → AUFZUG_BASE_URL/<path>
  app.all("/aufzug/*", async (c) => {
    const req = c.req.raw;
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/+/, "");
    if (!path.startsWith("aufzug/")) return c.notFound();
    const rest = path.replace(/^aufzug\//, "");
    const i = rest.indexOf("/");
    if (i < 0) return json({ error: "Bad path. Erwartet: /aufzug/<firma>/<path>" }, 400);
    const firma = rest.slice(0, i);
    const up = rest.slice(i + 1);
    // Tenant: X-ERP-Tenant Header (Firmen-Verwaltung) > TENANT_MAP-Fallback
    const tenantHeader = (req.headers.get("x-erp-tenant") || "").trim();
    const tenant = tenantHeader || TENANT_MAP[firma];
    if (!tenant) return json({ error: "Kein Tenant fuer Firma " + firma + " – setze ihn in der Firmen-Verwaltung", hint: "erlaubte Slugs im Fallback: " + Object.keys(TENANT_MAP).join(", ") }, 400);
    // Per-Firma API-Key zuerst, dann globalen Fallback
    const firmaEnvKey = "AUFZUG_API_KEY_" + firma.toUpperCase();
    const apiKey = env(firmaEnvKey) || env("AUFZUG_API_KEY");
    if (!apiKey) return json({ error: "Kein API-Key fuer Firma " + firma + " hinterlegt", expected_env: [firmaEnvKey, "AUFZUG_API_KEY"] }, 500);
    const baseUrl = env("AUFZUG_BASE_URL") || DEFAULT_AUFZUG_BASE_URL;
    const target = baseUrl + "/" + up + url.search;
    const t0 = Date.now();
    const init = { method: req.method, headers: { APIKEY: apiKey, TENANT: tenant, Accept: "application/json" } };
    if (req.method !== "GET" && req.method !== "HEAD") {
      const t = await req.text();
      if (t && t.length > 0) { init.body = t; init.headers["Content-Type"] = "application/json"; }
    }
    let up2;
    try {
      up2 = await fetch(target, init);
    } catch (e) {
      return json({ error: "Upstream-Verbindung fehlgeschlagen", target, tenant, message: e.message }, 502);
    }
    const noBody = up2.status === 101 || up2.status === 204 || up2.status === 205 || up2.status === 304;
    const text = noBody ? null : await up2.text();
    // Bei Upstream-Fehler: strukturierte Fehlerantwort mit Diagnose
    if (up2.status >= 400) {
      return json({
        error: "Upstream HTTP " + up2.status,
        target,
        tenant,
        tenant_source: tenantHeader ? "X-ERP-Tenant header" : "TENANT_MAP fallback",
        method: req.method,
        api_key_source: env(firmaEnvKey) ? firmaEnvKey : "AUFZUG_API_KEY",
        duration_ms: Date.now() - t0,
        upstream_body_excerpt: text ? text.slice(0, 1500) : null,
        upstream_content_type: up2.headers.get("content-type") || null,
      }, up2.status);
    }
    return new Response(text, { status: up2.status, headers: {
      "content-type": up2.headers.get("content-type") || "application/json",
      "access-control-allow-origin": "*",
      "x-erp-target": target,
      "x-erp-tenant": tenant,
      "x-erp-duration-ms": String(Date.now() - t0),
    } });
  });

  // ══════════ FRESHDESK PROXY ══════════
  // Routes: /freshdesk/<firma>/api/v2/... → https://<domain>.freshdesk.com/<api/v2/...>
  // Auth via FRESHDESK_API_KEY_<FIRMA> (Basic Auth, key:X)
  app.all("/freshdesk/*", async (c) => {
    const req = c.req.raw;
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/+/, "");
    if (!path.startsWith("freshdesk/")) return c.notFound();
    const rest = path.replace(/^freshdesk\//, "");
    const i = rest.indexOf("/");
    if (i < 0) return json({ error: "Bad path. Erwartet: /freshdesk/<firma>/<fd-path>" }, 400);
    const firma = rest.slice(0, i);
    const fdPath = rest.slice(i + 1);
    const domainEnv = "FRESHDESK_DOMAIN_" + firma.toUpperCase();
    const keyEnv = "FRESHDESK_API_KEY_" + firma.toUpperCase();
    const domain = env(domainEnv);
    const apiKey = env(keyEnv);
    if (!domain || !apiKey) return json({ error: "Freshdesk-Config fehlt für Firma " + firma, expected_env: [domainEnv, keyEnv] }, 500);
    const target = "https://" + domain + ".freshdesk.com/" + fdPath + url.search;
    const t0 = Date.now();
    const basic = btoa(apiKey + ":X");
    // Forward body as ArrayBuffer wenn vorhanden; Content-Type aus Request übernehmen (wichtig für multipart/form-data!)
    const upstreamHeaders = { "Authorization": "Basic " + basic };
    const originalCT = req.headers.get("content-type");
    if (originalCT) upstreamHeaders["Content-Type"] = originalCT;
    const fdInit = { method: req.method, headers: upstreamHeaders };
    if (req.method !== "GET" && req.method !== "HEAD") {
      fdInit.body = await req.arrayBuffer();
    }
    let r;
    try { r = await fetch(target, fdInit); }
    catch (e) { return json({ error: "Freshdesk-Verbindung fehlgeschlagen", target, message: e.message }, 502); }
    const noBody = r.status === 101 || r.status === 204 || r.status === 205 || r.status === 304;
    const respText = noBody ? null : await r.text();
    if (r.status >= 400) {
      return json({
        error: "Freshdesk HTTP " + r.status,
        target,
        firma,
        method: req.method,
        duration_ms: Date.now() - t0,
        upstream_body_excerpt: respText ? respText.slice(0, 1500) : null,
      }, r.status);
    }
    return new Response(respText, { status: r.status, headers: {
      "content-type": r.headers.get("content-type") || "application/json",
      "access-control-allow-origin": "*",
      "x-fd-duration-ms": String(Date.now() - t0),
    } });
  });

  // ══════════ BACKGROUND-SYNC ENDPOINTS ══════════

  app.post("/sync/run", async (c) => {
    const user = c.get("user");
    const b = await readJsonBody(c.req.raw);
    const firma = (b.firma || "").toString();
    if (!firma) return json({ error: "firma fehlt" }, 400);
    try {
      const result = await runSyncForFirma(firma, user.api_key || "system");
      return json(result);
    } catch (e) {
      const errResult = { firma, error: e.message, finished: new Date().toISOString() };
      try { await blob.setJSON("sync_status_" + firma, errResult); } catch (_) {}
      return json({ error: e.message, firma }, 500);
    }
  });

  app.get("/sync/status", async () => {
    let items = [];
    try { items = await blob.list("sync_status_") || []; } catch (_) {}
    const statuses = {};
    for (const item of items) {
      const key = (item && item.key) ? item.key : item;
      try {
        const data = await blob.getJSON(key);
        const firma = String(key).replace("sync_status_", "");
        statuses[firma] = data;
      } catch (_) {}
    }
    return json({ statuses });
  });

  // Sync für ALLE aktiven Firmen (für Cron-Jobs)
  app.post("/sync/run-all", async (c) => {
    const user = c.get("user");
    try {
      const firmen = await atReadAll("Firmen");
      const results = [];
      for (const f of firmen) {
        const slug = f.fields && f.fields.slug;
        const tenant = f.fields && f.fields.erp_tenant;
        const aktiv = (f.fields && f.fields.aktiv) !== false;
        if (!slug || !tenant || !aktiv) continue;
        try {
          const r = await runSyncForFirma(slug, user.api_key || "cron");
          results.push({ firma: slug, ok: true, created: r.created, updated: r.updated, skipped: r.skipped, errors: r.errors });
        } catch (e) {
          results.push({ firma: slug, ok: false, error: e.message });
          try { await blob.setJSON("sync_status_" + slug, { firma: slug, error: e.message, finished: new Date().toISOString(), triggered_by: user.api_key || "cron" }); } catch (_) {}
        }
      }
      const summary = { ran: results.length, started: new Date().toISOString(), results };
      try { await blob.setJSON("cron_last_run", summary); } catch (_) {}
      return json(summary);
    } catch (e) {
      return json({ error: e.message }, 500);
    }
  });

  return app;
}
