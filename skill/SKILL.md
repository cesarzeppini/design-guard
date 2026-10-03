---
name: design-system-guard
description: Final gate before finishing any UI task. Keeps every interface built from approved components and tokens instead of one-off styling. Approval is a marker in the component's own file (@approved) — never a page or registry to maintain, and only a human adds it. Flags raw HTML for interactive elements, hardcoded colors, any appearance override on a design-system component (semantic tokens included), and typography utilities fighting a styled base layer. Reports component directories it isn't scanning, and every @approved marker added during a task. Can also generate a /components page documenting everything currently approved. Triggers on UI work, styling changes, new components or pages, before reporting any front-end task as done, or on a direct request to check or document the design system.
---

# Design system guard

Run this check before reporting any UI task as complete, and once more across the whole diff at the end of a larger piece of work. Its purpose is to keep every rendered element an instance of the approved design system instead of a one-off — drift is cheap to introduce and expensive to unwind once it spreads across pages.

Two parts work together: `ds-lint.mjs` finds the mechanical hits deterministically; you apply judgment to everything it can't decide.

## Approved components

**A component is approved when its own file carries an `@approved` marker in a comment within the first 5 lines.** Nothing else confers approval — not living in a components directory, not being imported somewhere, not looking finished, not appearing on a documentation page.

```tsx
// @approved
export function Button(...) { ... }
```

Any comment syntax the file uses is fine (`//`, `/* */`, `{/* */}`, `#`).

**The 5-line window is part of the rule, not an implementation detail.** The marker has to be where someone opening the file sees it immediately; a marker below line 5 does not count and the component reads as unapproved. If that surprises someone, the fix is to move the marker up, never to widen the window.

Build the approved list at check time by scanning the directories in `components:` (see Config), which **may list several** — hand-built components and generated plumbing usually live apart, and every listed directory is checked. Defaults to `src/components/ui` when the key is absent. Never hardcode a list.

Imports are matched by directory tail rather than by a fixed alias, so `@/components/ui/x`, `~/components/ui/x` and `../../components/ui/x` all resolve to the same component. A project that uses no alias at all works the same way.

### How to approve and revoke (when the human asks)

- **Approve a component** ("mark Button as approved"): open that component's file, add `// @approved` as the **first line**, change nothing else. If the file starts with something that must stay first (a shebang), put it on the next line. Tell the human you did it.
- **Approve several at once** ("approve everything in use", "use what we have as the baseline"): do the same for each file they name. If they didn't name files, list the unmarked components that are imported somewhere (`node scripts/ds-lint.mjs --registry`, or read the imports yourself) and ask them to confirm the list before touching anything.
- **Revoke** ("remove approval from Button"): delete the `@approved` marker line from that file, change nothing else, and say how many files import it, because they will be flagged from now on.
- With a terminal you can use `node scripts/ds-lint.mjs --approve <file>` / `--unapprove <file>`. They do exactly the above, and refuse any file outside the component directories.

**First run on an existing project:** nothing is approved yet, so everything in use will be flagged. Don't try to fix that by approving things yourself. Show the human the list, most-used first, and let them choose, or offer the "approve everything in use" baseline above.

### Agents never add the marker

**Only the human decides what is approved.** You may add `@approved` when — and only when — the human asks for it in that moment ("mark Button as approved"). Never on your own initiative: not while doing other work, not as the fix for a flagged item, not because a component looks finished or well-built, not "while I'm in the file anyway."

The reason is the whole point of the check: an agent that can mark components approved approves whatever it invented, and the guard becomes a mirror. The marker is the trust boundary — a human put it there, or it isn't approval.

If a task needs a component that isn't approved, say so. Do not reach for the marker to make the flag disappear.

### Every marker added during a task is reported

Any `@approved` marker that appears in the diff is reported to the human: the file, the component, and who asked for it. **Report it even when the human did ask** — a report filed only when you judge it necessary is a report you can decide not to file, and an agent that added a marker it shouldn't have is exactly the one that would judge it unnecessary.

Don't rely on self-reporting. Detect them mechanically:

```bash
node scripts/ds-lint.mjs --added-markers main...HEAD
```

A marker in the diff that you never mentioned is itself the finding.

## Config — optional, sensible defaults if you skip it

