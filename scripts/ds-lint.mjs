#!/usr/bin/env node
// design-system-guard mechanical linter.
//
// Usage:
//   ds-lint.mjs <file-or-dir> [...]          lint (defaults to src/); skips findings in design-guard.baseline.json
//     --baseline-write                       record today's findings as the baseline (a human's act)
//     --no-baseline                          show every finding, recorded or not
//   ds-lint.mjs --added-markers <git-range>  audit @approved markers, config edits that narrow the check,
//                                            @deprecated changes, and changes to allowed-customization.md
//                                            or CODEOWNERS
//   ds-lint.mjs --codeowners <owner...>      CODEOWNERS lines for everything that decides approval
//   ds-lint.mjs --registry [root]            inventory for the report's registry section
//   ds-lint.mjs --approve <file...>          add the @approved marker (a human's act — see SKILL.md)
//   ds-lint.mjs --unapprove <file...>        remove it
//   ds-lint.mjs --serve [--port N]           local API for the /components page's approve/revoke buttons
//   ds-lint.mjs --scan [root]                every component as JSON: status, usage, props, variants
//
// Exit 1 when any hit is found, 0 when clean. --registry always exits 0 (inventory,
// not a finding). --added-markers exits 1 when markers were added, the config narrowed, or
// allowed-customization.md or CODEOWNERS changed.
//
// Node rather than shell, deliberately. The shell version accumulated four bugs of
// kinds this file cannot have: `ls a b` failing when only one glob missed, a sed
// delimiter colliding with data containing "|", a path prefix leaking into a
// pattern match, and grep's -i flag applying in one branch but not the other.

import { readFileSync, readdirSync, statSync, writeFileSync, realpathSync } from 'node:fs';
import { join, basename, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  MARKER_WINDOW,
  MARKER_RE,
  LINT_EXTS,
  COMPONENT_EXTS,
  esc,
  norm,
  tailOf,
  componentKey,
  isMarkedText,
  deprecationOf,
  DEPRECATED_RE,
  scanProject,
  resolveImportKey,
  IMPORT_FROM_RE,
} from './scan-core.mjs';


const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);


// ---- config ----
// Keys are read from `design-guard.config` in the project root, falling back to
// `context/STACK.md` (the Found framework's location). Format: one `key: value`
// per line; anything else in the file is ignored, so STACK.md works unchanged.

const CONFIG_FILES = ['design-guard.config', 'context/STACK.md'];

// The skill's list of allowed customization. Wherever it is installed, a change
// to it is a change to what counts as approved, so --added-markers reports it.
const EXCEPTIONS_FILE = 'allowed-customization.md';

// The same lookup over any source of file text, so --added-markers can read the
// config as it was at a past revision. `read(file)` returns the text or null.
function configKey(name, read) {
  for (const file of CONFIG_FILES) {
    const text = read(file);
    if (text == null) continue; // file absent — try the next
    const m = text.match(new RegExp(`^${name}:[ \\t]*(.*)$`, 'm'));
    if (m) return m[1].replace(/\s+#.*$/, '').trim();
  }
  return '';
}

function readWorkingFile(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function stackKey(name) {
  return configKey(name, readWorkingFile);
}

function dirList(raw, fallback = '') {
  const s = (raw || fallback).trim();
  return s ? s.split(/[,\s]+/).filter(Boolean).map(norm) : [];
}

// `components:` may list several directories — hand-built components and the
// generated plumbing they sit on usually live apart.
const COMPONENT_DIRS = dirList(stackKey('components'), 'src/components/ui');
const IGNORE_DIRS = dirList(stackKey('components-ignore'));

// Off unless the project declares a CSS base layer that styles semantic elements.
const TYPOGRAPHY_BASE_RAW = stackKey('typography-base');
const TYPOGRAPHY_BASE = /^true$/i.test(TYPOGRAPHY_BASE_RAW);
const TYPOGRAPHY_BASE_DECLARED = /^(true|false)$/i.test(TYPOGRAPHY_BASE_RAW);


// ---- filesystem ----

function* walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      yield* walk(join(dir, e.name));
    } else if (e.isFile()) {
      yield join(dir, e.name);
    }
  }
}

function filesUnder(target, exts) {
  const out = [];
  let st;
  try {
    st = statSync(target);
  } catch {
    return out;
  }
  if (st.isFile()) {
    if (exts.some((x) => target.endsWith(x))) out.push(norm(target));
    return out;
  }
  for (const f of walk(target)) if (exts.some((x) => f.endsWith(x))) out.push(norm(f));
  return out;
}

const isDir = (p) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const readLines = (f) => {
  try {
    return readFileSync(f, 'utf8').split('\n');
  } catch {
    return [];
  }
};

// Is this file inside one of the configured component directories? Those files
// define the system rather than consume it, so lint skips them.
const inComponentDir = (file) =>
  COMPONENT_DIRS.some((d) => norm(file) === d || norm(file).startsWith(d + '/'));

const isMarked = (file) => isMarkedText(readLines(file).join('\n'));

// The imported component key, taken from the LINE CONTENT only. A component's own
// path contains the same directory tail, so matching against the path would return
// the file itself instead of what it imports.

function* importsIn(files) {
  if (COMPONENT_DIRS.length === 0) return;
  for (const file of files) {
    const lines = readLines(file);
    for (let i = 0; i < lines.length; i++) {
      const spec = lines[i].match(IMPORT_FROM_RE);
      const key = spec && resolveImportKey(file, spec[1], COMPONENT_DIRS);
      if (key) yield { file, line: i + 1, content: lines[i], key };
    }
  }
}

// ---- mode: --added-markers ----

