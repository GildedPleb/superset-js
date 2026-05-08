# Extending Normalization

This is the operating manual for extending `src/pipeline/normalization/`.
It is **not** a list of fixes. It is the rule set and the principles.
The fixes belong in code, with their reasons inline, beside the lines
they justify.

Read this end-to-end before changing anything.

---

## 1. The contract

Normalization runs one row at a time. The loop is exactly four steps:

1. Pull one un-normalized config row, restricted by SQL to filenames the
   pipeline currently supports.
2. Run it through the matching normalizer.
3. **On failure**: log the failure block, **gate on ENTER**, do not write.
4. **On success**: log the result, **gate on ENTER**, then write.

That is the whole contract. Two invariants must always hold:

- **Idempotent.** Failure and Ctrl-C-before-ENTER both leave the row
  eligible for the next iteration. Nothing is ever half-written.
- **Operator-supervised.** Every row that the pipeline *attempts* gates
  on ENTER. Rows the pipeline does not attempt (filtered out by SQL) are
  silently skipped — no log, no gate, no work.

If a change you're considering would weaken either invariant, stop.

---

## 2. The principles

These apply to every change in this folder.

- **KISS.** The simplest thing that works for the case in front of you.
- **YAGNI.** No code for a case that isn't represented by a real config
  in the corpus. Hypothetical robustness is anti-robustness; it expands
  surface area for nothing.
- **DRY only after rule-of-three.** Two similar things stay duplicated.
  Three become a helper. Abstracting at two destroys readability for
  speculative reuse.
- **Fail loud.** Every unrecognized shape, every unknown key, every
  unexpected value: throw. The loop catches, logs the source, gates.
  Silent fallbacks corrupt the corpus.
- **One supported path at a time.** Finish a path completely (every row
  of that kind in the DB normalized end-to-end) before starting another.
- **Source-level documentation, not folder-level.** Reasons live as
  inline comments at the line that needs them. This document is the
  framework; the comments are the journal.

---

## 3. The shape of an extension

There are exactly two kinds of extensions. Both are small.

### 3a. Extending a *supported* path to handle a new config shape

A config of an already-supported kind throws because the normalizer
doesn't recognize some part of it. Pattern: add the smallest piece of
code that handles that part, with an inline comment naming the failing
repo and the reason.

Example shapes that fall here:
- A new top-level key in an oxlint config (`categories`, `extends`,
  `formatter`, etc.).
- A new severity-string spelling (`"deny"` vs `"error"`).
- A new override field shape.
- A new file extension variant of the same kind.

Where the change goes: **inside the normalizer for that kind**
(`oxlint.ts`, eventually `eslint.ts`, etc.). Not a new file. Not a new
abstraction. Add it where it's used.

If the same shape variation appears across **three or more** config
kinds, then — and only then — extract it to a shared helper. Until
then, duplication is correct.

### 3b. Extending the pipeline to support a *new* config kind

Adding eslint, prettier, biome, native oxlint TS, etc. Pattern:

1. **Add a normalizer module.** `eslint.ts`, `prettier.ts`, etc. It
   exports a single function with the same shape as `normalizeOxlint`:
   `(source: string, repoId: string) => NormalizedConfig`. It throws
   on anything it doesn't recognize.
2. **Widen the SQL filter** in `getUnprocessedRawConfigs` to include
   the new kind's filenames.
3. **Add a dispatch branch** in `index.ts`'s `dispatch` function.

That's it. The loop, the gating, the logging, the failure semantics —
all unchanged. Each new kind is self-contained.

The current shape of `dispatch` is the template:

```ts
function dispatch(filename, source, fullName) {
  if (filename === ".oxlintrc.json" || filename === "oxlintrc.json") {
    return { kind: "supported", result: normalizeOxlint(source, fullName) };
  }
  return { kind: "unsupported" };
}
```

Adding a kind is one `if` branch. Resist the urge to refactor this into
a registry until the rule-of-three triggers.

---

## 4. Where things live

```
src/pipeline/normalization/
  index.ts    — the loop, dispatch, gating, logging
  types.ts    — NormalizedConfig, ConfigBlock, RuleSetting
  oxlint.ts   — normalizer for native oxlint JSON (the only path today)
```

When eslint lands, it adds one file. When biome lands, it adds one file.
The folder grows by one file per kind. Nothing else.

