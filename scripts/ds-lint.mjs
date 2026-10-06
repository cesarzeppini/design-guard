#!/usr/bin/env node
// design-system-guard mechanical linter.
//
// Usage:
//   ds-lint.mjs <file-or-dir> [...]          lint (defaults to src/)
//   ds-lint.mjs --added-markers <git-range>  audit @approved markers added in a range
//   ds-lint.mjs --registry [root]            inventory for the report's registry section
//   ds-lint.mjs --approve <file...>          add the @approved marker (a human's act — see SKILL.md)
//   ds-lint.mjs --unapprove <file...>        remove it
//   ds-lint.mjs --serve [--port N]           local API for the /components page's approve/revoke buttons
//   ds-lint.mjs --scan [root]                every component as JSON: status, usage, props, variants
//
// Exit 1 when any hit is found, 0 when clean. --registry always exits 0 (inventory,
// not a finding). --added-markers exits 1 when markers were added.
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
  importMatchers,
  isMarkedText,
  scanProject,
} from './scan-core.mjs';


const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);


// ---- config ----
// Keys are read from `design-guard.config` in the project root, falling back to
// `context/STACK.md` (the Found framework's location). Format: one `key: value`
// per line; anything else in the file is ignored, so STACK.md works unchanged.

const CONFIG_FILES = ['design-guard.config', 'context/STACK.md'];