function addedMarkers(range) {
  let diff;
  try {
    diff = execFileSync('git', ['diff', '--unified=0', range], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    console.error(`ds-lint: cannot diff "${range}" — pass an explicit range, e.g. main...HEAD`);
    return 2;
  }

  const exceptions = new Map(); // allowed-customization.md path -> { added, removed }
  const owners = new Map(); // CODEOWNERS path -> { added, removed }
  let file = null; // path on the new side; null when the file was deleted
  let oldFile = null;
  let inHeader = false; // ---/+++ are file headers only between `diff --git` and the first @@
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      inHeader = true;
    } else if (line.startsWith('@@')) {
      inHeader = false;
    } else if (inHeader && line.startsWith('--- ')) {
      const p = line.slice(4).trim();
      oldFile = p === '/dev/null' ? null : p.replace(/^a\//, '');
    } else if (inHeader && line.startsWith('+++ ')) {
      const p = line.slice(4).trim();
      file = p === '/dev/null' ? null : p.replace(/^b\//, '');
    } else if (!inHeader && (line.startsWith('+') || line.startsWith('-'))) {
      const added = line.startsWith('+');
      // The exceptions file is policy: any line in or out changes what counts
      // as allowed, so every change is reported, wording included.
      const policy = file ?? oldFile;
      const kind = policy && line.slice(1).trim() !== '' ? basename(policy) : null;
      const bucket = kind === EXCEPTIONS_FILE ? exceptions : kind === 'CODEOWNERS' ? owners : null;
      if (bucket) {
        const n = bucket.get(policy) ?? { added: 0, removed: 0 };
        n[added ? 'added' : 'removed'] += 1;
        bucket.set(policy, n);
      }
    }
  }

  const found = markersAdded(range);
  const weakened = weakeningConfigChanges(range);
  if (found === null || weakened === null) {
    console.error(`ds-lint: cannot read both ends of "${range}"`);
    return 2;
  }

  if (found.size > 0) {
    console.log(`== @approved markers added in ${range}`);
    for (const f of [...found].sort()) console.log(`  ${f}`);
    console.log('');
    console.log('   Report each of these in the final report as a Needs-you item, naming who');
    console.log('   asked for it — including when a human did ask.');
  } else {
    console.log(`No @approved markers added in ${range}`);
  }

  if (weakened.length > 0) {
    if (found.size > 0) console.log('');
    console.log(`== config changes that narrow the check in ${range}`);
    for (const w of weakened) console.log(`  ${w}`);
    console.log('');
    console.log('   Each of these stops the guard looking at something. Like a marker, it is');
    console.log("   a human's decision: report it as a Needs-you item, naming who asked for it.");
  } else {
    console.log(`No config changes narrowing the check in ${range}`);
  }

  if (exceptions.size > 0) {
    console.log('');
    console.log(`== exceptions file changed in ${range}`);
    for (const [f, n] of [...exceptions].sort()) {
      console.log(`  ${f}  (+${n.added} -${n.removed} lines)`);
    }
    console.log('');
    console.log('   This file says what customization is allowed. Only a human adds an');
    console.log('   exception: report it as a Needs-you item, naming who asked for it.');
  }

  if (owners.size > 0) {
    console.log('');
    console.log(`== CODEOWNERS changed in ${range}`);
    for (const [f, n] of [...owners].sort()) console.log(`  ${f}  (+${n.added} -${n.removed} lines)`);
    console.log('');
    console.log('   CODEOWNERS decides who reviews approvals. Report the change as a');
    console.log('   Needs-you item, naming who asked for it.');
  }

  const grown = baselineGrowth(range);
  if (grown.length > 0) {
    console.log('');
    console.log(`== ${BASELINE_FILE} gained findings in ${range}`);
    grown.forEach((l) => console.log(`  ${l}`));
    console.log('');
    console.log('   Each recorded finding stops failing the check. Recording one is approving it:');
    console.log('   report it as a Needs-you item, naming who asked for it.');
  }

  const deprecations = found.deprecations;
  if (deprecations.size > 0) {
    console.log('');
    console.log(`== @deprecated markers changed in ${range}`);
    for (const [f, how] of [...deprecations].sort()) console.log(`  ${f}  (${how})`);
    console.log('');
    console.log('   Deprecating a component, or lifting a deprecation, is a human decision.');
    console.log('   Report each as a Needs-you item, naming who asked for it.');
  }

  return found.size > 0 || weakened.length > 0 || exceptions.size > 0 || owners.size > 0 || deprecations.size > 0 || grown.length > 0 ? 1 : 0;
}

// A marker counts only where it confers approval: a marker comment within the
// first MARKER_WINDOW lines. So a file is reported when, comparing the two ends of
// the range, its marker lines in that window appeared or changed (a new marker, a
// marker moved up into the window, or "unstyled by design" written onto one).
// Code, tests and docs that merely mention @approved further down are not markers.
function markerLines(text) {
  if (text == null) return [];
  return text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .slice(0, MARKER_WINDOW)
    .filter((l) => MARKER_RE.test(l))
    .map((l) => l.trim());
}

// Entries the baseline gained across the range (new, or a higher count). Fixing
// findings shrinks it; only growth is a decision someone has to own.
function baselineGrowth(range) {
  let ends;
  try {
    ends = rangeEnds(range);
  } catch {
    return [];
  }
  const was = readBaseline(readAtRev(ends.base)(BASELINE_FILE)) ?? new Map();
  const now = readBaseline((ends.head === null ? readWorkingFile : readAtRev(ends.head))(BASELINE_FILE)) ?? new Map();
  const out = [];
  for (const [k, n] of [...now].sort(([a], [b]) => a.localeCompare(b))) {
    const before = was.get(k) ?? 0;
    if (n > before) out.push(`${k}${n - before > 1 ? `  (x${n - before})` : ''}`);
  }
  return out;
}

function deprecationLines(text) {
  if (text == null) return [];
  return text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .slice(0, MARKER_WINDOW)
    .filter((l) => DEPRECATED_RE.test(l))
    .map((l) => l.trim());
}

function markersAdded(range) {
  let ends;
  let names;
  try {
    ends = rangeEnds(range);
    // --relative: paths relative to (and limited to) the current directory, so a
    // project in a subdirectory of the repository is read correctly.
    names = execFileSync('git', ['diff', '--name-only', '--relative', '--diff-filter=d', range], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    })
      .split('\n')
      .filter(Boolean);
  } catch {
    return null;
  }
  const before = readAtRev(ends.base);
  const after = ends.head === null ? readWorkingFile : readAtRev(ends.head);
  const found = new Set();
  const deprecations = new Map(); // file -> 'added' | 'removed' | 'changed'
  for (const f of names) {
    const textNow = after(f);
    const textWas = before(f);
    const now = markerLines(textNow);
    const was = new Set(markerLines(textWas));
    if (now.some((l) => !was.has(l))) found.add(f);
    // Deprecating or un-deprecating is a decision about the system either way:
    // reported in both directions, and when the named replacement changes.
    const dNow = deprecationLines(textNow).join('\n');
    const dWas = deprecationLines(textWas).join('\n');
    if (dNow !== dWas) deprecations.set(f, !dWas ? 'added' : !dNow ? 'removed' : 'changed');
  }
  found.deprecations = deprecations;
  return found;
}

// Resolve a diff range to the two states it compares, the way `git diff` does:
// A...B  -> merge-base(A, B) vs B     A..B -> A vs B
// A      -> A vs the working tree     (B defaults to HEAD)
// Returns { base, head } where head === null means the working tree.
function rangeEnds(range) {
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (range.includes('...')) {
    const [a, b] = range.split('...');
    const head = b || 'HEAD';
    return { base: git('merge-base', a || 'HEAD', head), head };
  }
  if (range.includes('..')) {
    const [a, b] = range.split('..');
    return { base: a || 'HEAD', head: b || 'HEAD' };
  }
  return { base: range, head: null };
}

function readAtRev(rev) {
  return (file) => {
    try {
      // `./` makes the path relative to the current directory, so this works
      // when the project is a subdirectory of the repository.
      return execFileSync('git', ['show', `${rev}:./${file}`], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 16 * 1024 * 1024,
      });
    } catch {
      return null; // file absent at that revision
    }
  };
}

function effectiveConfig(read) {
  return {
    components: dirList(configKey('components', read), 'src/components/ui'),
    ignore: dirList(configKey('components-ignore', read)),
    typographyBase: /^true$/i.test(configKey('typography-base', read)),
  };
}

// Config edits that make the guard look at less: an ignored directory added, a
// component directory dropped, or the type-scale check switched off. Edits that
// widen the check are not reported. null if the range can't be resolved.
function weakeningConfigChanges(range) {
  let ends;
  try {
    ends = rangeEnds(range);
  } catch {
    return null;
  }
  const before = effectiveConfig(readAtRev(ends.base));
  const after = effectiveConfig(ends.head === null ? readWorkingFile : readAtRev(ends.head));

  const out = [];
  for (const d of after.ignore) {
    if (!before.ignore.includes(d)) out.push(`components-ignore: added ${d} — no longer scanned`);
  }
  for (const d of before.components) {
    if (!after.components.includes(d)) out.push(`components: removed ${d} — no longer scanned`);
  }
  if (before.typographyBase && !after.typographyBase) {
    out.push('typography-base: true -> off — typography check (violation 4) disabled');
  }
  return out;
}

// ---- component scan ----
// One pass over the project that everything else reads from: --registry, --scan,
// and (later) the components page and the local UI. Each component gets a status,
// its importers, and best-effort props/variants pulled from its source.
//
//   approved          carries @approved, and something imports it
//   approved-unused   carries @approved, nothing imports it (a stale entry)
//   unmarked-in-use   no marker, imported somewhere — a decision waiting
//   unmarked-unused   no marker, not imported — inventory

function scanComponents(root = '.') {
  const files = {};
  for (const f of filesUnder(root, COMPONENT_EXTS)) {
    try {
      files[f] = readFileSync(f, 'utf8');
    } catch {
      files[f] = ''; // unreadable: report the component with no props rather than drop it
    }
  }
  return scanProject({ files, componentDirs: COMPONENT_DIRS.filter(isDir) });
}

// ---- mode: --scan ----

function scanMode(root) {
  console.log(JSON.stringify(scanComponents(root), null, 2));
  return 0;
}

// ---- mode: --registry ----

function registry(root) {
  const all = scanComponents(root);
  const approvedList = all.filter((c) => c.approved && !c.deprecated).map((c) => c.key);
  const deprecatedList = all
    .filter((c) => c.deprecated)
    .sort((a, b) => b.usageCount - a.usageCount)
    .map((c) => `${c.key.padEnd(44)} used in ${c.usageCount} file(s)${c.replacement ? `  -> ${c.replacement}` : ''}`);
  const used = all.filter((c) => c.status === 'unmarked-in-use');
  const unusedCount = all.filter((c) => c.status === 'unmarked-unused').length;
  const usedList = used.map((u) => `${u.key.padEnd(44)} used in ${u.usageCount} file(s)`);

  console.log('== component registry');
  console.log('');
  console.log(`Approved (${approvedList.length})`);
  if (approvedList.length) approvedList.forEach((k) => console.log(`  ${k}`));
  else console.log('  (none yet — expected on a new project)');
  console.log('');
  console.log(`Unmarked but in use (${usedList.length})`);
  if (usedList.length) {
    usedList.forEach((l) => console.log(`  ${l}`));
    console.log('');
    console.log('  Each is a decision waiting: mark it approved, or replace its uses.');
  } else {
    console.log('  (none)');
  }
  console.log('');
  if (deprecatedList.length) {
    console.log(`Deprecated (${deprecatedList.length})`);
    deprecatedList.forEach((l) => console.log(`  ${l}`));
    console.log('');
    console.log('  Uses left to migrate. Once a count reaches 0, the component can be deleted.');
    console.log('');
  }
  console.log(`Unmarked and unimported: ${unusedCount} file(s) — not listed.`);
  console.log('  Nothing depends on them, so they are inventory rather than a decision.');
  return 0;
}

