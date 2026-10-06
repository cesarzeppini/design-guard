![Design Guard](assets/cover.png)

# Design Guard

**Keep AI-generated UI inside your design system.**

AI coding tools are fast and they drift. Ask for a dashboard and you get a raw `<button>`, a hex color, `<Card className="bg-muted rounded-xl">`, `<h1 className="text-2xl font-semibold">` — each one plausible, none of them your system. Design Guard stops that.

It has two halves that work together:

- **The rules** (`skill/SKILL.md`): instructions for an AI assistant. Use only approved components, never override their appearance, park anything ambiguous instead of guessing.
- **The linter** (`scripts/ds-lint.mjs`): a dependency-free Node script that catches the mechanical violations deterministically, so the result doesn't depend on the model remembering the rules.

```
$ node scripts/ds-lint.mjs src

== raw interactive HTML element
src/routes/dashboard.tsx:12:  <button onClick={() => save()}>Save</button>

== typography utilities on semantic text elements
src/routes/dashboard.tsx:9: <h1> text-2xl (text size) — the base layer already sets this

== appearance override on a design-system component
src/routes/dashboard.tsx:10: <Card> bg-muted (background)

== component used but not marked @approved
src/routes/dashboard.tsx  ->  components/ui/stat-tile
```

## The core idea: approval is a marker, and only a human adds it

A component is approved when its own file says so in the first 5 lines:

```tsx
// @approved
export function Button(...) { ... }
```

No registry page to maintain, no list to keep in sync. The approved set is whatever carries the marker, found by scanning at check time.

**An agent never adds the marker on its own.** If it could, it would approve whatever it just invented and the guard would become a mirror. Every marker added in a diff is reported, and `ds-lint --added-markers main...HEAD` detects them mechanically instead of trusting anyone to self-report.

## What it catches

| # | Violation | Example |
|---|---|---|
| 1 | Raw HTML for core UI | `<button>`, `<input>`, hand-rolled modals |
| 2 | Off-system component | a component with no `@approved` marker, or a duplicate of one that has it |
| 3 | Appearance override on an approved component | `<Card className="bg-muted">` — **semantic tokens included** |
| 4 | Typography utilities on semantic elements | `<h1 className="text-2xl font-semibold">` when the base layer already styles `h1` |

Layout classes (`mt-4`, `flex`, `max-w-md`) stay legal. See [`skill/allowed-customization.md`](skill/allowed-customization.md).

An override on an approved component isn't treated as a style problem. It's a signal the component is missing a variant, so it gets parked and a variant is proposed.

## Try it in 30 seconds

```bash
git clone https://github.com/cesarzeppini/design-guard
cd design-guard/examples/demo
node ../../scripts/ds-lint.mjs src
```

The demo contains one of each violation. You'll see each caught, with file and line. Then:

```bash
node ../../scripts/ds-lint.mjs --registry src
```

prints what's approved, what's unmarked but in use (each one a decision waiting for you), and a count of unmarked-and-unused files.

## The /components page

A dev-only route inside your own project that shows what's approved and what's waiting for a decision — status badges, usage counts, variants and props, adoption stats, and an Approve / Revoke button on every component.

The buttons don't edit files. They **copy a prompt**; you paste it into your AI chat (Lovable, Claude Code, Cursor…) and the assistant adds or removes the marker. You decide, the assistant types. A first-time guide on the page explains this, and an **Approve all in use** button sets your current components as the starting point so only *new* drift gets flagged.

Add it by pasting this into your AI assistant:

> Add the Design Guard components page to this project. Copy `template/Components.tsx`, `scripts/scan-core.mjs` and `scripts/scan-core.d.mts` from https://github.com/cesarzeppini/design-guard into `src/design-guard/`. Set `COMPONENT_DIRS` in `Components.tsx` to my components folder. Register `/components` as a route **only when `import.meta.env.DEV` is true** (lazy-loaded), so it never ships to production. Don't use my design-system components inside it.

Needs Vite + React + TypeScript. Not yet verified inside Lovable — tell me what breaks.

## Install

The linter needs Node 18+ and nothing else. No `npm install`.

### In CI (recommended — this is the hard gate)

```yaml
# .github/workflows/design-guard.yml
name: Design Guard
on: [pull_request]
jobs:
  guard:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: cesarzeppini/design-guard@v0.1.0
        with:
          path: src
```

The job fails on any violation. Instructions to a model are advice; a failing check is enforcement. This is the piece that holds even when the assistant doesn't follow the rules.

### With Claude Code

Copy `skill/` into your project as `.claude/skills/design-guard/`, and copy `scripts/` to the project root (the skill calls `node scripts/ds-lint.mjs`). The assistant runs the linter itself at the end of UI tasks.

### With tools that can't run scripts (Lovable, most chat UIs)

Add `skill/SKILL.md` and `skill/allowed-customization.md` to the tool's project instructions or knowledge. The rules still steer the model, but the linter won't run inside the tool, and model judgment alone is the weaker mode. Run the linter yourself on the exported repo, or in CI as above, for real enforcement. Also restate in your prompt: *never add `@approved` unless I ask.*

## Config

Optional. Put it in `design-guard.config` at the project root:

```
components: src/components/ui        # comma-separated if several
components-ignore: src/components/icons
typography-base: true                # does your CSS base layer style h1–h6, p, a…?
```

- `components` defaults to `src/components/ui`. Imports are matched by directory tail, so `@/`, `~/` and relative paths all resolve.
- Component directories that exist but are neither listed nor ignored are reported — an unscanned directory would otherwise pass silently.
- `typography-base` gates check 4. If absent, the guard looks at your CSS and tells you which way it should be set.

It falls back to `context/STACK.md` if that's where you keep project facts.

## Commands

```bash
node scripts/ds-lint.mjs src                    # lint
node scripts/ds-lint.mjs --registry             # approved / in use / unused
node scripts/ds-lint.mjs --scan                 # every component as JSON
node scripts/ds-lint.mjs --approve <file...>    # add the @approved marker
node scripts/ds-lint.mjs --unapprove <file...>  # remove it
node scripts/ds-lint.mjs --added-markers main...HEAD
```

`--approve` only writes inside your configured component directories and refuses anything else. An optional `--serve` mode exists for one-click buttons on the page, but it needs Node running next to your dev server and is not required.

## Exit codes

`0` clean · `1` violations found. `--registry` always exits `0` (inventory, not a finding). `--added-markers <range>` exits `1` if any markers were added.

## Why Node, not shell

The first version was a shell script and shipped four bugs of kinds only shell has — a glob pair failing when one side missed, a `sed` delimiter colliding with data, a path prefix leaking into a match, `grep -i` applying in one branch but not another. Each produced a *silent wrong answer* rather than an error, the worst failure mode for a check. The Node rewrite has tests (`npm test`), and every case in them is a bug this check actually shipped.

## Known limits

- React/JSX (`.tsx`, `.jsx`) only today.
- The components page needs Vite (it reads source with `import.meta.glob`). Next.js and others would need the `--scan` JSON instead.
- A design system that lives in a different repo isn't seen by the guard — it only checks components in your configured local directories.
- The page's stats don't yet count appearance overrides, only raw HTML elements.
- A literal `>` inside a plain string prop (`title="a > b"`) can end the tag scan early.
- It checks what's written, not what renders. It won't catch an override built from a dynamic `className` expression.

## Origin

Extracted from [Found](https://github.com/cesarzeppini), a framework for running a feature from spec to ship with AI agents, where this check runs on every UI slice.

## License

MIT
