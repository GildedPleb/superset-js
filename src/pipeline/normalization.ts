import type { Db } from "../services/db";
import {
  getUnprocessedRawConfigs,
  getConfigContent,
  saveNormalizedConfig,
} from "../services/db";
import { createLogger } from "../services/logger";
import { mkdtemp, rm, writeFile, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import * as acorn from "acorn";
import * as walk from "acorn-walk";

const logger = createLogger("normalization");

export interface RuleSetting {
  severity: 0 | 1 | 2;
  optionsJson: string | null;
}

export interface ConfigBlock {
  files: string | string[] | null;
  rules: Record<string, RuleSetting>;
}

export interface NormalizedConfig {
  repoId: string;
  blocks: ConfigBlock[];
  jsPlugins: string[];
  migrationWarnings?: string[];
  normalizedAt: Date;
  rawSource: string;
}

export interface PackageSpec {
  name: string;
  version: string;
}

type PackageValue =
  | string
  | string[]
  | PackageSpec[]
  | (string | PackageSpec)[];

// Core packages needed for flat config + migration
const CORE_ESLINT_DEPS: Record<string, string> = {
  eslint: "latest",
  "@eslint/js": "latest",
  "@eslint/eslintrc": "latest",
  globals: "latest",
};

// === DECLARATIVE EXCEPTION LAYER ===
// When we see these exact extends strings, inject the seed packages and
// optionally override versions of the core deps. The peer-closure walker then
// transitively pulls in any required peerDependencies, so `add` only needs to
// list the seed package(s) — peers like react / eslint-plugin-react /
// @next/eslint-plugin-next are discovered automatically from
// eslint-config-next's package.json.
interface ExtendsInjection {
  add: (string | { name: string; version: string })[];
  override?: Record<string, string>;
}

const EXTENDS_INJECTION_MAP: Record<string, ExtendsInjection> = {
  "next/core-web-vitals": {
    // `next` must be added explicitly: eslint-config-next hard-requires
    // `next/dist/compiled/babel/eslint-parser` at load time but does NOT
    // declare `next` as a peer dependency, so the peer-closure walker
    // cannot discover it. This is a known packaging quirk of the Next.js
    // ESLint config.
    //
    // Pin eslint-config-next to ^14 (legacy `extends:`-style export) and
    // `next` to ^14 (compat). 15+ exports a *flat-config array* which
    // cannot be consumed by @eslint/eslintrc's legacy validator that
    // FlatCompat.extends() invokes — it expects an object at the root,
    // not an array, and rejects the load with "expected object but got
    // [...]". Rule content is essentially identical for our extraction
    // purposes; we just need a shape the legacy resolver can validate.
    //
    // We pin eslint to ^9 (not ^8) because @eslint/migrate-config@latest
    // emits flat configs that import "eslint/config", a subpath that
    // only exists in eslint 9+. eslint-config-next@14 declares peer
    // eslint ^7 || ^8 but in practice the legacy `extends:` chain loads
    // fine under eslint 9's runtime — the peer warning is benign for
    // our migration-only use case.
    add: [
      { name: "eslint-config-next", version: "^14" },
      { name: "next", version: "^14" },
    ],
    override: { eslint: "^9" },
  },
  "next/typescript": {
    add: [
      { name: "eslint-config-next", version: "^14" },
      { name: "next", version: "^14" },
    ],
    override: { eslint: "^9" },
  },
  // Add more known extends patterns here as we discover them
};

// === STATIC DISCOVERY (no regex) ===
// Legacy .eslintrc.* → simple JSON recursive walk
// Flat eslint.config.* → real Acorn AST walk

function walkJsonForMetadata(
  obj: any,
  metadata: { extends: string[]; plugins: string[] },
): void {
  if (!obj || typeof obj !== "object") return;
  if (Array.isArray(obj)) {
    obj.forEach((item) => walkJsonForMetadata(item, metadata));
    return;
  }
  if (obj.extends) {
    const ex = Array.isArray(obj.extends) ? obj.extends : [obj.extends];
    ex.forEach((e) => {
      if (typeof e === "string") metadata.extends.push(e);
    });
  }
  if (obj.plugins && Array.isArray(obj.plugins)) {
    obj.plugins.forEach((p) => {
      if (typeof p === "string") metadata.plugins.push(p);
    });
  }
  Object.values(obj).forEach((v) => walkJsonForMetadata(v, metadata));
}

function extractFlatConfigMetadata(source: string): {
  extends: string[];
  plugins: string[];
} {
  const metadata = { extends: [] as string[], plugins: [] as string[] };
  try {
    const ast = acorn.parse(source, {
      ecmaVersion: "latest",
      sourceType: "module",
    });
    walk.simple(ast, {
      ImportDeclaration(node: any) {
        const id = node.source?.value;
        if (typeof id === "string") metadata.plugins.push(id);
      },
      CallExpression(node: any) {
        if (
          node.callee?.name === "defineConfig" &&
          node.arguments[0]?.type === "ArrayExpression"
        ) {
          node.arguments[0].elements.forEach((el: any) => {
            if (el?.type === "ObjectExpression") {
              el.properties.forEach((prop: any) => {
                if (prop.key?.name === "extends" && prop.value) {
                  const ex = Array.isArray(prop.value.elements)
                    ? prop.value.elements
                    : [prop.value];
                  ex.forEach((e: any) => {
                    if (e?.value && typeof e.value === "string")
                      metadata.extends.push(e.value);
                  });
                }
              });
            }
          });
        }
      },
    });
  } catch {}
  return metadata;
}

function extractConfigMetadata(filename: string, source: string) {
  const metadata = { extends: [] as string[], plugins: [] as string[] };
  if (filename.startsWith(".eslintrc") || filename.endsWith(".json")) {
    try {
      walkJsonForMetadata(JSON.parse(source), metadata);
    } catch {}
  } else {
    const flat = extractFlatConfigMetadata(source);
    metadata.extends.push(...flat.extends);
    metadata.plugins.push(...flat.plugins);
  }
  return metadata;
}

function isLegacyEslintrc(filename: string): boolean {
  return filename.startsWith(".eslintrc") || filename === "eslintrc.json";
}

function isFlatEslintConfig(filename: string): boolean {
  return filename.startsWith("eslint.config.");
}

function isOxlintNativeJson(filename: string): boolean {
  return filename.endsWith(".oxlintrc.json") || filename === "oxlintrc.json";
}

function isOxlintTs(filename: string): boolean {
  return (
    filename.endsWith(".ts") &&
    (filename.includes("oxlint.config") || filename.includes(".oxlintrc"))
  );
}

function normalizeRuleSetting(val: any): RuleSetting {
  if (typeof val === "number") {
    return {
      severity: Math.max(0, Math.min(2, val)) as 0 | 1 | 2,
      optionsJson: null,
    };
  }
  if (typeof val === "string") {
    const map: Record<string, 0 | 1 | 2> = { off: 0, warn: 1, error: 2 };
    return { severity: map[val] ?? 0, optionsJson: null };
  }
  if (Array.isArray(val)) {
    const [sev, opts] = val;
    const severity =
      typeof sev === "number"
        ? (Math.max(0, Math.min(2, sev)) as 0 | 1 | 2)
        : 0;
    return {
      severity,
      optionsJson: opts != null ? JSON.stringify(opts) : null,
    };
  }
  return { severity: 0, optionsJson: null };
}

function buildNormalizedFromOxlintrc(
  oxlintrcJson: string,
  repoId: string,
): NormalizedConfig {
  let parsed: any;
  try {
    parsed = JSON.parse(oxlintrcJson);
  } catch {
    parsed = { rules: {}, overrides: [], jsPlugins: [] };
  }

  const blocks: ConfigBlock[] = [];
  blocks.push({
    files: null,
    rules: Object.fromEntries(
      Object.entries(parsed.rules || {}).map(([k, v]) => [
        k,
        normalizeRuleSetting(v),
      ]),
    ),
  });

  for (const ov of parsed.overrides || []) {
    blocks.push({
      files: ov.files ?? null,
      rules: Object.fromEntries(
        Object.entries(ov.rules || {}).map(([k, v]) => [
          k,
          normalizeRuleSetting(v),
        ]),
      ),
    });
  }

  return {
    repoId,
    blocks,
    jsPlugins: Array.isArray(parsed.jsPlugins) ? parsed.jsPlugins : [],
    migrationWarnings: parsed.migrationWarnings || undefined,
    normalizedAt: new Date(),
    rawSource: oxlintrcJson,
  };
}

// === DEFENSIVE PATCH: @eslint/eslintrc circular-stringify bug ===
// config-validator.js calls `JSON.stringify(error.data)` unguarded. When a
// shareable config's plugin graph contains cycles (common with modern
// "flat-style" shareable configs being loaded via FlatCompat), this throws
// `TypeError: Converting circular structure to JSON` and hides the *real*
// underlying validation error. We replace the line with a circular-safe
// stringify so the operator sees the actual schema problem instead of an
// opaque crash. Idempotent — only patches if the buggy line is still there.
async function patchEslintrcCircularBug(tempDir: string): Promise<void> {
  const path = join(
    tempDir,
    "node_modules",
    "@eslint",
    "eslintrc",
    "lib",
    "shared",
    "config-validator.js",
  );
  let source: string;
  try {
    source = await readFile(path, "utf-8");
  } catch {
    return; // not installed — fine
  }
  const buggy = "const formattedValue = JSON.stringify(error.data);";
  if (!source.includes(buggy)) return; // already patched or version differs
  const safe = `const formattedValue = (() => { const seen = new WeakSet(); try { return JSON.stringify(error.data, (k, v) => { if (typeof v === "object" && v !== null) { if (seen.has(v)) return "[Circular]"; seen.add(v); } return v; }); } catch (e) { return "[Unserializable: " + (e && e.message) + "]"; } })();`;
  const patched = source.replace(buggy, safe);
  await writeFile(path, patched, "utf-8");
  logger.info("[patch] applied circular-safe stringify to @eslint/eslintrc");
}

// === PEER CLOSURE WALKER ===
// After the initial install, walk every installed package's peerDependencies
// and add any missing peers to package.json at the declared range. Re-install
// and repeat until no new peers appear (stable). Cycle-detected via a "seen"
// set across iterations so we never bounce a peer between two ranges forever.
async function readPackageJson(
  path: string,
): Promise<Record<string, any> | null> {
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch {
    return null;
  }
}

async function listInstalledPackageManifests(
  tempDir: string,
): Promise<{ name: string; pkg: Record<string, any> }[]> {
  const nm = join(tempDir, "node_modules");
  const out: { name: string; pkg: Record<string, any> }[] = [];
  let entries: string[];
  try {
    entries = await readdir(nm);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    if (entry.startsWith("@")) {
      let scoped: string[];
      try {
        scoped = await readdir(join(nm, entry));
      } catch {
        continue;
      }
      for (const sub of scoped) {
        const pkg = await readPackageJson(join(nm, entry, sub, "package.json"));
        if (pkg && typeof pkg.name === "string")
          out.push({ name: pkg.name, pkg });
      }
    } else {
      const pkg = await readPackageJson(join(nm, entry, "package.json"));
      if (pkg && typeof pkg.name === "string")
        out.push({ name: pkg.name, pkg });
    }
  }
  return out;
}

async function resolvePeerClosure(
  tempDir: string,
  manifest: { dependencies: Record<string, string> },
): Promise<{ iterations: number; addedTotal: number }> {
  const seen = new Map<string, string>(); // peer name → range we already installed
  let iterations = 0;
  let addedTotal = 0;

  while (true) {
    iterations++;
    const installed = await listInstalledPackageManifests(tempDir);
    const candidates = new Map<string, string>(); // name → range

    for (const { name: ownerName, pkg } of installed) {
      const peers: Record<string, string> = pkg.peerDependencies || {};
      const meta: Record<string, { optional?: boolean }> =
        pkg.peerDependenciesMeta || {};
      for (const [peerName, peerRange] of Object.entries(peers)) {
        if (meta[peerName]?.optional) continue;
        if (manifest.dependencies[peerName]) continue; // already top-level
        if (seen.get(peerName) === peerRange) continue; // already tried this exact range
        // Last-wins on conflicting candidate ranges; log it.
        const prior = candidates.get(peerName);
        if (prior && prior !== peerRange) {
          logger.info(
            `[peer-closure] conflicting ranges for ${peerName}: ${prior} vs ${peerRange} (from ${ownerName}) — using ${peerRange}`,
          );
        }
        candidates.set(peerName, peerRange);
      }
    }

    if (candidates.size === 0) {
      logger.info(
        `[peer-closure] stable after ${iterations} iteration(s); added ${addedTotal} peer(s) total`,
      );
      return { iterations, addedTotal };
    }

    for (const [name, range] of candidates) {
      manifest.dependencies[name] = range;
      seen.set(name, range);
      addedTotal++;
      logger.info(`[peer-closure] +${name}@${range}`);
    }

    await writeFile(
      join(tempDir, "package.json"),
      JSON.stringify(manifest, null, 2),
      "utf-8",
    );
    const proc = Bun.spawn(["bun", "install"], {
      cwd: tempDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    if (code !== 0) {
      const stderr = await new Response(proc.stderr).text();
      throw new Error(
        `[peer-closure] bun install failed at iteration ${iterations}:\n${stderr}`,
      );
    }
  }
}

// === STDERR CLASSIFIER ===
// Recognize known upstream / configuration failure patterns so the operator
// sees a one-line classification instead of a 30-line stack trace.
function classifyMigrationError(stderr: string): string | null {
  if (/Converting circular structure to JSON/.test(stderr)) {
    return "upstream-eslintrc-circular-validator (likely peer-dep mismatch)";
  }
  const missing = stderr.match(/Cannot find module ['"]([^'"]+)['"]/);
  if (missing) return `missing-module:${missing[1]}`;
  const pluginFail = stderr.match(/Failed to load plugin ['"]([^'"]+)['"]/);
  if (pluginFail) return `plugin-load-failure:${pluginFail[1]}`;
  const configResolve = stderr.match(
    /Failed to load config ['"]([^'"]+)['"] to extend from/,
  );
  if (configResolve) return `extends-resolution-failure:${configResolve[1]}`;
  if (/ENOENT/.test(stderr)) return "filesystem-enoent";
  return null;
}

async function runTwoStepMigration(
  tempDir: string,
  configFilename: string,
  source: string,
): Promise<{
  oxlintrcJson: string;
  jsPlugins: string[];
  warnings: string[];
  rawOutput: string;
  manifest: { dependencies: Record<string, string> };
  metadata: { extends: string[]; plugins: string[] };
}> {
  await writeFile(join(tempDir, configFilename), source, "utf-8");

  const metadata = extractConfigMetadata(configFilename, source);

  // 1. Build baseline dep set
  const dependencies: Record<string, string> = {
    ...CORE_ESLINT_DEPS,
    "@eslint/migrate-config": "latest",
    "@oxlint/migrate": "latest",
  };

  // 2. Apply declarative exceptions: `add` first, then `override` on top
  const overrideSources: Record<string, string[]> = {}; // for conflict logging
  for (const ext of metadata.extends) {
    const injection = EXTENDS_INJECTION_MAP[ext];
    if (!injection) continue;
    for (const spec of injection.add) {
      const name = typeof spec === "string" ? spec : spec.name;
      const version = typeof spec === "string" ? "latest" : spec.version;
      dependencies[name] = version;
    }
    if (injection.override) {
      for (const [name, version] of Object.entries(injection.override)) {
        const prior = dependencies[name];
        if (prior && prior !== version) {
          (overrideSources[name] ||= []).push(`${ext}→${version}`);
          logger.info(
            `[manifest] override conflict on ${name}: was ${prior}, now ${version} (from ${ext})`,
          );
        }
        dependencies[name] = version;
      }
    }
  }

  const manifest = {
    name: "oxc-migrate-temp",
    private: true,
    dependencies,
  };

  // 3. Initial install
  await writeFile(
    join(tempDir, "package.json"),
    JSON.stringify(manifest, null, 2),
    "utf-8",
  );
  await Bun.spawn(["bun", "install"], { cwd: tempDir }).exited;
  await patchEslintrcCircularBug(tempDir);

  // 4. Walk peer closure until stable
  await resolvePeerClosure(tempDir, manifest);
  await patchEslintrcCircularBug(tempDir);

  let currentConfig = configFilename;

  if (isLegacyEslintrc(configFilename)) {
    logger.info(`→ Running @eslint/migrate-config on ${configFilename}`);
    const proc = Bun.spawn(["bunx", "@eslint/migrate-config", configFilename], {
      cwd: tempDir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    await proc.exited;

    logger.info(`[migrate-config|stdout]\n${stdout}`);
    if (stderr) logger.info(`[migrate-config|stderr]\n${stderr}`);

    const flatPath = join(tempDir, "eslint.config.mjs");
    if (await Bun.file(flatPath).exists()) currentConfig = "eslint.config.mjs";

    // Critical: re-install after migration tool generates the flat config
    await Bun.spawn(["bun", "install"], { cwd: tempDir }).exited;
    await patchEslintrcCircularBug(tempDir);
  }

  // Flat → Oxlint
  logger.info(`→ Running @oxlint/migrate on ${currentConfig}`);
  const proc = Bun.spawn(
    [
      "bunx",
      "@oxlint/migrate",
      currentConfig,
      "--output-file",
      ".oxlintrc.json",
      "--js-plugins",
      "--details",
    ],
    { cwd: tempDir, stdout: "pipe", stderr: "pipe" },
  );

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  await proc.exited;

  const rawOutput = `STDOUT:\n${stdout}\n\nSTDERR:\n${stderr}`;

  const oxlintrcPath = join(tempDir, ".oxlintrc.json");
  if (await Bun.file(oxlintrcPath).exists()) {
    const oxlintrcJson = await Bun.file(oxlintrcPath).text();
    let jsPlugins: string[] = [];
    try {
      const p = JSON.parse(oxlintrcJson);
      jsPlugins = Array.isArray(p.jsPlugins) ? p.jsPlugins : [];
    } catch {}
    return {
      oxlintrcJson,
      jsPlugins,
      warnings: stderr.split("\n").filter(Boolean),
      rawOutput,
      manifest,
      metadata,
    };
  }

  // Attach the manifest + metadata to the thrown error so the failure handler
  // in normalizeOne can produce a fully-contextual structured log.
  const err = new Error(`Migration failed:\n${rawOutput}`) as Error & {
    stdout?: string;
    stderr?: string;
    manifest?: typeof manifest;
    metadata?: typeof metadata;
  };
  err.stdout = stdout;
  err.stderr = stderr;
  err.manifest = manifest;
  err.metadata = metadata;
  throw err;
}

async function normalizeOne(
  db: Db,
  raw: { full_name: string; filename: string; content_hash: string },
) {
  const { full_name, filename, content_hash } = raw;
  logger.info(
    `\n=== Processing ${full_name}/${filename} (${content_hash}) ===`,
  );

  const source = getConfigContent(db, content_hash);
  if (!source) throw new Error("Config blob missing");

  if (isOxlintNativeJson(filename)) {
    logger.info("→ Native Oxlint JSON → direct mapping");
    const normalized = buildNormalizedFromOxlintrc(source, full_name);
    normalized.rawSource = source;
    const normalizedJson = JSON.stringify(normalized);
    saveNormalizedConfig(db, full_name, filename, content_hash, normalizedJson);
    logger.info(`✅ Saved normalized config`);
    return;
  }

  if (isOxlintTs(filename)) {
    logger.info(`→ Skipping TS Oxlint config (${filename}) — will retry later`);
    return; // NO row created
  }

  if (isLegacyEslintrc(filename) || isFlatEslintConfig(filename)) {
    logger.info(
      "→ ESLint config → two-step migration (legacy → flat → oxlint)",
    );
    const tempDir = await mkdtemp(join(tmpdir(), "oxc-migrate-"));
    try {
      const result = await runTwoStepMigration(tempDir, filename, source);
      const normalized = {
        ...buildNormalizedFromOxlintrc(result.oxlintrcJson, full_name),
        jsPlugins: result.jsPlugins,
        migrationWarnings: result.warnings.length ? result.warnings : undefined,
        rawSource: result.oxlintrcJson,
      };
      const normalizedJson = JSON.stringify(normalized);
      saveNormalizedConfig(
        db,
        full_name,
        filename,
        content_hash,
        normalizedJson,
      );
      logger.info(
        `✅ Migration succeeded → ${result.jsPlugins.length} jsPlugins, ${normalized.blocks.length} blocks`,
      );
    } catch (err: any) {
      const stderr: string = err?.stderr ?? "";
      const stdout: string = err?.stdout ?? "";
      const manifest = err?.manifest;
      const metadata = err?.metadata;
      const classified =
        classifyMigrationError(stderr) ||
        classifyMigrationError(err?.message ?? "") ||
        "unrecognized";

      const depsPretty = manifest?.dependencies
        ? JSON.stringify(manifest.dependencies, null, 2)
        : "(unavailable — failed before manifest was finalized)";

      const lines = [
        "",
        "============================================================",
        "NORMALIZATION FAILURE — config not saved, advance is gated",
        "============================================================",
        `REPO:        ${full_name}`,
        `FILE:        ${filename}`,
        `HASH:        ${content_hash}`,
        `EXTENDS:     [${(metadata?.extends ?? []).join(", ")}]`,
        `PLUGINS:     [${(metadata?.plugins ?? []).join(", ")}]`,
        `DEPS TRIED:  ${depsPretty}`,
        `CLASSIFIED:  ${classified}`,
        "----- STDOUT -----",
        stdout || "(empty)",
        "----- STDERR -----",
        stderr || err?.message || "(empty)",
        "============================================================",
      ];
      logger.error(lines.join("\n"));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
    return;
  }

  logger.warn(`→ Unknown config type (will retry): ${filename}`);
}

// Wait for a single newline on stdin without consuming all of stdin to EOF.
// `Bun.stdin.text()` reads until EOF (Ctrl-D), which is why hitting ENTER
// alone never advanced. readline.question resolves on the first newline.
function waitForEnter(prompt: string): Promise<void> {
  return new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

export function startNormalizationStage(db: Db) {
  return async () => {
    logger.info(
      "Normalization stage started (interactive, 1 config at a time)",
    );

    while (true) {
      const pending = getUnprocessedRawConfigs(db, 1);
      if (pending.length === 0) {
        logger.info("No unprocessed configs. Sleeping 10s...");
        await Bun.sleep(10000);
        continue;
      }

      await normalizeOne(db, pending[0]!);

      await waitForEnter("\nPress ENTER to continue to next config... ");
    }
  };
}