// ---- marker edit ----
// The only code in this file that writes to a project file, so it is deliberately
// narrow: it touches nothing but a configured component file, inserts or removes
// nothing but the marker, and verifies the result before writing.

const MARKER_LINE = '// @approved';

// A line that is nothing but a comment carrying the marker (and maybe a note after
// it, like "— unstyled by design"): `// @approved`, `/* @approved */`,
// `{/* @approved */}`, ` * @approved`, `# @approved`.
const MARKER_ONLY_LINE_RE = /^\s*(?:\{\s*)?(?:\/\/+|\/\*+|\*+|#+)?\s*@approved(?:\s.*?)?(?:\*\/)?\s*\}?\s*$/;

class MarkerError extends Error {}

// Resolve `file` and make sure it is a real file inside a configured component
// directory. Anything else is refused: the tool must not be a way to write markers
// (or anything) into arbitrary paths.
function resolveComponentFile(file, root = process.cwd()) {
  let real;
  try {
    real = realpathSync(resolve(root, file));
  } catch {
    throw new MarkerError(`no such file: ${file}`);
  }
  if (!statSync(real).isFile()) throw new MarkerError(`not a file: ${file}`);
  if (!COMPONENT_EXTS.some((x) => real.endsWith(x))) {
    throw new MarkerError(`not a component file (${COMPONENT_EXTS.join(', ')}): ${file}`);
  }
  const rootReal = realpathSync(root);
  const inside = COMPONENT_DIRS.some((d) => {
    try {
      const dirReal = realpathSync(resolve(rootReal, d));
      return real === dirReal || real.startsWith(dirReal + sep);
    } catch {
      return false;
    }
  });
  if (!inside) {
    throw new MarkerError(`${file} is not inside a configured components directory (${COMPONENT_DIRS.join(', ') || 'none'})`);
  }
  return real;
}

const hasMarker = (lines) => lines.slice(0, MARKER_WINDOW).some((l) => MARKER_RE.test(l));

// Pure: text in, text out. Keeps the file's own line endings and BOM, and slots in
// after a shebang. Returns the same text when the marker is already in the window.
function withMarker(text) {
  const bom = text.startsWith('﻿') ? '﻿' : '';
  const body = bom ? text.slice(1) : text;
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const lines = body.split(eol);
  if (hasMarker(lines)) return text;
  const at = lines[0].startsWith('#!') ? 1 : 0;
  lines.splice(at, 0, MARKER_LINE);
  return bom + lines.join(eol);
}

// Pure: removes every marker inside the window. A comment-only line is dropped whole;
// a marker sharing a line with anything else is cut out and the rest left alone.
function withoutMarker(text) {
  const bom = text.startsWith('﻿') ? '﻿' : '';
  const body = bom ? text.slice(1) : text;
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const lines = body.split(eol);
  const out = [];
  lines.forEach((line, i) => {
    if (i >= MARKER_WINDOW || !MARKER_RE.test(line)) return out.push(line);
    if (MARKER_ONLY_LINE_RE.test(line)) return; // drop the line
    out.push(line.replace(/@approved/, '').replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+$/, ''));
  });
  return bom + out.join(eol);
}

// Returns { changed, message, usedBy } or throws MarkerError. Verifies the outcome
// from the new text before writing, so a bad edit is refused rather than saved.
function setApproval(file, approved, root = process.cwd()) {
  const real = resolveComponentFile(file, root);
  const before = readFileSync(real, 'utf8');
  const wasMarked = hasMarker(before.replace(/^﻿/, '').split(/\r?\n/));
  if (wasMarked === approved) {
    return { changed: false, message: `${file} is already ${approved ? 'approved' : 'unapproved'}` };
  }
  const after = approved ? withMarker(before) : withoutMarker(before);
  const nowMarked = hasMarker(after.replace(/^﻿/, '').split(/\r?\n/));
  if (nowMarked !== approved) throw new MarkerError(`could not ${approved ? 'add' : 'remove'} the marker in ${file}; file left untouched`);
  writeFileSync(real, after);
  return { changed: true, message: `${file} is now ${approved ? 'approved' : 'unapproved'}` };
}

// ---- mode: --approve / --unapprove ----
// Human-run. The framework's rule is that an agent adds a marker only when asked
// to in that moment; this is the same act, one command long.

function approveMode(approved, files) {
  if (!files.length) {
    console.error(`ds-lint: ${approved ? '--approve' : '--unapprove'} needs a component file`);
    return 2;
  }
  let code = 0;
  for (const file of files) {
    try {
      let note = '';
      if (!approved) {
        const key = scanComponents('.').find((c) => resolve(c.file) === resolve(file));
        if (key?.usageCount) note = ` — ${key.usageCount} file(s) import it and will now be flagged`;
      }
      const r = setApproval(file, approved);
      console.log(r.message + (r.changed ? note : ''));
    } catch (e) {
      if (!(e instanceof MarkerError)) throw e;
      console.error(`ds-lint: ${e.message}`);
      code = 2;
    }
  }
  return code;
}

// ---- mode: --serve ----
// A tiny local API so the /components page can approve and revoke with one click.
// The page is a browser page and cannot write files; this is the process with file
// access behind it. It only ever calls setApproval(), so everything that function
// refuses (paths outside the component dirs, symlinks, non-component files) is refused
// here too.
//
// Threat model, stated plainly: it listens on 127.0.0.1 only, checks Host and Origin
// (so a web page on another site cannot reach it, including by DNS rebinding), and
// needs a random token for every write. Anything running as you on this machine —
// including an AI agent with shell access — can read the token from this terminal, so
// this stops other websites and stray requests, not a determined local process.
// --added-markers is the backstop for that.

const LOCAL_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const MAX_BODY = 16 * 1024;

function serveMode(args) {
  const pi = args.indexOf('--port');
  const port = pi >= 0 ? Number(args[pi + 1]) : 4177;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    console.error('ds-lint: --port needs a number between 0 and 65535');
    return 2;
  }
  const token = randomBytes(24).toString('hex');
  const tokenBuf = Buffer.from(token);
  const root = process.cwd();

  const server = createServer((req, res) => {
    const send = (status, body, extra = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra });
      res.end(JSON.stringify(body));
    };

    const { port: bound } = server.address();
    const host = req.headers.host || '';
    if (host !== `127.0.0.1:${bound}` && host !== `localhost:${bound}`) return send(403, { error: 'bad host' });

    const origin = req.headers.origin;
    if (origin !== undefined && !LOCAL_ORIGIN_RE.test(origin)) return send(403, { error: 'origin not allowed' });
    const cors = origin
      ? {
          'Access-Control-Allow-Origin': origin,
          Vary: 'Origin',
          'Access-Control-Allow-Headers': 'Content-Type, X-Guard-Token',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Private-Network': 'true',
        }
      : {};

    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      return res.end();
    }
    if (req.method === 'GET' && req.url === '/ping') return send(200, { ok: true, tool: 'design-guard' }, cors);

    if (req.method === 'POST' && (req.url === '/approve' || req.url === '/unapprove')) {
      const given = Buffer.from(String(req.headers['x-guard-token'] || ''));
      if (given.length !== tokenBuf.length || !timingSafeEqual(given, tokenBuf)) {
        return send(401, { error: 'missing or wrong token' }, cors);
      }
      if (!String(req.headers['content-type'] || '').startsWith('application/json')) {
        return send(415, { error: 'send application/json' }, cors);
      }
      let body = '';
      let tooBig = false;
      req.on('data', (chunk) => {
        body += chunk;
        if (body.length > MAX_BODY) {
          tooBig = true;
          req.destroy();
        }
      });
      req.on('end', () => {
        if (tooBig) return;
        let file;
        try {
          file = JSON.parse(body).file;
        } catch {
          return send(400, { error: 'invalid JSON' }, cors);
        }
        if (typeof file !== 'string' || !file) return send(400, { error: 'file is required' }, cors);
        try {
          const r = setApproval(file, req.url === '/approve', root);
          console.log(`${new Date().toLocaleTimeString()}  ${r.message}`);
          return send(200, r, cors);
        } catch (e) {
          if (!(e instanceof MarkerError)) throw e;
          return send(400, { error: e.message }, cors);
        }
      });
      return;
    }
    return send(404, { error: 'not found' }, cors);
  });

  server.listen(port, '127.0.0.1', () => {
    const { port: bound } = server.address();
    console.log(`design-guard listening on http://127.0.0.1:${bound}  (this machine only)`);
    console.log('');
    console.log(`Token: ${token}`);
    console.log('');
    console.log('Paste the token into the /components page to enable one-click approve and revoke.');
    console.log('Only a human should do that. Ctrl+C stops it.');
  });
  process.on('SIGINT', () => process.exit(0));
  return null; // keep running
}

