import { serve } from "@hono/node-server";
import { Cron } from "croner";
import { createApp } from "./app.js";
import { createFileStore } from "./store.js";

const env = (name) => process.env[name];
const blob = createFileStore(env("DATA_DIR") || "./data");
const app = createApp({ env, blob });

const port = Number(env("PORT") || 3000);
serve({ fetch: app.fetch, port }, (info) => {
  console.log(`Servicebox proxy listening on :${info.port}`);
});

// Background sync schedule. Replaces the Val.town cron file (cron-sync.tsx),
// which POSTed /sync/run-all with X-Sync-Secret. Times are UTC like on Val.town.
const schedule = env("SYNC_CRON");
if (schedule) {
  if (!env("SYNC_SECRET")) {
    console.warn("SYNC_CRON is set but SYNC_SECRET is missing; background sync disabled");
  } else {
    new Cron(schedule, { timezone: env("SYNC_CRON_TZ") || "UTC", protect: true }, async () => {
      const t0 = Date.now();
      try {
        const res = await app.request("/sync/run-all", { method: "POST", headers: { "X-Sync-Secret": env("SYNC_SECRET") } });
        const text = await res.text();
        console.log("[Cron-Sync]", res.status, "in", Date.now() - t0 + "ms", text.slice(0, 600));
      } catch (e) {
        console.error("[Cron-Sync] Fehler:", e.message);
      }
    });
    console.log(`Background sync scheduled: ${schedule}`);
  }
}
