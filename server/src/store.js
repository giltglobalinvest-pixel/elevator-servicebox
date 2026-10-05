// Key/value JSON store that replaces Val.town's `std/blob`.
// One file per key under DATA_DIR. On Railway, mount a volume there so
// sessions and sync status survive redeploys.
import { mkdir, readFile, writeFile, rename, unlink, readdir } from "node:fs/promises";
import path from "node:path";

const SUFFIX = ".json";

export function createFileStore(dir) {
  const ready = mkdir(dir, { recursive: true });
  const file = (key) => path.join(dir, encodeURIComponent(key) + SUFFIX);

  return {
    async getJSON(key) {
      await ready;
      try {
        return JSON.parse(await readFile(file(key), "utf8"));
      } catch (e) {
        if (e.code === "ENOENT") return undefined;
        throw e;
      }
    },
    async setJSON(key, value) {
      await ready;
      const target = file(key);
      const tmp = target + "." + process.pid + "." + Date.now() + ".tmp";
      await writeFile(tmp, JSON.stringify(value));
      await rename(tmp, target);
    },
    async delete(key) {
      await ready;
      try {
        await unlink(file(key));
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
    },
    // Same shape as blob.list(prefix): [{ key }]
    async list(prefix = "") {
      await ready;
      const names = await readdir(dir);
      return names
        .filter((n) => n.endsWith(SUFFIX))
        .map((n) => ({ key: decodeURIComponent(n.slice(0, -SUFFIX.length)) }))
        .filter((item) => item.key.startsWith(prefix));
    },
  };
}
