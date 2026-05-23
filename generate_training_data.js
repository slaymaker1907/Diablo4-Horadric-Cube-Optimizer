#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const zlib = require("node:zlib");
const { once } = require("node:events");
const { pipeline } = require("node:stream/promises");

const worker = require("./d4cubeoptim-worker.js");

const DAMAGE_TYPES = ["Physical", "Fire", "Cold", "Shadow", "Lightning", "Poison"];
const ELEMENTAL_TYPED_AFFIXES = DAMAGE_TYPES.map((type) => ({
  name: `Elemental Damage (${type})`,
  family: "elemental-damage",
  rollWeight: 1 / DAMAGE_TYPES.length,
}));
const SPECIFIC_RESISTANCE_TYPED_AFFIXES = DAMAGE_TYPES.map((type) => ({
  name: `Specific Resistance (${type})`,
  family: "specific-resistance",
  rollWeight: 1 / DAMAGE_TYPES.length,
}));

const CATEGORY_TO_AFFIX_NAMES = {
  Aggressive: [
    "Mainstat",
    "Weapon Damage",
    "Attack Speed",
    "Critical Strike Chance",
    "Critical Strike Damage",
    "Vulnerable Damage",
    "DoT Damage",
    "All Damage",
    ...ELEMENTAL_TYPED_AFFIXES,
    "Thorns",
  ],
  Pragmatic: [
    "Barrier Generation",
    "Cooldown Reduction",
    "Fortify Generation",
    "Healing Received",
    "Impairment Reduction",
    "Life Regeneration",
    "Lucky Hit Chance",
    "Movement Speed",
    "Potion Capacity",
    "Thorns",
    "Maximum Evade Charges",
    "Attacks reduce Evade Cooldown",
    "Evade grants Movement Speed",
  ],
  Protector: [
    "Armor",
    "Damage Reduction",
    "Dodge Chance",
    "Fortify Generation",
    "Life on Hit",
    "Life on Kill",
    "Life Regeneration",
    "Maximum Life",
    "All Resistance",
    ...SPECIFIC_RESISTANCE_TYPED_AFFIXES,
  ],
  Resourceful: [
    "Lucky Hit Chance restore Resource",
    "Maximum Resource",
    "Resource Cost Reduction",
    "Resource on Kill",
    "Resource Regeneration",
  ],
  Adept: [
    "Mainstat",
    "Skill Ranks",
  ],
  Chromatic: [...SPECIFIC_RESISTANCE_TYPED_AFFIXES],
};

const DEFAULTS = {
  rows: 100000,
  outputDir: process.cwd(),
  filePrefix: "training-data",
  rowsPerFlush: 1_000_000,
  flushMs: 60_000,
  rotateBytes: 10 * 1024 * 1024 * 1024,
  minFreeDiskBytes: 500 * 1024 * 1024 * 1024,
  memorySoftLimitBytes: 40 * 1024 * 1024 * 1024,
  memoryCheckRows: 10_000,
  thinkingMs: 75,
  depthLimit: 26,
  rolloutDepthLimit: 26,
  rolloutCount: 5,
  strictMode: true,
  logEveryRows: 50_000,
  seed: (Date.now() >>> 0) || 1,
};

class XorShift32 {
  constructor(seed) {
    this.state = (Number(seed) >>> 0) || 0x9e3779b9;
  }

  nextUint32() {
    let x = this.state >>> 0;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x >>>= 0;
    x ^= x << 5;
    x >>>= 0;
    this.state = x;
    return x;
  }

  next() {
    return this.nextUint32() / 0x100000000;
  }

  int(maxExclusive) {
    if (!Number.isFinite(maxExclusive) || maxExclusive <= 0) {
      return 0;
    }
    return Math.floor(this.next() * maxExclusive);
  }
}

