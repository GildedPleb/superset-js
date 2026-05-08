// Canonical shape of a normalized linter config row. Downstream stages
// (voting, conflict resolution, publishing) read from this.

export interface RuleSetting {
  severity: 0 | 1 | 2;
  optionsJson: string | null;
}

export interface ConfigBlock {
  // null for the base block; otherwise the override glob the user wrote.
  files: string | string[] | null;
  rules: Record<string, RuleSetting>;
}

export interface NormalizedConfig {
  repoId: string;
  blocks: ConfigBlock[];
  jsPlugins: string[];
  normalizedAt: Date;
  rawSource: string;
}
