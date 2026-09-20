import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const privateManifestPath = path.join(projectRoot, ".private", "rounds.json");
const sourceDirectory = path.resolve(projectRoot, "..", "images", "rounds");
const outputDirectory = path.join(projectRoot, ".r2-upload");
const widths = [1280, 1920];

const privateManifest = JSON.parse(await readFile(privateManifestPath, "utf8"));
if (!Array.isArray(privateManifest.rounds) || !privateManifest.rounds.length) {
  throw new Error(".private/rounds.json must contain a non-empty rounds array.");
}

const catalog = { version: 1, rounds: [] };

for (const round of privateManifest.rounds) {
  validateRound(round);
  const sourcePath = path.join(sourceDirectory, round.source);
  const images = {};

  for (const width of widths) {
    const webp = await sharp(sourcePath)
      .rotate()
      .resize({
        width,
        height: width,
        fit: "inside",
        withoutEnlargement: true
      })
      .webp({ quality: 80, effort: 5, smartSubsample: true })
      .toBuffer();
    const hash = createHash("sha256").update(webp).digest("hex").slice(0, 12);
    const key = `private/round-images/${round.assetId}-${width}-${hash}.webp`;
    const outputPath = path.join(outputDirectory, ...key.split("/"));
    await mkdir(path.dirname(outputPath), { recursive: true });
    await writeFile(outputPath, webp);
    images[String(width)] = key;
    console.log(`${round.source} -> ${key} (${(webp.length / 1024).toFixed(0)} KiB)`);
  }

  catalog.rounds.push({
    assetId: round.assetId,
    title: round.title,
    province: round.province,
    lat: round.lat,
    lng: round.lng,
    images
  });
}

const catalogPath = path.join(outputDirectory, "private", "round-catalog.v1.json");
await mkdir(path.dirname(catalogPath), { recursive: true });
await writeFile(catalogPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf8");
console.log(`Prepared ${catalog.rounds.length} private rounds in ${outputDirectory}`);

function validateRound(round) {
  if (
    typeof round.assetId !== "string" ||
    !/^[a-z0-9_-]{16,80}$/i.test(round.assetId) ||
    typeof round.source !== "string" ||
    typeof round.title !== "string" ||
    typeof round.province !== "string" ||
    !Number.isFinite(round.lat) ||
    !Number.isFinite(round.lng)
  ) {
    throw new Error("The private round manifest contains an invalid entry.");
  }
}