class RotatingNdjsonWriter {
  constructor(config) {
    this.outputDir = config.outputDir;
    this.filePrefix = config.filePrefix;
    this.rowsPerFlush = config.rowsPerFlush;
    this.flushMs = config.flushMs;
    this.rotateBytes = config.rotateBytes;
    this.minFreeDiskBytes = config.minFreeDiskBytes;

    this.activePath = path.join(this.outputDir, `${this.filePrefix}.current.jsonl`);
    this.archiveIndex = 0;
    this.stream = null;

    this.buffer = [];
    this.bufferedRows = 0;
    this.bufferedBytes = 0;
    this.activeBytes = 0;
    this.lastFlushAt = Date.now();

    this.totalRows = 0;
    this.totalFlushes = 0;
    this.totalRotations = 0;
  }

  async init() {
    await fsp.mkdir(this.outputDir, { recursive: true });
    this.archiveIndex = await this.findNextArchiveIndex();
    this.stream = fs.createWriteStream(this.activePath, { flags: "a" });

    const stat = await safeStat(this.activePath);
    this.activeBytes = stat ? stat.size : 0;
    this.lastFlushAt = Date.now();
  }

  async close() {
    await this.flush("close");
    if (this.activeBytes >= this.rotateBytes) {
      await this.rotate("close");
    }
    await this.closeStream();
  }

  append(row) {
    const line = JSON.stringify(row);
    this.buffer.push(line);
    this.bufferedRows += 1;
    this.bufferedBytes += Buffer.byteLength(line) + 1;
    this.totalRows += 1;
  }

  async maybeFlush() {
    if (this.bufferedRows === 0) {
      return;
    }

    const now = Date.now();
    const shouldFlushByRows = this.bufferedRows >= this.rowsPerFlush;
    const shouldFlushByTime = now - this.lastFlushAt >= this.flushMs;
    const shouldFlushByRotateBoundary = this.activeBytes + this.bufferedBytes >= this.rotateBytes;

    if (!shouldFlushByRows && !shouldFlushByTime && !shouldFlushByRotateBoundary) {
      return;
    }

    let reason = "manual";
    if (shouldFlushByRows) {
      reason = "rows";
    } else if (shouldFlushByTime) {
      reason = "time";
    } else if (shouldFlushByRotateBoundary) {
      reason = "rotate-boundary";
    }

    await this.flush(reason);

    if (this.activeBytes >= this.rotateBytes) {
      await this.rotate(reason);
    }
  }

  async flush(reason) {
    if (this.bufferedRows === 0) {
      return;
    }

    const payload = `${this.buffer.join("\n")}\n`;
    const payloadBytes = Buffer.byteLength(payload);

    this.buffer.length = 0;
    this.bufferedRows = 0;
    this.bufferedBytes = 0;

    await this.write(payload);

    this.activeBytes += payloadBytes;
    this.lastFlushAt = Date.now();
    this.totalFlushes += 1;

    if (reason === "memory-soft-reset") {
      return;
    }
  }

  async rotate(trigger) {
    await this.ensureDiskHeadroom();

    const archiveBase = `${this.filePrefix}.${String(this.archiveIndex).padStart(6, "0")}.jsonl`;
    const archiveRawPath = path.join(this.outputDir, archiveBase);
    const archiveGzipPath = `${archiveRawPath}.gz`;

    await this.closeStream();
    await fsp.rename(this.activePath, archiveRawPath);

    await pipeline(
      fs.createReadStream(archiveRawPath),
      zlib.createGzip({ level: zlib.constants.Z_BEST_SPEED }),
      fs.createWriteStream(archiveGzipPath)
    );

    await fsp.unlink(archiveRawPath);

    this.archiveIndex += 1;
    this.totalRotations += 1;
    this.activeBytes = 0;
    this.stream = fs.createWriteStream(this.activePath, { flags: "w" });

    if (trigger) {
      process.stdout.write(`[rotate] ${archiveGzipPath}\n`);
    }
  }

  async ensureDiskHeadroom() {
    const freeBytes = await getFreeDiskBytes(this.outputDir);
    if (Number.isFinite(freeBytes) && freeBytes < this.minFreeDiskBytes) {
      throw new Error(
        `Refusing rotation: free disk ${formatBytes(freeBytes)} is below minimum ${formatBytes(this.minFreeDiskBytes)}.`
      );
    }
  }

  async write(text) {
    if (!this.stream.write(text)) {
      await once(this.stream, "drain");
    }
  }