// ---- mode: lint ----

const PATTERNS = [
  ['raw hex / rgb / hsl color', /#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/],
  ['arbitrary-value utility', /(bg|text|border|shadow|rounded|font|ring)-\[/],
  [
    'non-token color utility',
    /\b(bg|text|border|ring|from|to|via)-(white|black|gray|slate|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(-[0-9]{2,3})?\b/,
  ],
  // Case-sensitive on purpose: <button> is a raw element, <Button> is the component.
  ['raw interactive HTML element', /<(button|input|select|textarea)[\s>]/],
  ['inline style attribute', /style=\{\{/],
  ['important override', /className="[^"]*![a-z-]/],
];

// Semantic elements the CSS base layer already styles. Typography utilities on
// these silently defeat the type scale — the most common drift in a Tailwind
// codebase, and one of the few design mistakes a machine can actually see.
// Gated on `typography-base:` in design-guard.config (or context/STACK.md): on a project whose base layer styles
// nothing, the utilities ARE the styling and this would fire on every heading.
const TYPOGRAPHIC_ELEMENTS = 'h1|h2|h3|h4|h5|h6|p|a|strong|blockquote|li|label|legend';

// The utility a class applies, without its variants: `md:hover:bg-x` and
// `data-[state=open]:bg-x` both give `bg-x`. Splits on the last ":" outside
// brackets, so an arbitrary value containing ":" stays whole.
function utilityOf(cls) {
  let depth = 0;
  let cut = 0;
  for (let i = 0; i < cls.length; i++) {
    const c = cls[i];
    if (c === '[' || c === '(') depth++;
    else if (c === ']' || c === ')') depth--;
    else if (c === ':' && depth === 0) cut = i + 1;
  }
  return cls.slice(cut);
}

const TEXT_SIZES = new Set(['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl', '6xl', '7xl', '8xl', '9xl']);
const FONT_WEIGHTS = new Set(['thin', 'extralight', 'light', 'normal', 'medium', 'semibold', 'bold', 'extrabold', 'black']);
// Alignment and wrapping are layout, not typography — legal on any element.
const TEXT_LAYOUT = new Set(['left', 'center', 'right', 'justify', 'start', 'end', 'wrap', 'nowrap', 'balance', 'pretty', 'ellipsis', 'clip']);

function typographyViolation(cls) {
  const bare = utilityOf(cls); // drop variants like md:hover: or data-[state=open]:
  if (bare.startsWith('font-') && FONT_WEIGHTS.has(bare.slice(5))) return 'font weight';
  if (bare.startsWith('tracking-')) return 'letter spacing';
  if (bare.startsWith('leading-')) return 'line height';
  if (bare.startsWith('text-')) {
    const v = bare.slice(5);
    if (TEXT_SIZES.has(v)) return 'text size';
    if (TEXT_LAYOUT.has(v)) return null;
    return 'text color';
  }
  return null;
}

// Does the project's CSS actually style semantic elements typographically? Used
// only when `typography-base:` is absent, to tell "genuinely off" apart from
// "nobody set the key" — the second is a gap, the first is a recorded state.
const TYPO_PROP_RE = /(font-size|font-weight|line-height|letter-spacing|font-family|color)\s*:/;
const SEMANTIC_SELECTOR_RE = new RegExp(`^(${TYPOGRAPHIC_ELEMENTS})(::?[a-z-]+)?$`);

function detectBaseLayer() {
  for (const f of filesUnder('.', ['.css', '.scss'])) {
    for (const m of (readLines(f).join('\n')).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!TYPO_PROP_RE.test(m[2])) continue;
      const selector = m[1].split(/[\n;]/).pop().trim();
      for (const part of selector.split(',')) {
        // last token handles descendant selectors like `.prose h1`
        const leaf = part.trim().split(/\s+/).pop() || '';
        if (SEMANTIC_SELECTOR_RE.test(leaf)) return { file: f, selector: part.trim() };
      }
    }
  }
  return null;
}

// ---- class strings, however className is written ----
//
// `className="…"` is the easy case. In a shadcn codebase most classes are built:
// `cn("rounded-xl", active && "bg-primary")`, `` `shadow-lg ${x}` ``, or a
// `const cls = "bg-muted"` used as `className={cls}`. Every string literal inside
// the expression is a candidate class list (both sides of a ternary, both sides of
// &&, cn/clsx arguments, object keys), plus the static text of template literals
// and same-file string constants the expression names. Anything else (props,
// imports, function results) can't be resolved and contributes nothing.

// String literals in an expression, with template-literal static text and the
// literals inside each ${…}.
function literalsIn(expr) {
  const out = [];
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === '"' || c === "'") {
      let j = i + 1;
      let buf = '';
      for (; j < expr.length && expr[j] !== c; j++) {
        if (expr[j] === '\\') j++;
        else buf += expr[j];
      }
      out.push(buf);
      i = j;
    } else if (c === '`') {
      let j = i + 1;
      let buf = '';
      for (; j < expr.length && expr[j] !== '`'; j++) {
        if (expr[j] === '\\') {
          j++;
        } else if (expr[j] === '$' && expr[j + 1] === '{') {
          let depth = 1;
          let k = j + 2;
          for (; k < expr.length && depth > 0; k++) {
            if (expr[k] === '{') depth++;
            else if (expr[k] === '}') depth--;
          }
          out.push(...literalsIn(expr.slice(j + 2, k - 1)));
          buf += ' ';
          j = k - 1;
        } else {
          buf += expr[j];
        }
      }
      out.push(buf);
      i = j;
    }
  }
  return out;
}

// `const NAME = "…"` / '…' / `…` in the file: name -> literals.
function fileConstants(text) {
  const out = new Map();
  for (const m of text.matchAll(/\b(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::\s*string\s*)?=\s*(["'`])/g)) {
    const start = m.index + m[0].length - 1;
    const lits = literalsIn(text.slice(start, start + 2000));
    if (lits.length) out.set(m[1], [lits[0]]);
  }
  return out;
}

// Class tokens from a tag body's own className attribute (not one on an element
// nested inside an expression prop).
function classTokensOf(body, consts) {
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    if (depth !== 0 || !body.startsWith('className=', i) || /[\w-]/.test(body[i - 1] || '')) continue;
    let j = i + 'className='.length;
    const q = body[j];
    let parts = [];
    if (q === '"' || q === "'") {
      parts = [body.slice(j + 1, body.indexOf(q, j + 1))];
    } else if (q === '{') {
      let d = 0;
      let k = j;
      for (; k < body.length; k++) {
        if (body[k] === '{') d++;
        else if (body[k] === '}' && --d === 0) break;
      }
      const expr = body.slice(j + 1, k);
      parts = literalsIn(expr);
      const bare = expr.replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, ' ');
      for (const id of bare.matchAll(/(?<![\w$.])([A-Za-z_$][\w$]*)(?![\w$]*\s*[(:])/g)) {
        if (consts.has(id[1])) parts.push(...consts.get(id[1]));
      }
    }
    return [...new Set(parts.join(' ').split(/\s+/).filter(Boolean))];
  }
  return [];
}

const SEMANTIC_OPEN_RE = new RegExp(`<(${TYPOGRAPHIC_ELEMENTS})(?![\\w-])`, 'g');

function semanticTypographyHits(files) {
  const found = [];
  for (const f of files) {
    const lines = readLines(f);
    const text = lines.join('\n');
    const consts = fileConstants(text);
    SEMANTIC_OPEN_RE.lastIndex = 0;
    let m;
    while ((m = SEMANTIC_OPEN_RE.exec(text))) {
      const tag = m[1];
      const lineNo = text.slice(0, m.index).split('\n').length;
      // A <label> wrapping a checkbox or radio is body copy, not a field title —
      // a text colour on it is legitimate. Same-line heuristic; a label split
      // across lines is not detected, and that is the accepted limit.
      const inlineControl = /type="(checkbox|radio)"/.test(lines[lineNo - 1]);
      for (const cls of classTokensOf(tagBodyAt(text, SEMANTIC_OPEN_RE.lastIndex), consts)) {
        const kind = typographyViolation(cls);
        if (!kind) continue;
        if (kind === 'text color' && tag === 'label' && inlineControl) continue;
        found.push(`${f}:${lineNo}: <${tag}> ${cls} (${kind}) — the base layer already sets this`);
      }
    }
  }
  return found;
}

// ---- appearance overrides on design-system components ----
//
// No token exception. A semantic token on a call site is still the call site
// deciding how the component looks, which is the authority the system is supposed
// to hold. An appearance override is a signal that a variant is missing; allowing
// `bg-muted` through swallows that signal instead of surfacing it.

// Named imports pulled from a configured component directory, per file. Only these
// are checked: a capitalised tag from elsewhere is not a design-system component,
// and flagging it would fire on every third-party element in the tree.
function systemTagsIn(file) {
  const tags = new Set();
  const text = readLines(file).join('\n');
  for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    if (!resolveImportKey(file, m[2], COMPONENT_DIRS)) continue;
    for (const spec of m[1].split(',')) {
      const name = (spec.split(/\s+as\s+/).pop() || '').trim();
      if (/^[A-Z]/.test(name)) tags.add(name);
    }
  }
  return tags;
}

// `text-center` and friends are layout; `border` bare is a width, not a colour.
// Everything else in this shape changes appearance.
function appearanceViolation(cls) {
  const bare = utilityOf(cls).replace(/^!/, '');
  if (bare.startsWith('text-')) {
    const v = bare.slice(5);
    if (TEXT_LAYOUT.has(v)) return null;
    return TEXT_SIZES.has(v) ? 'text size' : 'text colour';
  }
  if (/^bg-/.test(bare)) return 'background';
  if (/^(border|divide)-/.test(bare)) return 'border';
  if (/^(ring|ring-offset)-/.test(bare)) return 'ring';
  if (/^shadow(-|$)/.test(bare)) return 'shadow';
  if (/^rounded(-|$)/.test(bare)) return 'radius';
  if (/^(font|tracking|leading)-/.test(bare)) return 'typography';
  if (/^opacity-/.test(bare)) return 'opacity';
  return null;
}

const OPEN_TAG_RE = /<([A-Z][A-Za-z0-9_]*)\b/g;
const TAG_SCAN_LIMIT = 5000; // bail on a pathologically long/unterminated tag rather than hang

// Finds the end of a JSX opening tag by tracking brace depth, not by matching up
// to the first `>`. A single-line regex like [^>]*? breaks the moment a prop
// value contains its own `>` — and `onClick={() => {}}` does, since `=>` is one.
// Depth-tracking lets the scan cross an expression prop without stopping inside it.
// Known accepted limit, same spirit as the checkbox/radio same-line heuristic
// elsewhere in this file: a literal `>` inside a plain string prop value (e.g.
// `title="a > b"`) can still end the scan early. Rare enough in practice not to
// warrant full string-aware parsing here.
function tagBodyAt(text, start) {
  let depth = 0;
  for (let i = start; i < Math.min(text.length, start + TAG_SCAN_LIMIT); i++) {
    const c = text[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (depth <= 0 && c === '>') return text.slice(start, i + 1);
  }
  return text.slice(start, start + TAG_SCAN_LIMIT);
}

function appearanceHits(files) {
  const found = [];
  for (const f of files) {
    const tags = systemTagsIn(f);
    if (tags.size === 0) continue;
    const text = readLines(f).join('\n');
    const consts = fileConstants(text);
    OPEN_TAG_RE.lastIndex = 0;
    let m;
    while ((m = OPEN_TAG_RE.exec(text))) {
      const tag = m[1];
      if (!tags.has(tag)) continue;
      const classes = classTokensOf(tagBodyAt(text, OPEN_TAG_RE.lastIndex), consts);
      if (classes.length === 0) continue;
      const line = text.slice(0, m.index).split('\n').length;
      for (const cls of classes) {
        const kind = appearanceViolation(cls);
        if (kind) found.push(`${f}:${line}: <${tag}> ${cls} (${kind})`);
      }
    }
  }
  return found;
}

// ---- props spread onto a design-system component ----
//
// `<Button {...props}>` passes whatever the caller sends, className and style
// included, so a wrapper that forwards props lets any call site restyle the
// component where no check can see it. Only a spread written as an attribute of the
// tag counts; `onClick={() => f(...args)}` and `style={{...base}}` are inside an
// expression, not on the tag. Component directories aren't linted at all: composing
// one design-system component from another is how the system is built, and those
// files are guarded by approval.
//
// Exempt, because they are how forms are wired and carry only value, handlers,
// name and ref: a spread of a call (`{...register('email')}`, `{...getInputProps()}`)
// and react-hook-form's `{...field}`.
const SPREAD_CALL_RE = /^[A-Za-z_$][\w$]*(\??\.[A-Za-z_$][\w$]*)*\s*\([\s\S]*\)$/;
const SPREAD_EXEMPT_NAMES = new Set(['field']);

// Each `{...expr}` at the top level of a tag body: [offset, expr].
function tagSpreads(body) {
  const out = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        const inner = body.slice(start + 1, i).trim();
        if (inner.startsWith('...')) out.push([start, inner.slice(3).trim()]);
        start = -1;
      }
    }
  }
  return out;
}