function stackKey(name) {
  for (const file of CONFIG_FILES) {
    try {
      const text = readFileSync(file, 'utf8');
      const m = text.match(new RegExp(`^${name}:[ \\t]*(.*)$`, 'm'));
      if (m) return m[1].replace(/\s+#.*$/, '').trim();
    } catch {
      // file absent — try the next
    }
  }
  return '';
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

const { IMPORT_RE, KEY_RE } = importMatchers(COMPONENT_DIRS);

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
const importKey = (content) => (KEY_RE ? (content.match(KEY_RE) || [null])[0] : null);

function* importsIn(files) {
  if (!IMPORT_RE) return;
  for (const file of files) {
    const lines = readLines(file);
    for (let i = 0; i < lines.length; i++) {
      if (IMPORT_RE.test(lines[i])) {
        const key = importKey(lines[i]);
        if (key) yield { file, line: i + 1, content: lines[i], key };
      }
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

  const found = new Set();
  let file = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim();
      file = p === '/dev/null' ? null : p.replace(/^b\//, '');
    } else if (file && line.startsWith('+') && !line.startsWith('+++') && line.includes('@approved')) {
      found.add(file);
    }
  }

  if (found.size > 0) {
    console.log(`== @approved markers added in ${range}`);
    for (const f of [...found].sort()) console.log(`  ${f}`);
    console.log('');
    console.log('   Report each of these in the final report as a Needs-you item, naming who');
    console.log('   asked for it — including when a human did ask.');
    return 1;
  }
  console.log(`No @approved markers added in ${range}`);
  return 0;
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
  const approvedList = all.filter((c) => c.approved).map((c) => c.key);
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
const SEMANTIC_TAG_RE = new RegExp(`<(${TYPOGRAPHIC_ELEMENTS})\\s[^>]*className="([^"]*)"`, 'g');

const TEXT_SIZES = new Set(['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', '4xl', '5xl', '6xl', '7xl', '8xl', '9xl']);
const FONT_WEIGHTS = new Set(['thin', 'extralight', 'light', 'normal', 'medium', 'semibold', 'bold', 'extrabold', 'black']);
// Alignment and wrapping are layout, not typography — legal on any element.
const TEXT_LAYOUT = new Set(['left', 'center', 'right', 'justify', 'start', 'end', 'wrap', 'nowrap', 'balance', 'pretty', 'ellipsis', 'clip']);

function typographyViolation(cls) {
  const bare = cls.replace(/^[a-z-]+:/, ''); // drop variants like md: or hover:
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

function semanticTypographyHits(files) {
  const found = [];
  for (const f of files) {
    const lines = readLines(f);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      // A <label> wrapping a checkbox or radio is body copy, not a field title —
      // a text colour on it is legitimate. Same-line heuristic; a label split
      // across lines is not detected, and that is the accepted limit.
      const inlineControl = /type="(checkbox|radio)"/.test(line);
      for (const m of line.matchAll(SEMANTIC_TAG_RE)) {
        const [, tag, classNames] = m;
        for (const cls of classNames.split(/\s+/).filter(Boolean)) {
          const kind = typographyViolation(cls);
          if (!kind) continue;
          if (kind === 'text color' && tag === 'label' && inlineControl) continue;
          found.push(`${f}:${i + 1}: <${tag}> ${cls} (${kind}) — the base layer already sets this`);
        }
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
  if (!IMPORT_RE) return tags;
  const text = readLines(file).join('\n');
  for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    if (!KEY_RE || !KEY_RE.test(m[2])) continue;
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
  const bare = cls.replace(/^([a-z0-9-]+:)+/, '').replace(/^!/, '');
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
    OPEN_TAG_RE.lastIndex = 0;
    let m;
    while ((m = OPEN_TAG_RE.exec(text))) {
      const tag = m[1];
      if (!tags.has(tag)) continue;
      const body = tagBodyAt(text, OPEN_TAG_RE.lastIndex);
      const clsMatch = body.match(/className="([^"]*)"/);
      if (!clsMatch) continue;
      const line = text.slice(0, m.index).split('\n').length;
      for (const cls of clsMatch[1].split(/\s+/).filter(Boolean)) {
        const kind = appearanceViolation(cls);
        if (kind) found.push(`${f}:${line}: <${tag}> ${cls} (${kind})`);
      }
    }
  }
  return found;
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

function lint(targets) {
  let hits = 0;

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
    if (found.length) {
      console.log(`== ${label}`);
      found.forEach((l) => console.log(l));
      console.log('');
      hits = 1;
    }
  }

  if (TYPOGRAPHY_BASE) {
    const typo = semanticTypographyHits(files);
    if (typo.length) {
      console.log('== typography utilities on semantic text elements');
      typo.forEach((l) => console.log(l));
      console.log('');
      console.log('   Layout utilities (mt-4, max-w-md, flex) stay legal on these elements.');
      console.log('   Delete the utility when the base layer already produces it; park it when');
      console.log('   the value is one the scale does not have.');
      console.log('');
      hits = 1;
    }
  } else if (!TYPOGRAPHY_BASE_DECLARED) {
    // Key absent. Whether that is a gap or a genuine "off" depends on the CSS.
    const base = detectBaseLayer();
    if (base) {
      console.log('== typography-base is not set, but a base layer styles semantic elements');
      console.log(`   ${base.file}  ->  ${base.selector}`);
      console.log('');
      console.log('   Typography utilities on headings, paragraphs and links are going');
      console.log('   unchecked against a base layer that already sets them. Set');
      console.log('   `typography-base: true` in design-guard.config (or context/STACK.md) to check them.');
      console.log('');
      hits = 1;
    } else {
      console.log('== typography check off — no base layer found styling semantic elements');
      console.log('   Record it: `typography-base: false` in design-guard.config (or context/STACK.md). This line');
      console.log('   stops once the decision is written down.');
      console.log('');
    }
  }

  const appearance = appearanceHits(files);
  if (appearance.length) {
    console.log('== appearance override on a design-system component');
    appearance.forEach((l) => console.log(l));
    console.log('');
    console.log('   Semantic tokens are not an exception here. Layout classes (spacing, flex,');
    console.log('   grid, size, position) stay legal. If the component has no variant for this,');
    console.log('   that is the finding: park it and propose the variant.');
    console.log('');
    hits = 1;
  }

  const unlisted = unlistedComponentDirs();
  if (unlisted.length) {
    console.log('== component directories not listed in components:');
    unlisted.forEach((d) => console.log(`  ${d}`));
    console.log('');
    console.log('   These are never examined, so their components are neither approved nor');
    console.log('   flagged. Add each to components: in design-guard.config (or context/STACK.md), or record it under');
    console.log('   components-ignore: to say the exclusion is deliberate.');
    console.log('');
    hits = 1;
  }

  const existing = COMPONENT_DIRS.filter(isDir);
  if (existing.length === 0) {
    console.log(
      '== component directory not found (set components: in design-guard.config (or context/STACK.md)) — approval cannot be verified'
    );
    console.log(`   looked for: ${COMPONENT_DIRS.join(' ')}`);
    console.log('');
    return 1;
  }

  const approved = new Set();
  for (const dir of existing) {
    for (const f of filesUnder(dir, COMPONENT_EXTS)) {
      if (isMarked(f)) approved.add(componentKey(dir, f));
    }
  }

  if (approved.size === 0) {
    console.log(`== no component in ${existing.join(' ')} carries an @approved marker`);
    console.log(`   (looked in the first ${MARKER_WINDOW} lines of each file)`);
    console.log('   Every component below is therefore unapproved. If that looks wrong, a human');
    console.log('   marks components — agents never add @approved on their own initiative.');
    console.log('');
  }

  const unapproved = new Set();
  for (const hit of importsIn(files)) {
    if (!approved.has(hit.key)) unapproved.add(`${hit.file}  ->  ${hit.key}`);
  }

  if (unapproved.size > 0) {
    console.log('== component used but not marked @approved');
    [...unapproved].sort().forEach((l) => console.log(l));
    console.log('');
    hits = 1;
  }

  if (hits === 0) console.log('Design system check: clean');
  return hits;
}

// ---- dispatch ----

const argv = process.argv.slice(2);

if (argv[0] === '--added-markers') {
  process.exit(addedMarkers(argv[1] || 'main...HEAD'));
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
  process.exit(lint(targets));
}
