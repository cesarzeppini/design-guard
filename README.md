![Design Guard](assets/cover.png)

# Design Guard

**Keep AI-generated UI inside your design system.**

It keeps AI output consistent with the design decisions you've already made. It doesn't judge whether the result is good design (see [What it doesn't do](#what-it-doesnt-do)).

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

The config gets the same treatment. Ignoring a directory in `design-guard.config` silences it just as surely as approving everything in it, so `--added-markers` also reports config edits that narrow the check: a directory added to `components-ignore`, one removed from `components`, or `typography-base` switched off. It also reports any change to `allowed-customization.md`: an exception written there is approval too, so only a human adds one.

### Phasing a component out

Approval has one more state: `@deprecated`, in the same 5-line window, optionally naming the replacement.

```tsx
// @approved
// @deprecated → NewCard
export function Card(...) { ... }
```

Every use of a deprecated component is flagged with its replacement, the registry and the /components page list it apart with its remaining usage count (the migration left), and `--added-markers` reports deprecations added, lifted or changed. Only a human deprecates.

## What it catches

| # | Violation | Example |
|---|---|---|
| 1 | Raw HTML for core UI | `<button>`, `<input>`, `<div role="button" onClick>`, hand-rolled modals. A link styled as a button gets a warning that doesn't fail the check. |
| 2 | Off-system component | a component with no `@approved` marker, a duplicate of one that has it, a variant it doesn't have (`<Button variant="ghostly">`), or a component marked `@deprecated` |
| 3 | Appearance override on an approved component | `<Card className="bg-muted">` — **semantic tokens included** — or `<Button {...props}>`, which forwards any caller's `className` (form wiring like `{...field}` is allowed) |
| 3b | A colour that isn't one of your tokens | `<div className="bg-brand-legacy">` when the project's CSS defines no `brand-legacy` colour. Tokens are read from `--color-*` (`@theme`) and colour variables like `--primary`. |
| 4 | Typography utilities on semantic elements | `<h1 className="text-2xl font-semibold">` when the base layer already styles `h1` |

Layout classes (`mt-4`, `flex`, `max-w-md`) stay legal. See [`skill/allowed-customization.md`](skill/allowed-customization.md).

An override on an approved component isn't treated as a style problem. It's a signal the component is missing a variant, so it gets parked and a variant is proposed.

## What it doesn't do

Design Guard checks what's **written** against decisions your team has **already made**: which components are approved, which variants and tokens exist. It's deliberately narrow, and it doesn't replace these:

| Not covered | Why | Pair it with |
|---|---|---|
| Visual QA: does it look right? | It reads source code, not the rendered page. Fully compliant code can still look wrong. | Screenshot or visual-regression tests, such as Playwright `toHaveScreenshot()` or Chromatic |
| UX and layout judgement | Whether the button is in the right place, the hierarchy makes sense or the flow is intuitive is a design review question. | Design review |
| Accessibility audit | It flags clickable `div`s and hand-rolled roles because they bypass your components, but it doesn't check contrast, labels or focus order. | `eslint-plugin-jsx-a11y`, axe |
| Responsive behaviour | Nothing is rendered at any screen size. | Visual tests at several viewports |
| Whether your design system is right | It enforces the approved set as-is. If the closest component doesn't fit, the assistant parks the case for a human instead of forcing it. | Your design-system owners |

Two interfaces can both pass Design Guard while one is well designed and the other isn't. What it guarantees is that both were built from your system, not from improvised copies of it.

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

## Adopting it on an existing codebase

On a project that has been running for a while, the first lint finds everything at once, and a CI check that fails from day one is a check people turn off. Record today's findings as a baseline instead:

```bash
node scripts/ds-lint.mjs src --baseline-write   # writes design-guard.baseline.json; commit it
```

From then on the check (locally and in the Action) fails only on findings that aren't in the baseline, and says how many recorded ones it skipped. Findings are matched without line numbers, so edits elsewhere in a file don't resurface them. When some get fixed, the run says so; re-run `--baseline-write` to shrink the file and lock that in. `--no-baseline` shows everything.

Writing or growing the baseline is approval in bulk, so it's treated like a marker: `--added-markers` (and the Action's approvals check) reports every entry it gains, and `--codeowners` covers the file. Configuration problems, such as an unlisted component folder, are never recorded.

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
      - uses: actions/checkout@v7
      - uses: cesarzeppini/design-guard@v0.8.1
        with:
          path: src
```

The job fails on any violation. Instructions to a model are advice; a failing check is enforcement. This is the piece that holds even when the assistant doesn't follow the rules.

On pull requests it also runs the **approvals check** (`--added-markers` against the PR's base branch). This catches any PR that changes *what counts as approved*: a new `@approved` marker, a config edit that narrows the check, a change to `allowed-customization.md`, or a change to CODEOWNERS. Those items are listed in the job summary, and the job fails.

That failure is deliberate, even when a person really did ask for the approval. The check can't tell who asked, so it makes sure a human looks before merging. The intended flow is that the reviewer reads the summary, confirms each item was requested, and merges anyway. If a red check on every approval is too much, report it as a warning instead:

```yaml
      - uses: cesarzeppini/design-guard@v0.8.1
        with:
          path: src
          fail-on-approvals: false   # list approvals in the summary, don't fail
```

| Input | Default | |
|---|---|---|
| `path` | `src` | what to lint |
| `working-directory` | `.` | project root, where `design-guard.config` lives |
| `check-approvals` | `true` | run the approvals check on pull requests |
| `base` | the PR's base branch | branch to compare against; set it to run the check on push events too |
| `fail-on-approvals` | `true` | `false` reports approvals as a warning instead of failing |

A shallow checkout (the `actions/checkout` default) works: the action fetches the history it needs. `fetch-depth: 0` on checkout skips that step.

### Make it a hard gate (GitHub settings)

CI *detects* a change to what counts as approved. Anyone with write access can still merge past a red check. To make approval a reviewed act, add two GitHub settings:

**1. CODEOWNERS.** Every file that decides approval gets an owner. Generate the lines from your config:

```bash
node scripts/ds-lint.mjs --codeowners @your-org/design-system
```

```
/src/components/ui/ @your-org/design-system
/design-guard.config @your-org/design-system
/.claude/skills/design-guard/allowed-customization.md @your-org/design-system
/.github/CODEOWNERS @your-org/design-system
```

Paste them at the end of `.github/CODEOWNERS`. Later lines win, so they override a broader `*` rule above them. The list covers:
- the component folders, where the markers live
- the config, including `design-guard.config` before it exists, because creating one overrides keys kept in `context/STACK.md`
- every `allowed-customization.md`
- the CODEOWNERS file itself

Re-run the command when `components:` changes.

**2. Branch protection** (Settings → Branches, or Rules → Rulesets, on your main branch):
- **Require a pull request before merging** → **Require review from Code Owners**
- **Require status checks to pass** → add the job that runs Design Guard (`guard` in the example above)

After that, an AI-approved component can't be merged without a design-system owner's review. Deleting or disabling the workflow doesn't get around it either: a required check that never reports leaves the PR blocked. See GitHub's docs on [CODEOWNERS](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners) and [protected branches](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).

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

- `components` defaults to `src/components/ui`. Imports are matched by directory tail, so `@/`, `~/` and relative paths all resolve. Relative paths are also resolved against the importing file, so `../ui/button` from a sibling folder counts.
- Component directories that exist but are neither listed nor ignored are reported — an unscanned directory would otherwise pass silently.
- `typography-base` gates check 4. If absent, the guard looks at your CSS and tells you which way it should be set.

It falls back to `context/STACK.md` if that's where you keep project facts.

## Commands

```bash
node scripts/ds-lint.mjs src                    # lint
node scripts/ds-lint.mjs src --baseline-write   # record today's findings; later runs fail only on new ones
node scripts/ds-lint.mjs src --no-baseline      # lint, showing recorded findings too
node scripts/ds-lint.mjs --registry             # approved / in use / unused
node scripts/ds-lint.mjs --scan                 # every component as JSON
node scripts/ds-lint.mjs --approve <file...>    # add the @approved marker
node scripts/ds-lint.mjs --unapprove <file...>  # remove it
node scripts/ds-lint.mjs --added-markers main...HEAD  # markers, deprecations, narrowed config, exceptions, CODEOWNERS, baseline growth
node scripts/ds-lint.mjs --codeowners @org/team     # CODEOWNERS lines for everything that decides approval
```

`--approve` only writes inside your configured component directories and refuses anything else. An optional `--serve` mode exists for one-click buttons on the page, but it needs Node running next to your dev server and is not required.

## Exit codes

`0` clean · `1` violations found. Warnings never change the exit code. `--registry` always exits `0` (inventory, not a finding). `--added-markers <range>` exits `1` if any markers were added, the config was narrowed, or `allowed-customization.md` or CODEOWNERS changed.

## Why Node, not shell

The first version was a shell script and shipped four bugs of kinds only shell has — a glob pair failing when one side missed, a `sed` delimiter colliding with data, a path prefix leaking into a match, `grep -i` applying in one branch but not another. Each produced a *silent wrong answer* rather than an error, the worst failure mode for a check. The Node rewrite has tests (`npm test`), and every case in them is a bug this check actually shipped.

## Known limits

- React/JSX (`.tsx`, `.jsx`) only today.
- The components page needs Vite (it reads source with `import.meta.glob`). Next.js and others would need the `--scan` JSON instead.
- A design system that lives in a different repo isn't seen by the guard — it only checks components in your configured local directories.
- The page's stats don't yet count appearance overrides, only raw HTML elements.
- A literal `>` inside a plain string prop (`title="a > b"`) can end the tag scan early.
- It checks what's written, not what renders. Classes built in code are read where they can be resolved in the file: `cn()` / `clsx()` arguments, both sides of `&&` and `? :`, template literals and same-file string constants. A class that comes from a prop, an import or a function's return value isn't seen.

## Origin

Extracted from [Found](https://github.com/cesarzeppini), a framework for running a feature from spec to ship with AI agents, where this check runs on every UI slice.

## License

MIT