function spreadHits(files) {
  const found = [];
  for (const f of files) {
    const tags = systemTagsIn(f);
    if (tags.size === 0) continue;
    const text = readLines(f).join('\n');
    OPEN_TAG_RE.lastIndex = 0;
    let m;
    while ((m = OPEN_TAG_RE.exec(text))) {
      const tag = m[1];
      if (!tags.has(tag)) continue;
      const bodyStart = OPEN_TAG_RE.lastIndex;
      for (const [offset, expr] of tagSpreads(tagBodyAt(text, bodyStart))) {
        if (SPREAD_EXEMPT_NAMES.has(expr) || SPREAD_CALL_RE.test(expr)) continue;
        const line = text.slice(0, bodyStart + offset).split('\n').length;
        found.push(`${f}:${line}: <${tag}> {...${expr.replace(/\s+/g, ' ')}}`);
      }
    }
  }
  return found;
}

// ---- variant / size values a component doesn't declare ----
//
// `<Button variant="ghostly">` passes every other check: Button is approved and no
// class is overridden. But "ghostly" isn't one of Button's variants, so it renders
// the default (or nothing sensible) while reading as a deliberate choice. The
// declared values come from the component's own source (string unions on the
// variant/size props, or a cva `variants:` block), read by scan-core.
//
// Silent when it can't be sure: a dynamic value (`variant={v}`), a component whose
// values can't be read (imported from elsewhere, `ButtonProps['variant']`), or a
// file with several `variants:` blocks, where there's no telling which belongs to
// which export.
const CHECKED_GROUPS = ['variant', 'size'];

function declaredVariants() {
  const files = {};
  for (const dir of COMPONENT_DIRS.filter(isDir)) {
    for (const f of filesUnder(dir, COMPONENT_EXTS)) files[f] = readWorkingFile(f) ?? '';
  }
  const out = new Map(); // component key -> { variant: [...], size: [...] }
  for (const c of scanProject({ files, componentDirs: COMPONENT_DIRS.filter(isDir) })) {
    if ((files[c.file].match(/\bvariants\s*:\s*\{/g) || []).length > 1) continue;
    out.set(c.key, c.variants);
  }
  return out;
}

// Local tag name -> component key, for imports from a configured component directory.
function systemImportsIn(file) {
  const tags = new Map();
  const text = readLines(file).join('\n');
  for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    const key = resolveImportKey(file, m[2], COMPONENT_DIRS);
    if (!key) continue;
    for (const spec of m[1].split(',')) {
      const name = (spec.split(/\s+as\s+/).pop() || '').trim();
      if (/^[A-Z]/.test(name)) tags.set(name, key);
    }
  }
  return tags;
}

// The tag body with every brace group removed except a lone string literal
// (`{"ghost"}`), so a prop on a nested element inside an expression
// (`render={() => <X variant="a" />}`) isn't read as this tag's.
function topLevelAttrs(body) {
  let out = '';
  let depth = 0;
  let start = -1;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) {
        const inner = body.slice(start, i + 1);
        out += /^\{\s*(["'])[^"'{}]*\1\s*\}$/.test(inner) ? inner : '{}';
      }
    } else if (depth === 0) {
      out += c;
    }
  }
  return out;
}

