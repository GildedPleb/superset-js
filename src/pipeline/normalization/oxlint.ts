// Native oxlint JSON normalizer. Direct mapping; throws on anything we
// don't yet support. The loop in `index.ts` catches throws, logs the
// failure block, and gates on ENTER. No silent passes.
//
// Currently supported top-level keys: `rules`, `overrides`, `plugins`,
// `env`, `globals`, `settings`, `ignorePatterns`. The last four are
// accepted but not extracted into NormalizedConfig (they don't affect
// rule signal). Anything else throws so we discover real-world shape
// variation deliberately.

import type { ConfigBlock, NormalizedConfig, RuleSetting } from "./types";

const KNOWN_KEYS = new Set([
  "rules",
  "overrides",
  "plugins",
  "env",
  "globals",
  "settings",
  "ignorePatterns",
  "$schema",
]);

function normalizeSeverity(val: unknown): RuleSetting {
  if (typeof val === "number") {
    return {
      severity: Math.max(0, Math.min(2, val)) as 0 | 1 | 2,
      optionsJson: null,
    };
  }
  if (typeof val === "string") {
    const map: Record<string, 0 | 1 | 2> = {
      off: 0,
      allow: 0,
      warn: 1,
      error: 2,
      deny: 2,
    };
    if (!(val in map)) {
      throw new Error(`Unknown severity string: ${JSON.stringify(val)}`);
    }
    return { severity: map[val]!, optionsJson: null };
  }
  if (Array.isArray(val)) {
    const [sev, ...rest] = val;
    const head = normalizeSeverity(sev);
    const opts = rest.length === 0 ? null : rest.length === 1 ? rest[0] : rest;
    return {
      severity: head.severity,
      optionsJson: opts != null ? JSON.stringify(opts) : null,
    };
  }
  throw new Error(`Unrecognized rule value: ${JSON.stringify(val)}`);
}

function mapRules(rules: unknown): Record<string, RuleSetting> {
  if (rules == null) return {};
  if (typeof rules !== "object" || Array.isArray(rules)) {
    throw new Error(`'rules' must be an object, got ${typeof rules}`);
  }
  const out: Record<string, RuleSetting> = {};
  for (const [name, val] of Object.entries(rules)) {
    out[name] = normalizeSeverity(val);
  }
  return out;
}

export function normalizeOxlint(
  source: string,
  repoId: string,
): NormalizedConfig {
  const parsed: unknown = JSON.parse(source); // throws on invalid JSON

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Top-level config must be an object`);
  }
  const cfg = parsed as Record<string, unknown>;

  // Discover any key we haven't handled yet — fail loud so we add it
  // deliberately when we see real-world configs use it.
  for (const key of Object.keys(cfg)) {
    if (!KNOWN_KEYS.has(key)) {
      throw new Error(
        `Unknown top-level oxlint key: '${key}'. Add it to KNOWN_KEYS in oxlint.ts after deciding how to handle it.`,
      );
    }
  }

  const blocks: ConfigBlock[] = [];
  blocks.push({ files: null, rules: mapRules(cfg.rules) });

  if (cfg.overrides !== undefined) {
    if (!Array.isArray(cfg.overrides)) {
      throw new Error(`'overrides' must be an array`);
    }
    for (const ov of cfg.overrides) {
      if (ov === null || typeof ov !== "object" || Array.isArray(ov)) {
        throw new Error(`Each override must be an object`);
      }
      const o = ov as Record<string, unknown>;
      const files = o.files;
      if (
        files !== undefined &&
        typeof files !== "string" &&
        !Array.isArray(files)
      ) {
        throw new Error(`override.files must be string or string[]`);
      }
      blocks.push({
        files: (files ?? null) as string | string[] | null,
        rules: mapRules(o.rules),
      });
    }
  }

  let jsPlugins: string[] = [];
  if (cfg.plugins !== undefined) {
    if (!Array.isArray(cfg.plugins)) {
      throw new Error(`'plugins' must be an array of strings`);
    }
    jsPlugins = cfg.plugins.filter((p): p is string => typeof p === "string");
  }

  return {
    repoId,
    blocks,
    jsPlugins,
    normalizedAt: new Date(),
    rawSource: source,
  };
}
