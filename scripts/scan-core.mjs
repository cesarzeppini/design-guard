// design-guard scan core — pure and dependency-free: text in, data out.
//
// No node: imports on purpose. The CLI (ds-lint.mjs) feeds it files read from disk;
// the /components page feeds it the same files as raw text from the bundler. One
// implementation, so the page and the linter can never disagree about what is
// approved, imported, or a variant.

// A component is approved when @approved appears in a comment within the first
// MARKER_WINDOW lines of its own file. The window is deliberate: the marker has to
// be where a human opening the file sees it, not buried at the bottom.
export const MARKER_WINDOW = 5;
export const MARKER_RE = /(^|[\s/*#{])@approved(\s|$)/;

export const LINT_EXTS = ['.tsx', '.jsx'];
export const COMPONENT_EXTS = ['.tsx', '.jsx', '.ts'];

export const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
export const norm = (p) => p.replace(/^\.?\//, '').replace(/\/+$/, '');
const baseName = (f) => f.split('/').pop().replace(/\.[^.]+$/, '');

// Import specifiers use whatever alias the project prefers (@/, ~/, ../), so match
// each directory's path tail rather than assuming one.
export const tailOf = (d) => norm(d).replace(/^src\//, '');

export function importMatchers(componentDirs) {
  const alt = componentDirs.map(tailOf).map(esc).join('|');
  return {
    IMPORT_RE: alt ? new RegExp(`from\\s+["'][^"']*(?:${alt})/[A-Za-z0-9_-]+["']`) : null,
    KEY_RE: alt ? new RegExp(`(?:${alt})/[A-Za-z0-9_-]+`) : null,
  };
}

export const componentKey = (dir, file) => `${tailOf(dir)}/${baseName(file)}`;

export const isMarkedText = (text) =>
  text.replace(/^\uFEFF/, '').split(/\r?\n/).slice(0, MARKER_WINDOW).some((l) => MARKER_RE.test(l));

const NON_COMPONENT_RE = /\.(test|spec|stories)\.[jt]sx?$|\.d\.ts$/;

// Index of the brace that closes the one at `open`, skipping string literals.
// -1 when unbalanced. Template literals with ${} nest braces; those are rare in
// the prop/variant blocks this is used on, and a miss just yields no props.
function matchBrace(text, open) {
  let depth = 0;
  let quote = null;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i;
  }
  return -1;
}

const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

// Split a member list at top level only: commas/semicolons/newlines inside nested
// braces, parens or brackets belong to the member, not between members.
function splitMembers(body) {
  const out = [];
  let depth = 0;
  let quote = null;
  let cur = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) {
      cur += c;
      if (c === '\\') cur += body[++i] ?? '';
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    if ('{[('.includes(c)) depth++;
    else if ('}])'.includes(c)) depth--;
    if (depth === 0 && (c === ',' || c === ';' || c === '\n')) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const stringLiterals = (t) => [...t.matchAll(/["']([^"'\n]+)["']/g)].map((m) => m[1]);

function propsOf(src) {
  const props = [];
  const seen = new Set();
  const re = /(?:interface|type)\s+(\w*Props\w*)\b[^{=]*?(?:=\s*)?(?:[\w.<>,\s&]*?&\s*)?\{/g;
  const opens = [...src.matchAll(re)].map((m) => m.index + m[0].length - 1);
  // No named Props type: fall back to an inline annotation, `({ a, b }: { a: string })`.
  if (!opens.length) {
    const inline = src.match(/\}\s*:\s*\{/);
    if (inline) opens.push(inline.index + inline[0].length - 1);
  }
  for (const open of opens) {
    const close = matchBrace(src, open);
    if (close < 0) continue;
    for (const member of splitMembers(src.slice(open + 1, close))) {
      const mm = member.match(/^(?:readonly\s+)?(['"]?[\w-]+['"]?)(\?)?\s*:\s*([\s\S]+)$/);
      if (!mm) continue;
      const name = mm[1].replace(/['"]/g, '');
      if (seen.has(name)) continue;
      seen.add(name);
      props.push({ name, optional: !!mm[2], type: mm[3].replace(/\s+/g, ' ').trim() });
    }
  }
  return props;
}

// Variant values from three places, merged: string unions on `variant`/`size`
// props (following one `type X = "a" | "b"` alias), and cva-style
// `variants: { variant: { default: ..., outline: ... } }` objects.
function variantsOf(src, props) {
  const out = {};
  const add = (group, vals) => {
    if (!vals.length) return;
    out[group] = [...new Set([...(out[group] || []), ...vals])];
  };

  const aliasValues = (typeText) => {
    const direct = stringLiterals(typeText);
    if (direct.length) return direct;
    const id = typeText.match(/^[A-Za-z_]\w*$/);
    if (!id) return [];
    const alias = src.match(new RegExp(`type\\s+${id[0]}\\s*=\\s*([^;\\n{]+(?:\\n\\s*\\|[^;\\n]+)*)`));
    return alias ? stringLiterals(alias[1]) : [];
  };
  for (const p of props) if (p.name === 'variant' || p.name === 'size') add(p.name, aliasValues(p.type));

  const cva = src.match(/variants\s*:\s*\{/);
  if (cva) {
    const open = cva.index + cva[0].length - 1;
    const close = matchBrace(src, open);
    if (close > 0) {
      for (const group of splitMembers(stripComments(src.slice(open + 1, close)))) {
        const gm = group.match(/^(\w+)\s*:\s*\{/);
        if (!gm) continue;
        const gOpen = group.indexOf('{', gm[0].length - 1);
        const gClose = matchBrace(group, gOpen);
        if (gClose < 0) continue;
        const names = splitMembers(group.slice(gOpen + 1, gClose))
          .map((v) => v.match(/^["']?([\w-]+)["']?\s*:/))
          .filter(Boolean)
          .map((v) => v[1]);
        add(gm[1], names);
      }
    }
  }
  return out;
}

const exportedName = (src, file) => {
  const m =
    src.match(/export\s+(?:default\s+)?(?:function|class)\s+([A-Z]\w*)/) ||
    src.match(/export\s+(?:const|let)\s+([A-Z]\w*)\s*[=:]/);
  return m ? m[1] : baseName(file);
};


const hasExt = (file, exts) => exts.some((x) => file.endsWith(x));

// files: { 'src/components/ui/button.tsx': '<source text>', ... } — the WHOLE
// project, not a diff: in a new project the entire codebase is the backlog, and a
// component in use since before the guard was installed appears in no diff.
export function scanProject({ files, componentDirs }) {
  const dirs = componentDirs.map(norm);
  const { IMPORT_RE, KEY_RE } = importMatchers(dirs);

  const importers = new Map(); // key -> Set of importing files
  if (IMPORT_RE) {
    for (const [file, text] of Object.entries(files)) {
      if (!hasExt(file, LINT_EXTS)) continue;
      for (const line of text.split('\n')) {
        if (!IMPORT_RE.test(line)) continue;
        const key = (line.match(KEY_RE) || [null])[0];
        if (!key) continue;
        if (!importers.has(key)) importers.set(key, new Set());
        importers.get(key).add(file);
      }
    }
  }

  const components = [];
  for (const dir of dirs) {
    for (const [file, src] of Object.entries(files)) {
      if (!file.startsWith(dir + '/') || !hasExt(file, COMPONENT_EXTS) || NON_COMPONENT_RE.test(file)) continue;
      const key = componentKey(dir, file);
      const usedBy = [...(importers.get(key) ?? [])].filter((f) => f !== file).sort();
      const approved = isMarkedText(src);
      const clean = stripComments(src);
      const props = propsOf(clean);
      const head = src.split('\n').slice(0, MARKER_WINDOW + 2).join('\n');
      components.push({
        key,
        name: exportedName(clean, file),
        file,
        dir,
        approved,
        unstyledByDesign: approved && /unstyled/i.test(head),
        usageCount: usedBy.length,
        usedBy,
        status: approved
          ? usedBy.length ? 'approved' : 'approved-unused'
          : usedBy.length ? 'unmarked-in-use' : 'unmarked-unused',
        props,
        variants: variantsOf(clean, props),
      });
    }
  }
  return components.sort((a, b) => a.key.localeCompare(b.key));
}

// Numbers for the top of the page. "Adoption" is the share of component usage that
// goes through approved components: each (file, component) import counts once.
export function summarize(components, { files = {}, componentDirs = [], exclude = [] } = {}) {
  const count = (status) => components.filter((c) => c.status === status).length;
  const approvedUse = components.filter((c) => c.approved).reduce((n, c) => n + c.usageCount, 0);
  const totalUse = components.reduce((n, c) => n + c.usageCount, 0);

  // Raw interactive elements outside the system — the drift the page is meant to shrink.
  const dirs = componentDirs.map(norm);
  const skip = exclude.map(norm);
  let rawElements = 0;
  const rawFiles = new Set();
  for (const [file, text] of Object.entries(files)) {
    if (!hasExt(file, LINT_EXTS)) continue;
    if (dirs.some((d) => file.startsWith(d + '/')) || skip.some((d) => file.startsWith(d + '/'))) continue;
    const n = (text.match(/<(button|input|select|textarea)[\s>]/g) || []).length;
    if (n) {
      rawElements += n;
      rawFiles.add(file);
    }
  }

  return {
    total: components.length,
    approved: components.filter((c) => c.approved).length,
    approvedUnused: count('approved-unused'),
    decisionsWaiting: count('unmarked-in-use'),
    unused: count('unmarked-unused'),
    approvedUsage: approvedUse,
    totalUsage: totalUse,
    adoption: totalUse ? Math.round((approvedUse / totalUse) * 100) : null,
    rawElements,
    rawElementFiles: rawFiles.size,
  };
}