const VARIANT_ATTR_RE = /(?:^|\s)(variant|size)=(?:"([^"]*)"|'([^']*)'|\{\s*["']([^"']*)["']\s*\})/g;

function variantHits(files) {
  const found = [];
  let declared = null; // read the component directories once, only if needed
  for (const f of files) {
    const imports = systemImportsIn(f);
    if (imports.size === 0) continue;
    declared ??= declaredVariants();
    const text = readLines(f).join('\n');
    OPEN_TAG_RE.lastIndex = 0;
    let m;
    while ((m = OPEN_TAG_RE.exec(text))) {
      const key = imports.get(m[1]);
      const groups = key && declared.get(key);
      if (!groups) continue;
      const line = text.slice(0, m.index).split('\n').length;
      for (const a of topLevelAttrs(tagBodyAt(text, OPEN_TAG_RE.lastIndex)).matchAll(VARIANT_ATTR_RE)) {
        const [, group] = a;
        const value = a[2] ?? a[3] ?? a[4];
        const allowed = groups[group];
        if (!CHECKED_GROUPS.includes(group) || !allowed?.length || allowed.includes(value)) continue;
        found.push(`${f}:${line}: <${m[1]}> ${group}="${value}" — declared: ${allowed.join(', ')}`);
      }
    }
  }
  return found;
}

// ---- hand-rolled interactive elements ----
//
// <button> and friends are caught by pattern. The same control built from a plain
// element is not: `<div role="button" onClick={…}>` styled to look like Button.
// An interactive role or an onClick on a plain element means a control was built
// by hand instead of taken from the system (and usually without keyboard support).
const HAND_ROLLED_OPEN_RE = /<(div|span|a|li)(?![\w-])/g;
const INTERACTIVE_ROLES = new Set([
  'button', 'tab', 'tablist', 'dialog', 'alertdialog', 'menu', 'menuitem',
  'checkbox', 'switch', 'radio', 'combobox', 'listbox',
]);

// A link carrying a surface (background), a shape (rounded) and padding is a
// button in a link's clothes. A heuristic, so it warns rather than fails.
const isSurface = (c) => /^(bg-(?!transparent\b|none\b)|bg-\[)/.test(utilityOf(c));
const isShape = (c) => /^rounded(-|$)/.test(utilityOf(c));
const isPadding = (c) => /^p[xytrbl]?-/.test(utilityOf(c));

function handRolledHits(files) {
  const errors = [];
  const warnings = [];
  for (const f of files) {
    const text = readLines(f).join('\n');
    if (!/<(div|span|a|li)\b/.test(text)) continue;
    const consts = fileConstants(text);
    HAND_ROLLED_OPEN_RE.lastIndex = 0;
    let m;
    while ((m = HAND_ROLLED_OPEN_RE.exec(text))) {
      const tag = m[1];
      const body = tagBodyAt(text, HAND_ROLLED_OPEN_RE.lastIndex);
      const attrs = topLevelAttrs(body);
      const line = text.slice(0, m.index).split('\n').length;
      const why = [];
      const role = attrs.match(/(?:^|\s)role=(?:"([^"]*)"|'([^']*)'|\{\s*["']([^"']*)["']\s*\})/);
      const roleValue = role && (role[1] ?? role[2] ?? role[3]);
      if (roleValue && INTERACTIVE_ROLES.has(roleValue)) why.push(`role="${roleValue}"`);
      if ((tag === 'div' || tag === 'span') && /(?:^|\s)onClick=/.test(attrs)) why.push('onClick');
      if (why.length) {
        errors.push(`${f}:${line}: <${tag} ${why.join(' ')}>`);
        continue;
      }
      if (tag === 'a') {
        const cls = classTokensOf(body, consts);
        if (cls.some(isSurface) && cls.some(isShape) && cls.some(isPadding)) {
          warnings.push(`${f}:${line}: <a> ${cls.filter((c) => isSurface(c) || isShape(c) || isPadding(c)).join(' ')}`);
        }
      }
    }
  }
  return { errors, warnings };
}

// ---- colour utilities that aren't one of the project's tokens ----
//
// The palette check catches Tailwind's defaults (bg-white, text-gray-500). A
// project's own off-system colour (bg-brand-legacy, text-promo) passed: it isn't
// the default palette, and nothing compared it with the tokens the project
// actually defines. The tokens are read from the project's CSS at check time:
//   --color-<name>: …   Tailwind v4 @theme (shadcn v4 maps its tokens this way)
//   --<name>: <colour>  CSS variables with a colour value (shadcn v3's :root/.dark)
// A colour utility on a plain element or a third-party component must use one of
// them. Design-system components aren't checked here: any appearance class on
// them is already an override finding.

const COLOUR_PREFIXES = ['bg', 'text', 'border', 'ring', 'outline', 'shadow', 'decoration', 'fill', 'stroke',
  'divide', 'from', 'via', 'to', 'accent', 'caret', 'placeholder'];
const PALETTE_RE = /^(white|black|gray|slate|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)(-[0-9]{2,3})?$/;
const ALWAYS_OK = new Set(['transparent', 'current', 'currentColor', 'inherit']);
// Values that share a colour prefix but aren't colours.
const NON_COLOUR = {
  bg: /^(fixed|local|scroll|auto|cover|contain|none|repeat|no-repeat|repeat-[xy]|repeat-round|repeat-space|bottom|center|left|left-bottom|left-top|right|right-bottom|right-top|top|(clip|origin|blend|gradient|linear|radial|conic|position|size)-.*)$/,
  text: /^(left|center|right|justify|start|end|wrap|nowrap|balance|pretty|ellipsis|clip|xs|sm|base|lg|xl|[2-9]xl|shadow.*)$/,
  border: /^(dashed|solid|dotted|double|hidden|none|collapse|separate|spacing.*)$/,
  ring: /^(inset)$/,
  outline: /^(none|dashed|dotted|double|solid|hidden)$/,
  shadow: /^(xs|sm|md|lg|xl|2xl|inner|none)$/,
  decoration: /^(solid|double|dotted|dashed|wavy|auto|from-font|clone|slice)$/,
  fill: /^(none)$/,
  stroke: /^(none)$/,
  divide: /^(x|y|x-reverse|y-reverse|dashed|solid|dotted|double|none)$/,
  accent: /^(auto)$/,
  caret: /^(auto)$/,
};

// Looks like a CSS colour value: named functions, hex, or shadcn v3's bare
// "222.2 84% 4.9%" HSL channels.
const COLOUR_VALUE_RE = /^(#[0-9a-f]{3,8}\b|(rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|color|color-mix|light-dark)\(|var\(--|-?\d+(\.\d+)?(deg)?\s+-?\d+(\.\d+)?%\s+-?\d+(\.\d+)?%)/i;

function projectColourTokens() {
  const tokens = new Set();
  const utilities = new Set(); // class names the project defines itself
  for (const f of filesUnder('.', ['.css', '.scss'])) {
    const css = readLines(f).join('\n');
    for (const m of css.matchAll(/--color-([A-Za-z0-9_-]+)\s*:\s*([^;]+);/g)) {
      if (m[1] !== '*' && !/^initial$/.test(m[2].trim())) tokens.add(m[1]);
    }
    for (const m of css.matchAll(/--([A-Za-z][A-Za-z0-9_-]*)\s*:\s*([^;]+);/g)) {
      if (!m[1].startsWith('color-') && COLOUR_VALUE_RE.test(m[2].trim())) tokens.add(m[1]);
    }
    for (const m of css.matchAll(/@utility\s+([A-Za-z0-9_-]+)/g)) utilities.add(m[1]);
    for (const m of css.matchAll(/\.([A-Za-z][A-Za-z0-9_-]*)(?=[\s,{:.>+~[])/g)) utilities.add(m[1]);
  }
  return { tokens, utilities };
}

// The colour a utility names, or null when it isn't a colour utility at all.
function colourOf(cls) {
  const bare = utilityOf(cls).replace(/^!/, '').replace(/!$/, '');
  const m = bare.match(new RegExp(`^(${COLOUR_PREFIXES.join('|')})-(.+)$`));
  if (!m) return null;
  let [, prefix, value] = m;
  value = value.replace(/\/[\w.[\]%-]+$/, ''); // opacity modifier: bg-primary/50
  if (prefix === 'border' || prefix === 'divide') value = value.replace(/^(x|y|t|r|b|l|s|e)-/, '');
  if (prefix === 'ring' || prefix === 'outline') value = value.replace(/^offset-/, '');
  if (/^[\d[(]/.test(value) || !/[a-z]/i.test(value)) return null; // sizes, arbitrary values (own check)
  if (NON_COLOUR[prefix]?.test(value)) return null;
  if (prefix === 'border' && /^(x|y|t|r|b|l|s|e)$/.test(value)) return null;
  return value;
}

const ANY_OPEN_TAG_RE = /<([A-Za-z][\w.]*)(?![\w-])/g;

function tokenHits(files) {
  const found = [];
  let seen = false; // any custom colour utility at all — decides whether "no tokens" is worth saying
  let project = null;
  for (const f of files) {
    const text = readLines(f).join('\n');
    if (!/className=/.test(text)) continue;
    const system = systemTagsIn(f);
    const consts = fileConstants(text);
    ANY_OPEN_TAG_RE.lastIndex = 0;
    let m;
    while ((m = ANY_OPEN_TAG_RE.exec(text))) {
      if (system.has(m[1])) continue;
      const classes = classTokensOf(tagBodyAt(text, ANY_OPEN_TAG_RE.lastIndex), consts);
      for (const cls of classes) {
        const colour = colourOf(cls);
        if (!colour || ALWAYS_OK.has(colour) || PALETTE_RE.test(colour)) continue; // palette: its own check
        seen = true;
        project ??= projectColourTokens();
        if (project.tokens.size === 0 || project.tokens.has(colour) || project.utilities.has(utilityOf(cls))) continue;
        const line = text.slice(0, m.index).split('\n').length;
        found.push(`${f}:${line}: <${m[1]}> ${cls} — "${colour}" is not a colour token`);
      }
    }
  }
  return { found, noTokens: seen && project !== null && project.tokens.size === 0 };
}

function unlistedComponentDirs() {
  // Component directories the project has but `components:` doesn't list. Without
  // this, an incomplete key narrows the check silently: an unlisted directory is
  // never examined, which looks exactly like a directory with no violations.
  const excluded = [...COMPONENT_DIRS, ...IGNORE_DIRS];
  const out = new Set();

  // Directly holds component-shaped files — checked per directory, so a directory
  // of subdirectories doesn't count on its children's behalf.
  const holdsComponents = (dir) => {
    try {
      return readdirSync(dir, { withFileTypes: true }).some(
        (e) => e.isFile() && LINT_EXTS.some((x) => e.name.endsWith(x))
      );
    } catch {
      return false;
    }
  };

  const visit = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_DIRS.has(e.name)) continue;
      const full = norm(join(dir, e.name));
      const covered = excluded.some((c) => full === c || full.startsWith(c + '/'));
      if (!covered && /(^|\/)components?(\/|$)/i.test(full) && holdsComponents(full)) {
        out.add(full);
      }
      visit(full);
    }
  };

  visit('.');
  return [...out].sort();
}

// ---- baseline ----
//
// On an existing codebase, every old violation fails CI from day one, so teams
// either never turn the check on or learn to ignore it. A baseline records today's
// findings once (--baseline-write) and the check then fails only on new ones.
// Recorded findings stay listed as a count, and the file shrinks as they're fixed.
// Writing or growing it is approval in bulk: --added-markers reports any entry it
// gains.

const BASELINE_FILE = 'design-guard.baseline.json';

// A finding's identity without its line number, so edits elsewhere in the file
// don't turn recorded findings into new ones. Identical findings in one file are
// counted, not collapsed.
const fingerprint = (section, line) => `${section} | ${line.replace(/^([^\s:]+):\d+:/, '$1:').replace(/\s+/g, ' ').trim()}`;

function readBaseline(text) {
  if (text == null) return null;
  try {
    const data = JSON.parse(text);
    return new Map(Object.entries(data.findings ?? {}).filter(([, n]) => Number.isInteger(n) && n > 0));
  } catch {
    return null;
  }
}

function makeReporter(baseline) {
  const remaining = new Map(baseline ?? []);
  const all = new Map(); // fingerprint -> count, for --baseline-write
  let hits = 0;
  let recorded = 0;
  return {
    // A section of findings. `baselinable: false` for configuration problems,
    // which are decisions to make, not debt to record.
    section(title, lines, notes = [], { baselinable = true } = {}) {
      let shown = lines;
      if (baselinable) {
        for (const l of lines) {
          const k = fingerprint(title, l);
          all.set(k, (all.get(k) ?? 0) + 1);
        }
        shown = lines.filter((l) => {
          const k = fingerprint(title, l);
          const n = remaining.get(k) ?? 0;
          if (n === 0) return true;
          remaining.set(k, n - 1);
          recorded++;
          return false;
        });
      }
      if (shown.length === 0) return;
      console.log(`== ${title}`);
      shown.forEach((l) => console.log(l));
      console.log('');
      if (notes.length) {
        notes.forEach((n) => console.log(`   ${n}`));
        console.log('');
      }
      hits = 1;
    },
    note(lines) {
      lines.forEach((l) => console.log(l));
      console.log('');
    },
    fail() {
      hits = 1;
    },
    get hits() {
      return hits;
    },
    get recorded() {
      return recorded;
    },
    get fixed() {
      return [...remaining.values()].reduce((a, b) => a + b, 0);
    },
    all,
  };
}

function lint(targets, { baselineMode = 'use' } = {}) {
  const baseline = baselineMode === 'use' ? readBaseline(readWorkingFile(BASELINE_FILE)) : null;
  if (baselineMode === 'use' && readWorkingFile(BASELINE_FILE) !== null && baseline === null) {
    console.log(`== ${BASELINE_FILE} could not be read — ignoring it, every finding is shown`);
    console.log('');
  }
  const r = makeReporter(baseline);
  const quiet = baselineMode === 'write';
  const log = console.log;
  if (quiet) console.log = () => {};

  const files = [...new Set(targets.flatMap((t) => filesUnder(t, LINT_EXTS)))]
    .filter((f) => !inComponentDir(f))
    .sort();

  for (const [label, re] of PATTERNS) {
    const found = [];
    for (const f of files) {
      const lines = readLines(f);
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i])) found.push(`${f}:${i + 1}:${lines[i]}`);
      }
    }
    r.section(label, found);
  }

  if (TYPOGRAPHY_BASE) {
    r.section('typography utilities on semantic text elements', semanticTypographyHits(files), [
      'Layout utilities (mt-4, max-w-md, flex) stay legal on these elements.',
      'Delete the utility when the base layer already produces it; park it when',
      'the value is one the scale does not have.',
    ]);
  } else if (!TYPOGRAPHY_BASE_DECLARED) {
    // Key absent. Whether that is a gap or a genuine "off" depends on the CSS.
    const base = detectBaseLayer();
    if (base) {
      r.note([
        '== typography-base is not set, but a base layer styles semantic elements',
        `   ${base.file}  ->  ${base.selector}`,
        '',
        '   Typography utilities on headings, paragraphs and links are going',
        '   unchecked against a base layer that already sets them. Set',
        '   `typography-base: true` in design-guard.config (or context/STACK.md) to check them.',
      ]);
      r.fail();
    } else {
      r.note([
        '== typography check off — no base layer found styling semantic elements',
        '   Record it: `typography-base: false` in design-guard.config (or context/STACK.md). This line',
        '   stops once the decision is written down.',
      ]);
    }
  }

  const tokenCheck = tokenHits(files);
  r.section("colour utility that isn't a project token", [...new Set(tokenCheck.found)], [
    "Tokens are read from the project's CSS (--color-* in @theme, or colour",
    'variables like --primary). Use the token that matches; if none does, that',
    'is a design decision: park it and propose the token.',
  ]);
  if (tokenCheck.noTokens) {
    r.note([
      '== token check off — no colour tokens found in the project CSS',
      '   Custom colour utilities are in use, but no --color-* or colour variables were',
      '   found to check them against. Only the default palette is being checked.',
    ]);
  }

  const handRolled = handRolledHits(files);
  r.section('hand-rolled interactive element', handRolled.errors, [
    'A plain element given an interactive role or a click handler is a control',
    'built by hand. Use the design-system component (Button, Tabs, Dialog,',
    'Checkbox...). If none exists, park it and propose one.',
  ]);

  r.section("variant or size the component doesn't declare", variantHits(files), [
    'Use one of the declared values. If none fits, that is the finding: park it',
    'and propose the variant, rather than passing a value the component ignores.',
  ]);

  r.section('props spread onto a design-system component', spreadHits(files), [
    'A spread passes className and style through unchecked, so any caller can',
    'restyle the component. Pass the props the component needs by name. Form',
    "wiring ({...field}, {...register('x')}) is allowed.",
  ]);

  r.section('appearance override on a design-system component', appearanceHits(files), [
    'Semantic tokens are not an exception here. Layout classes (spacing, flex,',
    'grid, size, position) stay legal. If the component has no variant for this,',
    'that is the finding: park it and propose the variant.',
  ]);

  r.section('component directories not listed in components:', unlistedComponentDirs().map((d) => `  ${d}`), [
    'These are never examined, so their components are neither approved nor',
    'flagged. Add each to components: in design-guard.config (or context/STACK.md), or record it under',
    'components-ignore: to say the exclusion is deliberate.',
  ], { baselinable: false });

  const existing = COMPONENT_DIRS.filter(isDir);
  if (existing.length === 0) {
    console.log = log;
    console.log(
      '== component directory not found (set components: in design-guard.config (or context/STACK.md)) — approval cannot be verified'
    );
    console.log(`   looked for: ${COMPONENT_DIRS.join(' ')}`);
    console.log('');
    return quiet ? 2 : 1;
  }

  const approved = new Set();
  const deprecated = new Map(); // key -> replacement name or null
  for (const dir of existing) {
    for (const f of filesUnder(dir, COMPONENT_EXTS)) {
      if (isMarked(f)) approved.add(componentKey(dir, f));
      const d = deprecationOf(readLines(f).join('\n'));
      if (d) deprecated.set(componentKey(dir, f), d.replacement);
    }
  }

  if (approved.size === 0) {
    r.note([
      `== no component in ${existing.join(' ')} carries an @approved marker`,
      `   (looked in the first ${MARKER_WINDOW} lines of each file)`,
      '   Every component below is therefore unapproved. If that looks wrong, a human',
      '   marks components — agents never add @approved on their own initiative.',
    ]);
  }

  const unapproved = new Set();
  const outgoing = new Set();
  for (const hit of importsIn(files)) {
    // Deprecation outranks approval, and one finding per use is enough.
    if (deprecated.has(hit.key)) {
      const use = deprecated.get(hit.key);
      outgoing.add(`${hit.file}  ->  ${hit.key}${use ? `  (use ${use} instead)` : ''}`);
    } else if (!approved.has(hit.key)) {
      unapproved.add(`${hit.file}  ->  ${hit.key}`);
    }
  }

  r.section('deprecated component in use', [...outgoing].sort(), [
    'Marked @deprecated in its own file: the team is phasing it out. Move each use',
    'to the replacement. If there is none, or it does not fit, park it.',
  ]);
  r.section('component used but not marked @approved', [...unapproved].sort());

  if (handRolled.warnings.length) {
    r.note([
      '== warning (does not fail the check): link styled as a button',
      ...handRolled.warnings,
      '',
      '   A link with a background, rounded corners and padding is usually a button',
      '   in disguise. If it should look like one, use Button (asChild, or its link',
      '   variant) so it stays in the system. A heuristic: judge each one.',
    ]);
  }

  console.log = log;

  if (quiet) {
    const findings = Object.fromEntries([...r.all].sort(([a], [b]) => a.localeCompare(b)));
    const total = [...r.all.values()].reduce((a, b) => a + b, 0);
    writeFileSync(
      BASELINE_FILE,
      JSON.stringify(
        {
          about: 'Design Guard baseline: findings recorded on purpose, so the check fails only on new ones. Written by `ds-lint --baseline-write`; only a human decides to write or grow it.',
          findings,
        },
        null,
        2
      ) + '\n'
    );
    console.log(`Recorded ${total} finding(s) in ${BASELINE_FILE}.`);
    console.log('From now on the check fails only on findings not in it. It shrinks as they are');
    console.log('fixed: re-run --baseline-write after fixing some to lock that in.');
    return 0;
  }

  if (r.recorded > 0) {
    console.log(`${r.recorded} existing finding(s) recorded in ${BASELINE_FILE}, not shown (--no-baseline shows them).`);
  }
  if (r.fixed > 0) {
    console.log(`${r.fixed} recorded finding(s) no longer occur. Re-run --baseline-write to shrink the baseline.`);
  }
  if (r.recorded > 0 || r.fixed > 0) console.log('');

  if (r.hits === 0) console.log('Design system check: clean');
  return r.hits;
}