  async closeStream() {
    if (!this.stream) {
      return;
    }

    const stream = this.stream;
    this.stream = null;

    await new Promise((resolve, reject) => {
      stream.end((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  async findNextArchiveIndex() {
    const names = await fsp.readdir(this.outputDir);
    const pattern = new RegExp(`^${escapeRegex(this.filePrefix)}\\.(\\d{6})\\.jsonl\\.gz$`);

    let maxIndex = -1;
    for (const name of names) {
      const match = pattern.exec(name);
      if (!match) {
        continue;
      }
      const value = Number(match[1]);
      if (Number.isFinite(value) && value > maxIndex) {
        maxIndex = value;
      }
    }

    return maxIndex + 1;
  }
}

function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildCatalog(categoryToNames) {
  const byId = Object.create(null);

  for (const [category, names] of Object.entries(categoryToNames)) {
    for (const entry of names) {
      const name = typeof entry === "string" ? entry : entry.name;
      const family = typeof entry === "string" ? "" : String(entry.family || "");
      const rollWeight = typeof entry === "string" ? 1 : Number(entry.rollWeight);
      const id = slugify(name);
      if (!byId[id]) {
        byId[id] = {
          id,
          name,
          categories: [],
          family,
          rollWeight: Number.isFinite(rollWeight) && rollWeight > 0 ? rollWeight : 1,
        };
      }

      if (family) {
        byId[id].family = family;
      }

      if (Number.isFinite(rollWeight) && rollWeight > 0) {
        byId[id].rollWeight = rollWeight;
      }

      if (!byId[id].categories.includes(category)) {
        byId[id].categories.push(category);
      }
    }
  }

  const affixes = Object.values(byId).sort((left, right) => left.name.localeCompare(right.name));
  const affixIds = affixes.map((entry) => entry.id);

  const categories = Object.fromEntries(
    Object.entries(categoryToNames).map(([category, names]) => [
      category,
      names
        .map((entry) => (typeof entry === "string" ? entry : entry.name))
        .map((name) => slugify(name))
        .filter((id) => !!byId[id]),
    ])
  );

  return {
    affixes,
    affixIds,
    categories,
  };
}

function sampleUniqueIds(rng, ids, count, seed = []) {
  const picked = new Set(seed);
  const out = Array.from(seed);

  while (out.length < count) {
    const id = ids[rng.int(ids.length)];
    if (!id || picked.has(id)) {
      continue;
    }
    picked.add(id);
    out.push(id);
  }

  return out;
}

function shuffleInPlace(rng, list) {
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = rng.int(i + 1);
    const tmp = list[i];
    list[i] = list[j];
    list[j] = tmp;
  }
}

function getSourceGACounts(state) {
  const counts = Object.create(null);
  for (const entry of state.affixes) {
    if (!entry.isGA) {
      continue;
    }
    counts[entry.affixId] = (counts[entry.affixId] || 0) + 1;
  }
  return counts;
}

function generateScenario(rng, catalog) {
  const sourceAffixCount = 1 + rng.int(4);
  const sourceAffixIds = sampleUniqueIds(rng, catalog.affixIds, sourceAffixCount);

  const state = {
    isLegendary: rng.next() < 0.35,
    enchantressAvailable: true,
    gearSlot: "Any",
    affixes: sourceAffixIds.map((affixId) => ({
      affixId,
      isGA: rng.next() < 0.23,
      isEnchanted: false,
    })),
  };

  if (state.affixes.length > 0 && rng.next() < 0.13) {
    const index = rng.int(state.affixes.length);
    state.affixes[index].isEnchanted = true;
    state.enchantressAvailable = false;
  } else {
    state.enchantressAvailable = rng.next() < 0.8;
  }

  const sourceGACounts = getSourceGACounts(state);
  const sourceGAIds = Object.keys(sourceGACounts);

  const seededTargetIds = [];
  if (sourceGAIds.length > 0) {
    seededTargetIds.push(sourceGAIds[rng.int(sourceGAIds.length)]);
  }

  const targetIds = sampleUniqueIds(rng, catalog.affixIds, 4, seededTargetIds);
  shuffleInPlace(rng, targetIds);

  const target = {
    affixes: targetIds.map((affixId) => ({
      affixId,
      requireGA: false,
    })),
  };

  if (sourceGAIds.length > 0) {
    const available = { ...sourceGACounts };
    const gaEligibleIndexes = [];

    for (let index = 0; index < target.affixes.length; index += 1) {
      const entry = target.affixes[index];
      if ((available[entry.affixId] || 0) > 0) {
        gaEligibleIndexes.push(index);
      }
    }

    if (gaEligibleIndexes.length > 0) {
      const first = gaEligibleIndexes[rng.int(gaEligibleIndexes.length)];
      target.affixes[first].requireGA = true;
      available[target.affixes[first].affixId] -= 1;

      // Optionally request one more GA when the source has enough preserved GA affixes.
      if (gaEligibleIndexes.length > 1 && rng.next() < 0.22) {
        shuffleInPlace(rng, gaEligibleIndexes);
        for (const index of gaEligibleIndexes) {
          if (target.affixes[index].requireGA) {
            continue;
          }
          const id = target.affixes[index].affixId;
          if ((available[id] || 0) <= 0) {
            continue;
          }
          target.affixes[index].requireGA = true;
          available[id] -= 1;
          break;
        }
      }
    }
  }

  return {
    state,
    target,
  };
}

function createRow(index, scenarioSeed, scenario, result) {
  const action = result.action || null;
  return {
    schemaVersion: 1,
    rowIndex: index,
    scenarioSeed,
    source: scenario.state,
    target: scenario.target,
    result: {
      action,
      actionKey: action ? worker.actionKey(action) : null,
      successProb: result.successProb,
      expectedSteps: result.expectedSteps,
      stdDev: result.stdDev,
      iterations: result.iterations,
      strategy: result.diagnostics && result.diagnostics.strategy
        ? result.diagnostics.strategy
        : "mcts",
      rule: result.diagnostics && result.diagnostics.rule
        ? result.diagnostics.rule
        : null,
      reason: result.diagnostics && result.diagnostics.reason
        ? result.diagnostics.reason
        : "",
      elapsedMs: result.elapsedMs,
      stoppedByUser: !!result.stoppedByUser,
    },
  };
}

async function maybeSoftReset(writer, runtime, config) {
  const usage = process.memoryUsage();
  const highWatermark = Math.max(usage.heapUsed || 0, usage.rss || 0);
  if (highWatermark < config.memorySoftLimitBytes) {
    return false;
  }

  await writer.flush("memory-soft-reset");

  runtime.lastResult = null;
  runtime.lastRow = null;

  if (typeof global.gc === "function") {
    global.gc();
  }

  runtime.softResets += 1;
  process.stdout.write(
    `[memory] soft reset #${runtime.softResets} at heap=${formatBytes(usage.heapUsed)} rss=${formatBytes(usage.rss)}\n`
  );

  return true;
}

function buildSolvePayload(config, catalog, scenario) {
  const currentGAAffixes = scenario.state.affixes
    .filter((entry) => entry.isGA)
    .map((entry) => entry.affixId);

  return {
    state: scenario.state,
    target: scenario.target,
    data: {
      affixes: catalog.affixes,
      categories: catalog.categories,
      targetAffixIds: scenario.target.affixes.map((entry) => entry.affixId),
    },
    gaConfig: {
      currentGAAffixes,
      sacrificeAffixId: "",
      strictMode: !!config.strictMode,
      rulesEnabled: true,
    },
    timeMs: config.thinkingMs,
    tree: null,
    includeTree: false,
    depthLimit: config.depthLimit,
    rolloutDepthLimit: config.rolloutDepthLimit,
    rolloutCount: config.rolloutCount,
  };
}

async function runGenerator(config) {
  if (!process.execArgv.some((arg) => arg.startsWith("--max-old-space-size="))) {
    process.stdout.write("[hint] run with --max-old-space-size=51200 to align with the 50GB heap cap target.\n");
  }

  const catalog = buildCatalog(CATEGORY_TO_AFFIX_NAMES);
  const writer = new RotatingNdjsonWriter(config);
  await writer.init();

  const rng = new XorShift32(config.seed);
  const runtime = {
    softResets: 0,
    lastResult: null,
    lastRow: null,
  };

  const startedAt = Date.now();
  let lastLogAt = startedAt;

  try {
    for (let rowIndex = 1; rowIndex <= config.rows; rowIndex += 1) {
      const scenarioSeed = rng.state >>> 0;
      const scenario = generateScenario(rng, catalog);
      const payload = buildSolvePayload(config, catalog, scenario);
      const result = worker.optimizeScenario(payload);

      const row = createRow(rowIndex, scenarioSeed, scenario, result);
      writer.append(row);

      runtime.lastResult = result;
      runtime.lastRow = row;

      if ((rowIndex & 255) === 0) {
        await writer.maybeFlush();
      }

      if (rowIndex % config.memoryCheckRows === 0) {
        await maybeSoftReset(writer, runtime, config);
      }

      const now = Date.now();
      if (rowIndex % config.logEveryRows === 0 || now - lastLogAt >= 5000) {
        const elapsedSeconds = Math.max(1, Math.floor((now - startedAt) / 1000));
        const rps = Math.floor(rowIndex / elapsedSeconds);
        process.stdout.write(
          `[progress] rows=${rowIndex}/${config.rows} rps=${rps} flushes=${writer.totalFlushes} rotations=${writer.totalRotations} active=${formatBytes(writer.activeBytes)}\n`
        );
        lastLogAt = now;
      }
    }

    await writer.flush("final");
    if (writer.activeBytes >= writer.rotateBytes) {
      await writer.rotate("final");
    }
  } finally {
    await writer.close();
  }

  const elapsedMs = Date.now() - startedAt;
  process.stdout.write(
    `[done] rows=${writer.totalRows} elapsedMs=${elapsedMs} flushes=${writer.totalFlushes} rotations=${writer.totalRotations} softResets=${runtime.softResets}\n`
  );
}

function parseArgs(argv) {
  const config = { ...DEFAULTS };

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      config.help = true;
      continue;
    }

    if (!arg.startsWith("--")) {
      throw new Error(`Unknown argument format: ${arg}`);
    }

    const eq = arg.indexOf("=");
    const key = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
    const value = eq >= 0 ? arg.slice(eq + 1) : "true";

    switch (key) {
      case "rows":
        config.rows = parsePositiveInt(value, "rows");
        break;
      case "output-dir":
        config.outputDir = value ? path.resolve(value) : config.outputDir;
        break;
      case "file-prefix":
        config.filePrefix = value || config.filePrefix;
        break;
      case "rows-per-flush":
        config.rowsPerFlush = parsePositiveInt(value, "rows-per-flush");
        break;
      case "flush-ms":
        config.flushMs = parsePositiveInt(value, "flush-ms");
        break;
      case "rotate-bytes":
        config.rotateBytes = parseBytes(value);
        break;
      case "min-free-disk-bytes":
        config.minFreeDiskBytes = parseBytes(value);
        break;
      case "memory-soft-limit-bytes":
        config.memorySoftLimitBytes = parseBytes(value);
        break;
      case "memory-check-rows":
        config.memoryCheckRows = parsePositiveInt(value, "memory-check-rows");
        break;
      case "thinking-ms":
        config.thinkingMs = parsePositiveInt(value, "thinking-ms");
        break;
      case "depth-limit":
        config.depthLimit = parsePositiveInt(value, "depth-limit");
        break;
      case "rollout-depth-limit":
        config.rolloutDepthLimit = parsePositiveInt(value, "rollout-depth-limit");
        break;
      case "rollout-count":
        config.rolloutCount = parsePositiveInt(value, "rollout-count");
        break;
      case "log-every-rows":
        config.logEveryRows = parsePositiveInt(value, "log-every-rows");
        break;
      case "seed":
        config.seed = parsePositiveInt(value, "seed") >>> 0;
        if (config.seed === 0) {
          config.seed = 1;
        }
        break;
      case "strict-mode":
        config.strictMode = parseBoolean(value);
        break;
      default:
        throw new Error(`Unknown option: --${key}`);
    }
  }

  return config;
}

function parsePositiveInt(value, name) {
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid ${name}: ${value}`);
  }
  return parsed;
}

function parseBoolean(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }
  throw new Error(`Invalid boolean value: ${value}`);
}

function parseBytes(value) {
  const text = String(value || "").trim().toLowerCase();
  const match = /^(\d+(?:\.\d+)?)(b|kb|mb|gb|tb)?$/.exec(text);
  if (!match) {
    throw new Error(`Invalid byte value: ${value}`);
  }

  const n = Number(match[1]);
  const unit = match[2] || "b";
  const scaleByUnit = {
    b: 1,
    kb: 1024,
    mb: 1024 ** 2,
    gb: 1024 ** 3,
    tb: 1024 ** 4,
  };

  const scale = scaleByUnit[unit];
  if (!scale) {
    throw new Error(`Invalid byte unit: ${unit}`);
  }

  const out = Math.floor(n * scale);
  if (!Number.isFinite(out) || out <= 0) {
    throw new Error(`Invalid byte value: ${value}`);
  }
  return out;
}

async function getFreeDiskBytes(targetPath) {
  if (typeof fsp.statfs !== "function") {
    return Number.POSITIVE_INFINITY;
  }

  const stat = await fsp.statfs(targetPath);
  if (!stat) {
    return Number.POSITIVE_INFINITY;
  }

  const freeBlocks = Number(stat.bavail || stat.blocks || 0);
  const blockSize = Number(stat.bsize || 0);
  if (!Number.isFinite(freeBlocks) || !Number.isFinite(blockSize) || freeBlocks <= 0 || blockSize <= 0) {
    return Number.POSITIVE_INFINITY;
  }

  return freeBlocks * blockSize;
}

function formatBytes(bytes) {
  const n = Number(bytes || 0);
  if (!Number.isFinite(n) || n <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let value = n;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(unitIndex === 0 ? 0 : 2)} ${units[unitIndex]}`;
}

function escapeRegex(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function safeStat(filePath) {
  try {
    return await fsp.stat(filePath);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function printHelp() {
  process.stdout.write(
    [
      "Usage: node --max-old-space-size=51200 generate_training_data.js [options]",
      "",
      "Options:",
      "  --rows=<int>                       Total rows to generate (default 100000)",
      "  --output-dir=<path>                Output directory (default cwd)",
      "  --file-prefix=<name>               File prefix (default training-data)",
      "  --rows-per-flush=<int>             Flush threshold rows (default 1000000)",
      "  --flush-ms=<int>                   Flush threshold ms (default 60000)",
      "  --rotate-bytes=<size>              Rotate+gzip threshold (default 10gb)",
      "  --min-free-disk-bytes=<size>       Required free disk before rotate (default 500gb)",
      "  --memory-soft-limit-bytes=<size>   Soft reset threshold (default 40gb)",
      "  --memory-check-rows=<int>          Memory check cadence (default 10000)",
      "  --thinking-ms=<int>                Per-scenario solver budget (default 75)",
      "  --depth-limit=<int>                MCTS depth limit (default 26)",
      "  --rollout-depth-limit=<int>        Rollout depth limit (default 26)",
      "  --rollout-count=<int>              Rollout count (default 5)",
      "  --strict-mode=<bool>               Strict GA mode true/false (default true)",
      "  --log-every-rows=<int>             Progress logging cadence (default 50000)",
      "  --seed=<int>                       RNG seed (default now)",
      "",
      "Size values accept b, kb, mb, gb, tb suffixes.",
      "",
    ].join("\n")
  );
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  if (config.help) {
    printHelp();
    return;
  }

  await runGenerator(config);
}

if (require.main === module) {
  main().catch((error) => {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULTS,
  RotatingNdjsonWriter,
  XorShift32,
  buildCatalog,
  generateScenario,
  parseArgs,
  parseBytes,
  parseBoolean,
  parsePositiveInt,
  createRow,
  runGenerator,
};