If you find yourself wanting to add a `helpers/`, `utils/`, `shared/`,
or `resolvers/` subdirectory: stop. The rule-of-three has not triggered.

---

## 5. The DB query is the extension surface

`getUnprocessedRawConfigs` in `src/services/db.ts` has a single
`IN (...)` clause that lists every supported filename. Widening this
clause is the formal mechanism by which a new kind enters the pipeline.

Order of operations when adding a new kind:
1. Write the normalizer and its dispatch branch first.
2. Test against a known-good config from the corpus by inserting a row
   into `normalized_configs` manually if needed, or by widening the
   filter and letting one row through.
3. Only widen the SQL filter once the normalizer handles the simplest
   real config of that kind end-to-end.

This ordering matters because the moment the SQL filter widens, the
loop will start gating on rows of the new kind. You don't want that
until the normalizer is at least a draft.

---

## 6. The failure block is the debugging interface

When a row fails, the operator sees:

- `REPO`, `FILE`, `HASH` for unique identification.
- `ERROR` line — the exception message.
- Full `SOURCE` — the raw config text.
- Full `STACK` — to find the line in the normalizer that threw.

This is by design. The operator (human or AI agent) gets everything
they need to write the fix without re-fetching the source.

When extending the framework, **preserve this property**. Any new
normalizer should throw an `Error` with a message specific enough that
the agent can locate the right place to extend. "Unknown top-level
oxlint key: 'categories'" is good. "Bad config" is not.

---

## 7. What never changes without explicit user direction

- **DB schema.** Don't add columns. Don't change indices. Don't add
  tables. The schema is shared across all stages and migrations are
  out of scope for this folder.
- **Other pipeline stages** (acquisition, discovery, retention). They
  are independent. If a normalization need would require touching them
  (e.g., "we need a new sidecar file"), surface that as a separate
  decision, don't quietly couple the stages.
- **The contract in §1.** Specifically: never introduce a path that
  saves without ENTER, never introduce a path that fails without ENTER,
  never introduce a path that prints without skipping for unsupported
  kinds.
- **AGENTS.md invariants.** No deps unless explicitly approved. Bun
  natives only. Single concurrent process. Data-driven progression.

---

## 8. What you change all the time

- **`oxlint.ts`** (and future per-kind files) when a new shape variant
  surfaces. Add a case, add an inline comment naming the repo, ship.
- **The `KNOWN_KEYS` set in oxlint.ts** when a new top-level key is
  legitimate and you've decided how to handle it.
- **The SQL `IN` clause** when a new kind lands.
- **The `dispatch` function in index.ts** when a new kind lands.

These are small, focused, and low-risk because the loop's gating model
catches mistakes immediately.

---

## 9. The per-fix cadence

When the failure block lands in front of you:

1. Read the `ERROR` line.
2. Locate the throw site from `STACK`.
3. Decide: is this a §3a extension (handle a new shape) or §3b
   extension (new kind)?
4. Make the smallest change that makes the row pass — no speculative
   robustness.
5. Add an inline comment naming the repo (`HASH:` field) and what shape
   you're handling.
6. Re-run; verify the same row now succeeds; ENTER.
7. Move on.

If a single row takes more than three iterations, stop and ask the
user. You're probably either fighting a config that is genuinely
unsupportable (private deps, broken JSON), or trying to abstract
prematurely.

---

## 10. The packet for an AI agent

When asking an AI agent to extend the framework, send:

1. **`AGENTS.md`** — pipeline-level invariants.
2. **This file (`extensible.md`)** — the rules.
3. **`src/pipeline/normalization/`** — all three files.
4. **The failure block** — produced by the loop when the offending
   config was attempted.
5. **`src/services/db.ts`** — only if the change requires widening the
   SQL filter (i.e., it's a §3b extension).

Do not send unrelated source. The agent's context should match the
surface of the change.

The agent's deliverable should be:
- A diff that fits §3a or §3b exactly.
- Inline comments at the changed lines explaining *why*, citing the
  failing repo.
- No new files unless §3b applies.
- No abstraction unless rule-of-three has fired.

---

## 11. The golden rule

When in doubt: **fail loud, change one thing, name the repo in a
comment, ship.**

The loop will tell you if you got it wrong. The next config will tell
you if you over-abstracted. Trust the loop.