// ---- mode: --codeowners ----
// Prints CODEOWNERS lines for every file that decides what counts as approved, so a
// change to any of them needs a design-system owner's review on GitHub. Generated
// from the config each time, so there is no second list to keep in sync. Prints
// only; the human pastes it in.

const OWNER_RE = /^(@[A-Za-z0-9][\w.-]*(\/[\w.-]+)?|[^@\s]+@[^@\s]+\.[^@\s]+)$/;
const CODEOWNERS_LOCATIONS = ['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS'];

function gitOut(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

// CODEOWNERS paths: anchored at the repository root, spaces escaped.
const ownersPath = (p, dir = false) => `/${p.replace(/ /g, '\\ ')}${dir ? '/' : ''}`;

function codeownersMode(owners) {
  if (owners.length === 0) {
    console.error('ds-lint: --codeowners needs at least one owner, e.g. --codeowners @acme/design-system');
    return 2;
  }
  const bad = owners.filter((o) => !OWNER_RE.test(o));
  if (bad.length > 0) {
    console.error(`ds-lint: not a GitHub owner: ${bad.join(' ')} (use @user, @org/team or an email)`);
    return 2;
  }

  // Paths in CODEOWNERS are relative to the repository root, the project may be a
  // subdirectory of it.
  const top = gitOut(['rev-parse', '--show-toplevel']);
  const prefix = top === null ? '' : gitOut(['rev-parse', '--show-prefix']) ?? '';
  const root = top ?? '.';
  const who = owners.join(' ');
  const lines = [];

  for (const d of COMPONENT_DIRS) lines.push(`${ownersPath(prefix + d, true)} ${who}`);

  // design-guard.config always, even before it exists: it takes precedence, so
  // creating one would override keys kept in context/STACK.md. STACK.md when present.
  const configs = CONFIG_FILES.filter((f, i) => i === 0 || readWorkingFile(f) !== null);
  for (const f of configs) lines.push(`${ownersPath(prefix + f)} ${who}`);
  // The baseline, always: writing one records findings so they stop failing.
  lines.push(`${ownersPath(prefix + BASELINE_FILE)} ${who}`);

  const listed = gitOut(['ls-files', '--cached', '--others', '--exclude-standard', '--full-name'], root);
  const policies = (listed === null ? [...walk('.')].map(norm) : listed.split('\n'))
    .filter((f) => basename(f) === EXCEPTIONS_FILE)
    .sort();
  for (const f of policies) lines.push(`${ownersPath(f)} ${who}`);

  // The CODEOWNERS file itself, or anyone could take the entries above out.
  const existing = CODEOWNERS_LOCATIONS.find((f) => readWorkingFile(join(root, f)) !== null);
  lines.push(`${ownersPath(existing ?? CODEOWNERS_LOCATIONS[0])} ${who}`);

  console.log('# Design Guard: what counts as approved. Changes here need a design-system owner.');
  console.log('# Generated by ds-lint --codeowners; re-run it when design-guard.config changes.');
  if (policies.length === 0) console.log(`# (no ${EXCEPTIONS_FILE} found; re-run after installing the skill)`);
  for (const l of lines) console.log(l);
  return 0;
}

// ---- dispatch ----

const argv = process.argv.slice(2);

if (argv[0] === '--added-markers') {
  process.exit(addedMarkers(argv[1] || 'main...HEAD'));
} else if (argv[0] === '--codeowners') {
  process.exit(codeownersMode(argv.slice(1)));
} else if (argv[0] === '--approve' || argv[0] === '--unapprove') {
  process.exit(approveMode(argv[0] === '--approve', argv.slice(1)));
} else if (argv[0] === '--serve') {
  const code = serveMode(argv.slice(1));
  if (code !== null) process.exit(code);
} else if (argv[0] === '--scan') {
  process.exit(scanMode(argv[1] || '.'));
} else if (argv[0] === '--registry') {
  process.exit(registry(argv[1] || '.'));
} else {
  let targets = argv.filter((a) => !a.startsWith('--'));
  if (targets.length === 0) {
    targets = ['src/routes', 'src/components'].filter(isDir);
    if (targets.length === 0) targets = ['src'];
  }
  const baselineMode = argv.includes('--baseline-write') ? 'write' : argv.includes('--no-baseline') ? 'ignore' : 'use';
  process.exit(lint(targets, { baselineMode }));
}