`ds-lint.mjs` reads three optional keys, one per line, from `design-guard.config` in the project root (it falls back to `context/STACK.md` if that's where the project keeps its facts). A missing file just means defaults:

```
components: src/components/ui        # comma-separated if there are several
components-ignore: <path>            # directories deliberately excluded
typography-base: true|false          # does the CSS base layer style h1-h6, p, a, etc.?
```

### An incomplete `components:` is a finding

Every run, report component directories the project has that `components:` doesn't list. The failure is silent in the worst way otherwise: an unlisted directory is never scanned, so its components are neither approved nor flagged, and the check comes back clean. A narrowed check and a healthy project produce the same output.

Never treat an omission as deliberate. A deliberate exclusion is written down in `components-ignore:` — for directories that genuinely aren't design-system components (icon sets, generated output, a legacy folder being retired). Anything in neither key is an unanswered question, and the resolution is a human's: list it, ignore it, or move it.

## Violations

| # | Violation | Examples |
| --- | --- | --- |
| 1 | Raw HTML for core UI | `<button>`, `<input>`, `<select>`, `<textarea>`, hand-rolled card / modal / dropdown / tab `<div>` structures |
| 2 | Off-system component | local component duplicating an `@approved` one; component in a components directory with no `@approved` marker |
| 3 | Appearance override on a design-system component | `<Card className="bg-muted">`, `border-*`, `ring-*`, `shadow-*`, `rounded-*`, `font-*`, `opacity-*` on an approved component, raw hex/`rgb()`, non-token utilities like `bg-white` `text-black` `text-[#333]`, `!important` |
| 4 | Typography utilities on semantic text elements | `<h1 className="text-2xl font-semibold">` — the base layer already sets size, weight, colour, tracking and leading on `<h1>`–`<h6>`, `<p>`, `<a>`, `<strong>`, `<blockquote>`, `<li>`, `<label>`, `<legend>` |

Plain layout wrappers (`<div>`, `<section>`, `<span>`, `<ul>`) are fine. The rule targets interactive controls and visual surfaces, not structure.

Allowed customization is narrow: approved `variant` / `size` props plus layout classes (spacing, flex, grid, width, position, alignment). See `allowed-customization.md` for the full allowlist before deciding an override is acceptable.

### Tokens

Don't maintain a color allowlist by hand. If the project has a tokens file (e.g. `tokens.css`), derive the allowlist from it at check time: every semantic token defined there is allowed on a **plain element**; anything else is a violation there. **On an approved design-system component, no override is allowed — token or not.** The tokens file says what a raw `<div>` may use; it does not reopen an approved component's own appearance.

### Violation 3 — no token exception

**Semantic tokens are not a carve-out.** `<Card className="bg-muted">` is a violation exactly like `<Card className="bg-gray-100">` is — same finding, same handling.

The property being protected isn't theme-safety, it's **component authority**. A token keeps the color themeable, but the call site is still the one deciding what the component looks like, and once that's possible the system no longer owns its own appearance — different call sites accumulate slightly different treatments with no variant governing any of them.

An appearance override is information: it says the component is missing a variant. Treat it as that — park it and propose the variant, rather than resolving it locally with whatever token happens to look right.

**The one legitimate escape:** a component genuinely designed to be an unstyled layout or slot primitive may accept surface classes, because that's its purpose. This is declared in the component itself — a line next to its own `@approved` marker saying it's unstyled by design — never assumed at a call site, and never handled by adding the color to an allowlist.

Only a design-system component's own tag is checked (imports actually pulled from a configured `components:` directory) — a third-party component or a plain element isn't held to this.

### Violation 4 — the type scale

Write `<h1>Projects</h1>`, not `<h1 className="text-2xl font-semibold text-ink-display">Projects</h1>`. Re-specifying what the base layer already sets defeats the type scale one element at a time, and nothing looks broken while it happens.

- **Layout utilities stay legal** on the same elements — `mt-4`, `mb-2`, `max-w-md`, `flex`, `text-center`. Only typography is the violation.
- **Fix by deleting the utility** when it matches what the base layer already produces. **Park** when the value is one the scale doesn't have — that may be a real need for a new scale step, which is a design decision.
- Exception: a text colour on a `<label>` wrapping a checkbox or radio, where the visible text is body copy rather than a field title.
- Gated on `typography-base: true`. On a project whose base layer styles nothing, the utilities *are* the styling and this would fire on every heading.

**An absent key is resolved by looking, not assumed.** When `typography-base:` is missing, scan the project's CSS for a base layer that styles semantic elements typographically:

| CSS | Key | Result |
|---|---|---|
| base layer found | absent | **Finding** — utilities are going unchecked against a base layer that already sets them |
| no base layer | absent | One line: genuinely off, record it as `typography-base: false` |
| either | `true` / `false` | Honoured, silently |

The "genuinely off" line stops as soon as the decision is written down, so it isn't a recurring nag.

## Fix or ask

Run `node scripts/ds-lint.mjs <files-or-dirs>` on the files the task touched to get the mechanical hits, then apply judgment to the rest. Its tests live beside it — `node --test scripts/ds-lint.test.mjs`. Run them after changing the script: every case in there is a bug this check actually shipped.

**Fix immediately** when the correct replacement is unambiguous:

- raw `<button>` → `Button` with the matching variant
- raw `<input>` / `<textarea>` → `Input` / `Textarea`
- hex or non-token color utility on a plain element → the semantic token that matches (`bg-primary`, `text-muted-foreground`, `border-border`)
- a stray utility on an already-styled heading → delete it
- duplicate local component with an exact `@approved` equivalent → the approved component

**Do not touch — park instead** when intent is unclear: a custom component with no close equivalent, an appearance override on an approved component (no variant covers the need — whether the class is a raw color or a token), or a genuinely new component need. Guessing here either destroys intentional work or silently approves drift. State the alternative when parking: "no variant for a recessed surface on `Card` — add `variant=\"muted\"`, or keep as-is?"

Consequences:

- Component used but its file has no `@approved` marker → park it: note whether it should be marked (a question for the human) or replaced with an approved component. Don't use it silently, don't decide silently.
- Task genuinely needs a component that doesn't exist yet → park it with the closest existing match named.
- Component directory missing, or no `components:` key and the default directory doesn't exist → report it as a finding and fall back to flagging only mechanical violations.
- **No component carries the marker yet** → report that plainly. Everything is unapproved, which is the correct reading of a project that hasn't approved anything, not a reason to assume the check is misconfigured.

When the report has a Parked section, do not declare the task done. The UI is not yet consistent with the system.

## Component registry

Once per task (or on request), produce the inventory:

```bash
node scripts/ds-lint.mjs --registry src
```

Three groups, and the split is the point:

**Approved** — every component carrying the marker. The current design system, stated plainly.

**Unmarked but in use** — every unmarked component imported anywhere, with how many files import it. Each is a decision waiting: mark it approved, or replace its uses.

**Unmarked and unimported** — a count only, never a listing. Nothing depends on them, so they're inventory rather than decisions, and listing them would bury the group that needs answers.

**Scan the whole codebase, not just the diff.** In a new project the entire codebase is the backlog, and a component in use since before the guard was installed appears in no diff — it would never surface otherwise. That's exactly the component most worth asking about, since it's load-bearing and unreviewed.

This is an inventory, not a finding: it doesn't block, and a long list on the first run is expected. It shrinks as components get marked.

## The /components page

On request — "add the components page", "show me what's approved" — add the Design Guard page to the project. It is a route inside their own product, **dev-only**, that reads the project's source and shows: stats, "Decisions waiting" (unmarked components in use, most-used first), the approved list, and unused components, each with a badge, variants, props and where it's used. A first-time guide explains approving, and each component has an **Approve / Revoke** button that copies a prompt for the human to paste into the chat. A baseline button copies one prompt approving everything in use.

Setup, for a Vite + React + TypeScript project:

1. Create `src/design-guard/` and copy in these three files from the design-guard repo: `template/Components.tsx`, `scripts/scan-core.mjs`, `scripts/scan-core.d.mts`.
2. In `Components.tsx`, set `COMPONENT_DIRS` to the project's component directories (the same as `components:` in `design-guard.config`).
3. Register the route **only in development**, so it never ships:

```tsx
import { lazy, Suspense } from 'react';
const Components = import.meta.env.DEV ? lazy(() => import('./design-guard/Components')) : null;

// inside the router:
{Components && <Route path="/components" element={<Suspense fallback={null}><Components /></Suspense>} />}
```

4. Keep `src/design-guard/` out of the lint path. It is deliberately plain HTML and doesn't use the project's components.

Rules for the page:

- Everything on it is read from source. Nothing is typed by hand.
- It never approves anything itself. Its buttons only copy a prompt; the human sends it and the assistant edits the file.
- Non-Vite projects (Next.js etc.) don't have `import.meta.glob`; generate the data with `node scripts/ds-lint.mjs --scan` instead, and keep the same dev-only rule.

## Report format

**Report decisions, not activity**: what was fixed and what was parked, not the files scanned or the rules evaluated. The fixed list is decisions — each one is a change someone might disagree with — so it stays; the scan itself is activity and doesn't.

End every UI task with this block, even when nothing was found (`Design system check: clean`). One result for the check, not one per file: a clean line is a reported decision, and its absence is indistinguishable from the check never running.

```
Design system check
Fixed (3)
  src/routes/dashboard.tsx:12  <button> -> Button variant="secondary"
  src/routes/dashboard.tsx:57  text-[#1f2937] -> text-foreground
  src/components/Row.tsx:12    bg-white -> bg-card
Parked (1)
  src/components/StatTile.tsx  custom component, no @approved marker
  -> Replace with Card, or mark StatTile @approved? (a human's call, never mine)
```

Parked items accumulate for the human to resolve. A full-diff pass at the end re-checks them: some resolve themselves (the component got replaced in a later step); the rest stay listed.
