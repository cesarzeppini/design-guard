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

The config gets the same treatment. Ignoring a directory in `design-guard.config` silences it just as surely as approving everything in it, so `--added-markers` also reports config edits that narrow the check: a directory added to `components-ignore`, one removed from `components`, or `typography-base` switched off. It also reports any change to `allowed-customization.md`: an exception written there is approval too, so only a human adds one.

## What it catches

| # | Violation | Example |
|---|---|---|
| 1 | Raw HTML for core UI | `<button>`, `<input>`, hand-rolled modals |
| 2 | Off-system component | a component with no `@approved` marker, a duplicate of one that has it, or a variant it doesn't have (`<Button variant="ghostly">`) |
| 3 | Appearance override on an approved component | `<Card className="bg-muted">` — **semantic tokens included** — or `<Button {...props}>`, which forwards any caller's `className` (form wiring like `{...field}` is allowed) |
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
      - uses: actions/checkout@v7
      - uses: cesarzeppini/design-guard@v0.3.0
        with:
          path: src
```

The job fails on any violation. Instructions to a model are advice; a failing check is enforcement. This is the piece that holds even when the assistant doesn't follow the rules.

On pull requests it also runs the **approvals check** (`--added-markers` against the PR's base branch). This catches any PR that changes *what counts as approved*: a new `@approved` marker, a config edit that narrows the check, a change to `allowed-customization.md`, or a change to CODEOWNERS. Those items are listed in the job summary, and the job fails.

That failure is deliberate, even when a person really did ask for the approval. The check can't tell who asked, so it makes sure a human looks before merging. The intended flow is that the reviewer reads the summary, confirms each item was requested, and merges anyway. If a red check on every approval is too much, report it as a warning instead:

```yaml
      - uses: cesarzeppini/design-guard@v0.3.0
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
node scripts/ds-lint.mjs --added-markers main...HEAD  # markers, narrowed config, exceptions, CODEOWNERS
node scripts/ds-lint.mjs --codeowners @org/team     # CODEOWNERS lines for everything that decides approval
```

`--approve` only writes inside your configured component directories and refuses anything else. An optional `--serve` mode exists for one-click buttons on the page, but it needs Node running next to your dev server and is not required.

## Exit codes

`0` clean · `1` violations found. `--registry` always exits `0` (inventory, not a finding). `--added-markers <range>` exits `1` if any markers were added, the config was narrowed, or `allowed-customization.md` or CODEOWNERS changed.

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
