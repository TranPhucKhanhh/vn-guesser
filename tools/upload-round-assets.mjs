import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const uploadRoot = path.join(projectRoot, ".r2-upload");
const bucket = process.env.R2_BUCKET_NAME || "vietnam-map-data";
const files = await listFiles(uploadRoot);

if (!files.length) {
  throw new Error("No prepared assets found. Run npm run optimize:rounds first.");
}

for (const file of files) {
  const key = path.relative(uploadRoot, file).split(path.sep).join("/");
  const isImage = key.endsWith(".webp");
  const wranglerEntry = path.join(projectRoot, "node_modules", "wrangler", "bin", "wrangler.js");
  const args = [
    wranglerEntry,
    "r2",
    "object",
    "put",
    `${bucket}/${key}`,
    "--file",
    file,
    "--remote",
    "--content-type",
    isImage ? "image/webp" : "application/json",
    "--cache-control",
    isImage ? "private, max-age=31536000, immutable" : "no-store"
  ];
  const result = spawnSync(process.execPath, args, {
    cwd: projectRoot,
    stdio: "inherit",
    shell: false
  });

  if (result.status !== 0) {
    const detail = result.error ? ` ${result.error.message}` : "";
    throw new Error(`Upload failed for ${key}.${detail}`);
  }
}

const catalog = JSON.parse(
  await readFile(path.join(uploadRoot, "private", "round-catalog.v1.json"), "utf8")
);
console.log(`Uploaded ${catalog.rounds.length} optimized rounds and their private catalog.`);

async function listFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const fullPath = path.join(directory, entry.name);
      return entry.isDirectory() ? listFiles(fullPath) : [fullPath];
    })
  );
  return nested.flat().sort();
}
