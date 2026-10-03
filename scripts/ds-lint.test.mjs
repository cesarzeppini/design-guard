// Tests for ds-lint.mjs. Run: node --test skills/checks/design-system-guard/scripts/
//
// Every case here corresponds to a bug the shell version actually shipped, or to a
// rule the guard depends on. They build a throwaway project in a temp directory and
// run the real script against it — no mocking, since the bugs were all in how the
// script read a real filesystem.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'ds-lint.mjs');

function project(files) {
  const root = mkdtempSync(join(tmpdir(), 'ds-lint-'));
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, body);
  }
  return root;
}

function run(root, args = []) {
  try {
    const stdout = execFileSync('node', [SCRIPT, ...args], { cwd: root, encoding: 'utf8' });
    return { code: 0, out: stdout };
  } catch (err) {
    return { code: err.status, out: (err.stdout || '') + (err.stderr || '') };
  }
}

const BASE = {
  'context/STACK.md': 'components: src/components/ui, src/components/app\n',
  'src/components/ui/button.tsx': '// @approved\nexport const Button = () => null;\n',
  'src/components/ui/popover.tsx': 'export const Popover = () => null;\n',
  'src/components/app/stat-tile.tsx': '/* @approved */\nexport const StatTile = () => null;\n',
};

test('flags unmarked components across every configured directory', () => {
  const root = project({
    ...BASE,
    'src/components/app/chart.tsx': 'export const Chart = () => null;\n',
    // ~/ alias, not @/ — the shell version hardcoded @/components/ui/ and saw none of this
    'src/routes/page.tsx': [
      'import { Button } from "~/components/ui/button";',
      'import { Popover } from "~/components/ui/popover";',
      'import { StatTile } from "~/components/app/stat-tile";',
      'import { Chart } from "~/components/app/chart";',
    ].join('\n'),
  });
  const { code, out } = run(root, ['src/routes']);
  assert.equal(code, 1);
  assert.match(out, /components\/ui\/popover/);
  assert.match(out, /components\/app\/chart/);
  assert.doesNotMatch(out, /components\/ui\/button/);
  assert.doesNotMatch(out, /components\/app\/stat-tile/);
  rmSync(root, { recursive: true, force: true });
});

test('relative import specifiers resolve like aliased ones', () => {
  const root = project({
    ...BASE,
    'src/routes/rel.tsx': 'import { Popover } from "../../components/ui/popover";\n',
  });
  const { out } = run(root, ['src/routes']);
  assert.match(out, /components\/ui\/popover/);
  rmSync(root, { recursive: true, force: true });
});

test('marker must sit within the first 5 lines', () => {
  const inWindow = project({
    ...BASE,
    'src/components/ui/popover.tsx': '// @approved\nexport const Popover = () => null;\n',
    'src/routes/page.tsx': 'import { Popover } from "~/components/ui/popover";\n',
  });
  assert.doesNotMatch(run(inWindow, ['src/routes']).out, /components\/ui\/popover/);
  rmSync(inWindow, { recursive: true, force: true });

  const outOfWindow = project({
    ...BASE,
    'src/components/ui/popover.tsx': '\n\n\n\n\n// @approved\nexport const Popover = () => null;\n',
    'src/routes/page.tsx': 'import { Popover } from "~/components/ui/popover";\n',
  });
  assert.match(run(outOfWindow, ['src/routes']).out, /components\/ui\/popover/);
  rmSync(outOfWindow, { recursive: true, force: true });
});

test('reports component directories missing from components:', () => {
  const root = project({
    'context/STACK.md': 'components: src/components/ui\n',
    'src/components/ui/button.tsx': '// @approved\nexport const Button = () => null;\n',
    'src/components/app/chart.tsx': 'export const Chart = () => null;\n',
    'src/components/icons/star.tsx': 'export const Star = () => null;\n',
  });
  const { code, out } = run(root, ['src']);
  assert.equal(code, 1);
  assert.match(out, /not listed in components:/);
  assert.match(out, /src\/components\/app/);
  assert.match(out, /src\/components\/icons/);
  rmSync(root, { recursive: true, force: true });
});

test('components-ignore silences a deliberate exclusion', () => {
  const root = project({
    'context/STACK.md':
      'components: src/components/ui\ncomponents-ignore: src/components/app, src/components/icons\n',
    'src/components/ui/button.tsx': '// @approved\nexport const Button = () => null;\n',
    'src/components/app/chart.tsx': 'export const Chart = () => null;\n',
    'src/components/icons/star.tsx': 'export const Star = () => null;\n',
  });
  assert.doesNotMatch(run(root, ['src']).out, /not listed in components:/);
  rmSync(root, { recursive: true, force: true });
});

test('registry splits approved, unmarked-in-use, and unmarked-unimported', () => {
  const root = project({
    ...BASE,
    'src/components/app/chart.tsx': 'export const Chart = () => null;\n',
    'src/components/ui/ghost.tsx': 'export const Ghost = () => null;\n',
    'src/routes/page.tsx': [
      'import { Button } from "~/components/ui/button";',
      'import { Chart } from "~/components/app/chart";',
    ].join('\n'),
    'src/routes/other.tsx': 'import { Chart } from "~/components/app/chart";\n',
  });
  const { code, out } = run(root, ['--registry', 'src']);
  assert.equal(code, 0);
  assert.match(out, /Approved \(2\)/);
  assert.match(out, /components\/app\/chart\s+used in 2 file\(s\)/);
  assert.match(out, /Unmarked and unimported: 2 file\(s\)/); // popover + ghost, count only
  assert.doesNotMatch(out, /ghost/); // counted, never listed
  rmSync(root, { recursive: true, force: true });
});

test('a component imported only by another component counts as in use', () => {
  // The shell version returned the importing file's OWN key here, because it matched
  // the path prefix rather than the line content.
  const root = project({
    ...BASE,
    'src/components/ui/button.tsx':
      '// @approved\nimport { Popover } from "~/components/ui/popover";\nexport const Button = () => null;\n',
  });
  const { out } = run(root, ['--registry', 'src']);
  assert.match(out, /components\/ui\/popover\s+used in 1 file\(s\)/);
  assert.doesNotMatch(out, /components\/ui\/button\s+used in/); // button is approved, not "in use"
  rmSync(root, { recursive: true, force: true });
});

test('mechanical violations are case-sensitive: <button> hits, <Button> does not', () => {
  const root = project({
    ...BASE,
    'src/routes/raw.tsx': 'export default () => <button>x</button>;\n',
    'src/routes/ok.tsx': 'export default () => <Button>x</Button>;\n',
  });
  const { out } = run(root, ['src/routes']);
  assert.match(out, /raw interactive HTML element/);
  assert.match(out, /raw\.tsx/);
  assert.doesNotMatch(out, /ok\.tsx/);
  rmSync(root, { recursive: true, force: true });
});

test('hardcoded colors and arbitrary values are flagged', () => {
  const root = project({
    ...BASE,
    'src/routes/style.tsx':
      'export default () => <div className="bg-white text-[#333]" style={{color:"red"}}/>;\n',
  });
  const { code, out } = run(root, ['src/routes']);
  assert.equal(code, 1);
  assert.match(out, /non-token color utility/);
  assert.match(out, /arbitrary-value utility/);
  assert.match(out, /inline style attribute/);
  rmSync(root, { recursive: true, force: true });
});

test('reports plainly when nothing carries a marker', () => {
  const root = project({
    'context/STACK.md': 'components: src/components/ui\n',
    'src/components/ui/button.tsx': 'export const Button = () => null;\n',
    'src/routes/page.tsx': 'import { Button } from "~/components/ui/button";\n',
  });
  const { out } = run(root, ['src/routes']);
  assert.match(out, /no component in src\/components\/ui carries an @approved marker/);
  assert.match(out, /first 5 lines/);
  rmSync(root, { recursive: true, force: true });
});

test('missing component directory is a finding, not a crash', () => {
  const root = project({
    'context/STACK.md': 'components: src/nope\n',
    'src/routes/page.tsx': 'export default () => null;\n',
  });
  const { code, out } = run(root, ['src/routes']);
  assert.equal(code, 1);
  assert.match(out, /component directory not found/);
  rmSync(root, { recursive: true, force: true });
});

test('clean project exits 0', () => {
  const root = project({
    'context/STACK.md': 'components: src/components/ui\n',
    'src/components/ui/button.tsx': '// @approved\nexport const Button = () => null;\n',
    'src/routes/page.tsx': 'import { Button } from "~/components/ui/button";\n',
  });
  const { code, out } = run(root, ['src/routes']);
  assert.equal(code, 0);
  assert.match(out, /Design system check: clean/);
  rmSync(root, { recursive: true, force: true });
});

test('typography utilities on semantic elements are flagged when typography-base is on', () => {
  const root = project({
    'context/STACK.md': 'components: src/components/ui\ntypography-base: true\n',
    'src/components/ui/button.tsx': '// @approved\nexport const Button = () => null;\n',
    'src/routes/page.tsx': [
      '<h1 className="text-2xl font-semibold tracking-tight">Projects</h1>',
      '<p className="text-sm text-ink-muted">Body</p>',
      '<a className="leading-tight">Link</a>',
    ].join('\n'),
  });
  const { code, out } = run(root, ['src/routes']);
  assert.equal(code, 1);
  assert.match(out, /typography utilities on semantic text elements/);
  assert.match(out, /text size/);
  assert.match(out, /font weight/);
  assert.match(out, /letter spacing/);
  assert.match(out, /line height/);
  assert.match(out, /text color/);
  rmSync(root, { recursive: true, force: true });
});

test('layout utilities on semantic elements stay legal', () => {
  const root = project({
    'context/STACK.md': 'components: src/components/ui\ntypography-base: true\n',
    'src/components/ui/button.tsx': '// @approved\nexport const Button = () => null;\n',
    'src/routes/page.tsx': [
      '<h1 className="mt-4 mb-2 max-w-md flex text-center">Projects</h1>',
      '<p className="mb-4">Body</p>',
    ].join('\n'),
  });
  assert.doesNotMatch(run(root, ['src/routes']).out, /typography utilities on semantic/);
  rmSync(root, { recursive: true, force: true });
});

test('text colour on a label wrapping a checkbox is allowed', () => {
  const root = project({
    'context/STACK.md': 'components: src/components/ui\ntypography-base: true\n',
    'src/components/ui/button.tsx': '// @approved\nexport const Button = () => null;\n',
    'src/routes/page.tsx':
      '<label className="text-ink-muted"><input type="checkbox" /> Remember me</label>\n',
  });
  assert.doesNotMatch(run(root, ['src/routes']).out, /typography utilities on semantic/);
  rmSync(root, { recursive: true, force: true });
});

test('missing typography-base with a real base layer is a finding', () => {
  const root = project({
    'context/STACK.md': 'components: src/components/ui\n',
    'src/components/ui/button.tsx': '// @approved\nexport const Button = () => null;\n',
    'src/styles/globals.css':
      '@layer base {\n  h1 { font-size: 2rem; font-weight: 600; }\n  p { line-height: 1.6; }\n}\n',
    'src/routes/page.tsx': '<h1 className="text-2xl font-semibold">Projects</h1>\n',
  });
  const { code, out } = run(root, ['src/routes']);
  assert.equal(code, 1);
  assert.match(out, /typography-base is not set, but a base layer styles semantic elements/);
  assert.match(out, /globals\.css/);
  rmSync(root, { recursive: true, force: true });
});

test('missing typography-base with no base layer is genuinely off, not a finding', () => {
  const root = project({
    'context/STACK.md': 'components: src/components/ui\n',
    'src/components/ui/button.tsx': '// @approved\nexport const Button = () => null;\n',
    // utility-only CSS: no semantic element is styled
    'src/styles/globals.css': '@import "tailwindcss";\n.card { padding: 1rem; }\n',
    'src/routes/page.tsx': 'import { Button } from "~/components/ui/button";\n',
  });
  const { code, out } = run(root, ['src/routes']);
  assert.equal(code, 0);
  assert.match(out, /no base layer found styling semantic elements/);
  assert.match(out, /typography-base: false/);
  rmSync(root, { recursive: true, force: true });
});

test('an explicit typography-base: false is silent', () => {
  const root = project({
    'context/STACK.md': 'components: src/components/ui\ntypography-base: false\n',
    'src/components/ui/button.tsx': '// @approved\nexport const Button = () => null;\n',
    'src/styles/globals.css': '@layer base {\n  h1 { font-size: 2rem; }\n}\n',
    'src/routes/page.tsx': 'import { Button } from "~/components/ui/button";\n',
  });
  const { code, out } = run(root, ['src/routes']);
  assert.equal(code, 0);
  assert.doesNotMatch(out, /typography/i);
  rmSync(root, { recursive: true, force: true });
});

test('a semantic token on an approved component is a violation — no exception', () => {
  const root = project({
    ...BASE,
    'src/routes/page.tsx':
      'import { Button } from "~/components/ui/button";\nexport default () => <Button className="bg-muted">Save</Button>;\n',
  });
  const { code, out } = run(root, ['src/routes']);
  assert.equal(code, 1);
  assert.match(out, /appearance override on a design-system component/);
  assert.match(out, /<Button> bg-muted \(background\)/);
  assert.match(out, /Semantic tokens are not an exception here/);
  rmSync(root, { recursive: true, force: true });
});

test('appearance override catches border, ring, shadow, radius, typography, opacity', () => {
  const root = project({
    ...BASE,
    'src/routes/page.tsx': [
      'import { Button } from "~/components/ui/button";',
      'export default () => <Button className="border-input ring-ring shadow-md rounded-full font-bold opacity-50">Save</Button>;',
    ].join('\n'),
  });
  const { out } = run(root, ['src/routes']);
  assert.match(out, /border-input \(border\)/);
  assert.match(out, /ring-ring \(ring\)/);
  assert.match(out, /shadow-md \(shadow\)/);
  assert.match(out, /rounded-full \(radius\)/);
  assert.match(out, /font-bold \(typography\)/);
  assert.match(out, /opacity-50 \(opacity\)/);
  rmSync(root, { recursive: true, force: true });
});

test('layout classes on an approved component stay legal', () => {
  const root = project({
    ...BASE,
    'src/routes/page.tsx': [
      'import { Button } from "~/components/ui/button";',
      'export default () => <Button className="mt-4 flex items-center text-center w-full">Save</Button>;',
    ].join('\n'),
  });
  assert.doesNotMatch(run(root, ['src/routes']).out, /appearance override/);
  rmSync(root, { recursive: true, force: true });
});

test('appearance check only fires on tags actually imported from a component directory', () => {
  const root = project({
    ...BASE,
    'src/routes/page.tsx': [
      'import { Icon } from "lucide-react";', // capitalised, but not a design-system import
      'export default () => <Icon className="bg-muted" />;',
    ].join('\n'),
  });
  assert.doesNotMatch(run(root, ['src/routes']).out, /appearance override/);
  rmSync(root, { recursive: true, force: true });
});

test('appearance check catches className on a component whose props span multiple lines', () => {
  const root = project({
    ...BASE,
    'src/routes/page.tsx': [
      'import { Button } from "~/components/ui/button";',
      'export default () => (',
      '  <Button',
      '    onClick={() => {}}',
      '    className="bg-muted"',
      '  >Save</Button>',
      ');',
    ].join('\n'),
  });
  assert.match(run(root, ['src/routes']).out, /<Button> bg-muted \(background\)/);
  rmSync(root, { recursive: true, force: true });
});

test('--added-markers finds markers introduced in a range', () => {
  const root = project({
    'context/STACK.md': 'components: src/components/ui\n',
    'src/components/ui/button.tsx': 'export const Button = () => null;\n',
  });
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
    });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'base');

  const none = run(root, ['--added-markers', 'main...HEAD']);
  assert.equal(none.code, 0);
  assert.match(none.out, /No @approved markers added/);

  git('checkout', '-qb', 'feat');
  writeFileSync(join(root, 'src/components/ui/button.tsx'), '// @approved\nexport const Button = () => null;\n');
  git('add', '-A');
  git('commit', '-qm', 'approve button');

  const added = run(root, ['--added-markers', 'main...HEAD']);
  assert.equal(added.code, 1);
  assert.match(added.out, /markers added in main\.\.\.HEAD/);
  assert.match(added.out, /button\.tsx/);
  rmSync(root, { recursive: true, force: true });
});

test('reads design-guard.config, and prefers it over context/STACK.md', () => {
  const root = project({
    'design-guard.config': 'components: src/ui   # inline comment\n',
    'context/STACK.md': 'components: src/elsewhere\n',
    'src/ui/card.tsx': 'export const Card = () => null;\n',
    'src/routes/page.tsx': 'import { Card } from "~/ui/card";\n',
  });
  const { code, out } = run(root, ['src/routes']);
  assert.equal(code, 1);
  assert.match(out, /ui\/card/);
  rmSync(root, { recursive: true, force: true });
});

// ---- --scan ----

const scan = (root, args = []) => JSON.parse(run(root, ['--scan', ...args]).out);

const SHADCN_BUTTON = `// @approved
import { cva, type VariantProps } from "class-variance-authority";

const buttonVariants = cva("inline-flex", {
  variants: {
    variant: { default: "bg-primary", outline: "border", ghost: "hover:bg-accent" },
    size: { sm: "h-8", md: "h-10", lg: "h-12" },
  },
});

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}
export function Button(props: ButtonProps) { return null; }
`;

test('scan: statuses, usage counts and importers', () => {
  const root = project({
    'design-guard.config': 'components: src/components/ui\n',
    'src/components/ui/button.tsx': SHADCN_BUTTON,
    'src/components/ui/legacy.tsx': '// @approved\nexport const Legacy = () => null;\n',
    'src/components/ui/popover.tsx': 'export const Popover = () => null;\n',
    'src/components/ui/orphan.tsx': 'export const Orphan = () => null;\n',
    'src/a.tsx': 'import { Button } from "@/components/ui/button";\nimport { Popover } from "@/components/ui/popover";\n',
    'src/b.tsx': 'import { Button } from "~/components/ui/button";\n',
  });
  const by = Object.fromEntries(scan(root, ['src']).map((c) => [c.key, c]));
  assert.equal(by['components/ui/button'].status, 'approved');
  assert.equal(by['components/ui/button'].usageCount, 2);
  assert.deepEqual(by['components/ui/button'].usedBy, ['src/a.tsx', 'src/b.tsx']);
  assert.equal(by['components/ui/legacy'].status, 'approved-unused');
  assert.equal(by['components/ui/popover'].status, 'unmarked-in-use');
  assert.equal(by['components/ui/orphan'].status, 'unmarked-unused');
  rmSync(root, { recursive: true, force: true });
});

test('scan: reads variants from cva and props from the Props interface', () => {
  const root = project({
    'design-guard.config': 'components: src/components/ui\n',
    'src/components/ui/button.tsx': SHADCN_BUTTON,
  });
  const [button] = scan(root, ['src']);
  assert.equal(button.name, 'Button');
  assert.deepEqual(button.variants.variant, ['default', 'outline', 'ghost']);
  assert.deepEqual(button.variants.size, ['sm', 'md', 'lg']);
  assert.ok(button.props.some((p) => p.name === 'asChild' && p.optional));
  rmSync(root, { recursive: true, force: true });
});

test('scan: reads string-union variants, including through a type alias', () => {
  const root = project({
    'design-guard.config': 'components: src/components/ui\n',
    'src/components/ui/badge.tsx': [
      '// @approved',
      'type Tone = "info" | "warn"',
      '  | "danger";',
      'type BadgeProps = { tone: Tone; size?: "sm" | "lg"; label: string };',
      'export const Badge = (p: BadgeProps) => null;',
    ].join('\n'),
  });
  const [badge] = scan(root, ['src']);
  assert.deepEqual(badge.props.map((p) => p.name), ['tone', 'size', 'label']);
  assert.deepEqual(badge.variants.size, ['sm', 'lg']);
  rmSync(root, { recursive: true, force: true });
});

test('scan: ignores tests and stories', () => {
  const root = project({
    'design-guard.config': 'components: src/components/ui\n',
    'src/components/ui/button.tsx': '// @approved\nexport const Button = () => null;\n',
    'src/components/ui/button.test.tsx': 'test("x", () => {});\n',
    'src/components/ui/button.stories.tsx': 'export default {};\n',
  });
  assert.deepEqual(scan(root, ['src']).map((c) => c.key), ['components/ui/button']);
  rmSync(root, { recursive: true, force: true });
});

test('scan: unstyled-by-design is declared next to the marker, only on approved components', () => {
  const root = project({
    'design-guard.config': 'components: src/components/ui\n',
    'src/components/ui/slot.tsx': '// @approved — unstyled by design, a layout slot\nexport const Slot = () => null;\n',
    'src/components/ui/raw.tsx': '// unstyled by design\nexport const Raw = () => null;\n',
  });
  const by = Object.fromEntries(scan(root, ['src']).map((c) => [c.name, c]));
  assert.equal(by.Slot.unstyledByDesign, true);
  assert.equal(by.Raw.unstyledByDesign, false);
  rmSync(root, { recursive: true, force: true });
});

test('scan: a missing components directory yields an empty list, not a crash', () => {
  const root = project({ 'design-guard.config': 'components: src/components/ui\n', 'src/a.tsx': 'export {};\n' });
  assert.deepEqual(scan(root, ['src']), []);
  rmSync(root, { recursive: true, force: true });
});

test('scan: reads props from an inline annotation when there is no Props type', () => {
  const root = project({
    'design-guard.config': 'components: src/components/ui\n',
    'src/components/ui/button.tsx':
      '// @approved\nexport function Button({ variant = "primary", children }: { variant?: "primary" | "secondary"; children: React.ReactNode }) { return null; }\n',
  });
  const [button] = scan(root, ['src']);
  assert.deepEqual(button.props.map((p) => p.name), ['variant', 'children']);
  assert.deepEqual(button.variants.variant, ['primary', 'secondary']);
  rmSync(root, { recursive: true, force: true });
});

// ---- --approve / --unapprove ----
// These write to project files, so the cases are about what must NOT change as much
// as what must.

import { readFileSync as readFile, symlinkSync } from 'node:fs';

const MK = { 'design-guard.config': 'components: src/components/ui\n' };
const read = (root, f) => readFile(join(root, f), 'utf8');
const BTN = 'src/components/ui/button.tsx';

test('approve: inserts the marker as line 1 and leaves the rest byte-identical', () => {
  const body = 'export const Button = () => null;\n';
  const root = project({ ...MK, [BTN]: body });
  const { code, out } = run(root, ['--approve', BTN]);
  assert.equal(code, 0);
  assert.match(out, /now approved/);
  assert.equal(read(root, BTN), '// @approved\n' + body);
  rmSync(root, { recursive: true, force: true });
});

test('approve: is idempotent', () => {
  const root = project({ ...MK, [BTN]: '// @approved\nexport const Button = () => null;\n' });
  const before = read(root, BTN);
  const { code, out } = run(root, ['--approve', BTN]);
  assert.equal(code, 0);
  assert.match(out, /already approved/);
  assert.equal(read(root, BTN), before);
  rmSync(root, { recursive: true, force: true });
});

test('approve: keeps CRLF line endings', () => {
  const root = project({ ...MK, [BTN]: 'import x from "x";\r\nexport const Button = () => null;\r\n' });
  run(root, ['--approve', BTN]);
  const text = read(root, BTN);
  assert.equal(text, '// @approved\r\nimport x from "x";\r\nexport const Button = () => null;\r\n');
  assert.ok(!/[^\r]\n/.test(text), 'no bare LF introduced');
  rmSync(root, { recursive: true, force: true });
});

test('approve: keeps a BOM first, and goes after a shebang', () => {
  const bom = project({ ...MK, [BTN]: '﻿export const Button = () => null;\n' });
  run(bom, ['--approve', BTN]);
  assert.equal(read(bom, BTN), '﻿// @approved\nexport const Button = () => null;\n');
  const sb = project({ ...MK, [BTN]: '#!/usr/bin/env node\nexport const Button = () => null;\n' });
  run(sb, ['--approve', BTN]);
  assert.equal(read(sb, BTN), '#!/usr/bin/env node\n// @approved\nexport const Button = () => null;\n');
  rmSync(bom, { recursive: true, force: true });
  rmSync(sb, { recursive: true, force: true });
});

test('approve: a "use client" directive is still intact and the marker is within the window', () => {
  const root = project({ ...MK, [BTN]: '"use client";\nexport const Button = () => null;\n' });
  run(root, ['--approve', BTN]);
  const lines = read(root, BTN).split('\n');
  assert.equal(lines[0], '// @approved');
  assert.equal(lines[1], '"use client";');
  rmSync(root, { recursive: true, force: true });
});

test('approve: a marker below line 5 does not count, so approve adds one in the window', () => {
  const late = ['a', 'b', 'c', 'd', 'e', 'f', '// @approved', 'export const Button = () => null;'].join('\n') + '\n';
  const root = project({ ...MK, [BTN]: late });
  assert.equal(scan(root, ['src'])[0].approved, false);
  run(root, ['--approve', BTN]);
  assert.equal(scan(root, ['src'])[0].approved, true);
  rmSync(root, { recursive: true, force: true });
});

test('unapprove: drops a comment-only marker line', () => {
  const root = project({ ...MK, [BTN]: '// @approved\nexport const Button = () => null;\n' });
  const { code, out } = run(root, ['--unapprove', BTN]);
  assert.equal(code, 0);
  assert.match(out, /now unapproved/);
  assert.equal(read(root, BTN), 'export const Button = () => null;\n');
  rmSync(root, { recursive: true, force: true });
});

test('unapprove: handles block, JSX and note-carrying marker styles', () => {
  const cases = [
    ['/* @approved */\nexport const A = 1;\n', 'export const A = 1;\n'],
    ['{/* @approved */}\nexport const A = 1;\n', 'export const A = 1;\n'],
    ['// @approved — unstyled by design\nexport const A = 1;\n', 'export const A = 1;\n'],
    ['/**\n * @approved\n */\nexport const A = 1;\n', '/**\n */\nexport const A = 1;\n'],
  ];
  for (const [input, expected] of cases) {
    const root = project({ ...MK, [BTN]: input });
    run(root, ['--unapprove', BTN]);
    assert.equal(read(root, BTN), expected, JSON.stringify(input));
    assert.equal(scan(root, ['src'])[0].approved, false);
    rmSync(root, { recursive: true, force: true });
  }
});

test('unapprove: a marker sharing a line with other text is cut out, the rest stays', () => {
  const root = project({ ...MK, [BTN]: '// Primary button @approved\nexport const Button = () => null;\n' });
  run(root, ['--unapprove', BTN]);
  assert.equal(read(root, BTN), '// Primary button\nexport const Button = () => null;\n');
  rmSync(root, { recursive: true, force: true });
});

test('unapprove: an unapproved file is left alone, and an @approved below the window is not touched', () => {
  const late = ['a', 'b', 'c', 'd', 'e', 'f', '// @approved', 'export const Button = () => null;'].join('\n') + '\n';
  const root = project({ ...MK, [BTN]: late });
  const { out } = run(root, ['--unapprove', BTN]);
  assert.match(out, /already unapproved/);
  assert.equal(read(root, BTN), late);
  rmSync(root, { recursive: true, force: true });
});

test('unapprove: says how many files import the component', () => {
  const root = project({
    ...MK,
    [BTN]: '// @approved\nexport const Button = () => null;\n',
    'src/a.tsx': 'import { Button } from "@/components/ui/button";\n',
    'src/b.tsx': 'import { Button } from "@/components/ui/button";\n',
  });
  const { out } = run(root, ['--unapprove', BTN]);
  assert.match(out, /2 file\(s\) import it and will now be flagged/);
  rmSync(root, { recursive: true, force: true });
});

test('approve then unapprove restores the file byte for byte', () => {
  const original = '"use client";\r\nimport x from "x";\r\nexport const Button = () => null;\r\n';
  const root = project({ ...MK, [BTN]: original });
  run(root, ['--approve', BTN]);
  run(root, ['--unapprove', BTN]);
  assert.equal(read(root, BTN), original);
  rmSync(root, { recursive: true, force: true });
});

test('refuses files outside the configured components directories', () => {
  const root = project({ ...MK, [BTN]: 'export {};\n', 'src/routes/page.tsx': 'export {};\n', 'secrets.ts': 'export {};\n' });
  for (const f of ['src/routes/page.tsx', 'secrets.ts', 'src/components/ui/../../../secrets.ts']) {
    const { code, out } = run(root, ['--approve', f]);
    assert.equal(code, 2, f);
    assert.match(out, /not inside a configured components directory/);
  }
  assert.equal(read(root, 'src/routes/page.tsx'), 'export {};\n');
  assert.equal(read(root, 'secrets.ts'), 'export {};\n');
  rmSync(root, { recursive: true, force: true });
});

test('refuses a symlink that points out of the components directory', () => {
  const root = project({ ...MK, [BTN]: 'export {};\n', 'secrets.ts': 'export {};\n' });
  symlinkSync(join(root, 'secrets.ts'), join(root, 'src/components/ui/link.tsx'));
  const { code } = run(root, ['--approve', 'src/components/ui/link.tsx']);
  assert.equal(code, 2);
  assert.equal(read(root, 'secrets.ts'), 'export {};\n');
  rmSync(root, { recursive: true, force: true });
});

test('refuses missing files and non-component extensions', () => {
  const root = project({ ...MK, 'src/components/ui/styles.css': 'a{}\n' });
  assert.equal(run(root, ['--approve', 'src/components/ui/nope.tsx']).code, 2);
  assert.equal(run(root, ['--approve', 'src/components/ui/styles.css']).code, 2);
  assert.equal(run(root, ['--approve']).code, 2);
  rmSync(root, { recursive: true, force: true });
});

test('one bad path does not stop the others, and the exit code reports it', () => {
  const root = project({ ...MK, [BTN]: 'export const Button = () => null;\n', 'src/components/ui/card.tsx': 'export const Card = () => null;\n' });
  const { code } = run(root, ['--approve', 'src/components/ui/nope.tsx', BTN, 'src/components/ui/card.tsx']);
  assert.equal(code, 2);
  assert.match(read(root, BTN), /^\/\/ @approved\n/);
  assert.match(read(root, 'src/components/ui/card.tsx'), /^\/\/ @approved\n/);
  rmSync(root, { recursive: true, force: true });
});

test('--added-markers sees a marker added by --approve', () => {
  const root = project({ ...MK, [BTN]: 'export const Button = () => null;\n' });
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'add', '-A');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'base');
  run(root, ['--approve', BTN]);
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'approve');
  const { code, out } = run(root, ['--added-markers', 'HEAD~1...HEAD']);
  assert.equal(code, 1);
  assert.match(out, /button\.tsx/);
  rmSync(root, { recursive: true, force: true });
});

// ---- scan-core (what the /components page runs in the browser) ----

import { scanProject, summarize } from './scan-core.mjs';

const CORE_FILES = {
  'src/components/ui/button.tsx': '// @approved\nexport const Button = () => null;\n',
  'src/components/ui/popover.tsx': 'export const Popover = () => null;\n',
  'src/components/ui/orphan.tsx': 'export const Orphan = () => null;\n',
  'src/pages/a.tsx': 'import { Button } from "@/components/ui/button";\nimport { Popover } from "@/components/ui/popover";\nconst x = <button>raw</button>;\n',
  'src/pages/b.tsx': 'import { Button } from "@/components/ui/button";\nconst y = <input />;\n',
  'src/design-guard/Components.tsx': 'const z = <button>page itself</button>;\n',
};

test('core: scanProject works on an in-memory file map, no filesystem', () => {
  const out = scanProject({ files: CORE_FILES, componentDirs: ['src/components/ui'] });
  const by = Object.fromEntries(out.map((c) => [c.name, c.status]));
  assert.deepEqual(by, { Button: 'approved', Orphan: 'unmarked-unused', Popover: 'unmarked-in-use' });
});

test('core: summarize reports adoption and raw elements, excluding the page itself', () => {
  const components = scanProject({ files: CORE_FILES, componentDirs: ['src/components/ui'] });
  const s = summarize(components, { files: CORE_FILES, componentDirs: ['src/components/ui'], exclude: ['src/design-guard'] });
  assert.equal(s.total, 3);
  assert.equal(s.approved, 1);
  assert.equal(s.decisionsWaiting, 1);
  assert.equal(s.unused, 1);
  assert.equal(s.approvedUsage, 2);
  assert.equal(s.totalUsage, 3);
  assert.equal(s.adoption, 67);
  assert.equal(s.rawElements, 2);
  assert.equal(s.rawElementFiles, 2);
});

test('core: adoption is null, not NaN, when nothing is in use', () => {
  const files = { 'src/components/ui/a.tsx': 'export const A = () => null;\n' };
  const comps = scanProject({ files, componentDirs: ['src/components/ui'] });
  assert.equal(summarize(comps, { files, componentDirs: ['src/components/ui'] }).adoption, null);
});

test('core: bundler-style paths work once the leading slash is stripped by the caller', () => {
  const out = scanProject({ files: { 'src/components/ui/x.tsx': '// @approved\nexport const X = 1;\n' }, componentDirs: ['./src/components/ui/'] });
  assert.equal(out[0].approved, true);
});

// ---- --serve ----
// The server is the one place a web page can cause a file write, so most of these
// are attempts that must be refused — and the file must be unchanged afterwards.

import { spawn } from 'node:child_process';
import { request } from 'node:http';

function startServer(root) {
  return new Promise((resolveStart, reject) => {
    const child = spawn('node', [SCRIPT, '--serve', '--port', '0'], { cwd: root });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      const port = out.match(/127\.0\.0\.1:(\d+)/)?.[1];
      const token = out.match(/Token: (\w+)/)?.[1];
      if (port && token) resolveStart({ child, port: Number(port), token });
    });
    child.on('error', reject);
    setTimeout(() => reject(new Error('server did not start: ' + out)), 5000);
  });
}

function call({ port, method = 'POST', path = '/approve', headers = {}, body, host }) {
  return new Promise((resolveCall, reject) => {
    const data = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const req = request(
      { host: '127.0.0.1', port, method, path, headers: { Host: host ?? `127.0.0.1:${port}`, ...headers } },
      (res) => {
        let text = '';
        res.on('data', (d) => (text += d));
        res.on('end', () => resolveCall({ status: res.statusCode, headers: res.headers, json: text ? JSON.parse(text) : null }));
      },
    );
    req.on('error', reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

const JSON_HDR = { 'Content-Type': 'application/json' };

test('serve: ping works without a token and approve writes the marker with one', async () => {
  const root = project({ ...MK, [BTN]: 'export const Button = () => null;\n' });
  const srv = await startServer(root);
  try {
    assert.equal((await call({ port: srv.port, method: 'GET', path: '/ping' })).status, 200);
    const r = await call({ port: srv.port, headers: { ...JSON_HDR, 'X-Guard-Token': srv.token }, body: { file: BTN } });
    assert.equal(r.status, 200);
    assert.equal(r.json.changed, true);
    assert.equal(read(root, BTN), '// @approved\nexport const Button = () => null;\n');
    const u = await call({ port: srv.port, path: '/unapprove', headers: { ...JSON_HDR, 'X-Guard-Token': srv.token }, body: { file: BTN } });
    assert.equal(u.status, 200);
    assert.equal(read(root, BTN), 'export const Button = () => null;\n');
  } finally {
    srv.child.kill();
    rmSync(root, { recursive: true, force: true });
  }
});

test('serve: refuses a missing or wrong token and leaves the file alone', async () => {
  const root = project({ ...MK, [BTN]: 'export const Button = () => null;\n' });
  const srv = await startServer(root);
  try {
    for (const headers of [{ ...JSON_HDR }, { ...JSON_HDR, 'X-Guard-Token': 'x'.repeat(48) }, { ...JSON_HDR, 'X-Guard-Token': 'short' }]) {
      const r = await call({ port: srv.port, headers, body: { file: BTN } });
      assert.equal(r.status, 401);
    }
    assert.equal(read(root, BTN), 'export const Button = () => null;\n');
  } finally {
    srv.child.kill();
    rmSync(root, { recursive: true, force: true });
  }
});

test('serve: refuses a foreign Host (DNS rebinding) and a foreign Origin, even with the token', async () => {
  const root = project({ ...MK, [BTN]: 'export const Button = () => null;\n' });
  const srv = await startServer(root);
  try {
    const authed = { ...JSON_HDR, 'X-Guard-Token': srv.token };
    assert.equal((await call({ port: srv.port, headers: authed, body: { file: BTN }, host: 'evil.example' })).status, 403);
    assert.equal((await call({ port: srv.port, headers: { ...authed, Origin: 'https://evil.example' }, body: { file: BTN } })).status, 403);
    assert.equal((await call({ port: srv.port, headers: { ...authed, Origin: 'http://localhost.evil.example' }, body: { file: BTN } })).status, 403);
    assert.equal(read(root, BTN), 'export const Button = () => null;\n');
  } finally {
    srv.child.kill();
    rmSync(root, { recursive: true, force: true });
  }
});

test('serve: CORS is granted to localhost pages only, including the preflight', async () => {
  const root = project({ ...MK, [BTN]: 'export {};\n' });
  const srv = await startServer(root);
  try {
    const ok = await call({ port: srv.port, method: 'OPTIONS', headers: { Origin: 'http://localhost:5173' } });
    assert.equal(ok.status, 204);
    assert.equal(ok.headers['access-control-allow-origin'], 'http://localhost:5173');
    assert.match(ok.headers['access-control-allow-headers'], /X-Guard-Token/);
    const bad = await call({ port: srv.port, method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
    assert.equal(bad.status, 403);
    assert.equal(bad.headers['access-control-allow-origin'], undefined);
  } finally {
    srv.child.kill();
    rmSync(root, { recursive: true, force: true });
  }
});

test('serve: refuses paths outside the component dirs, bad bodies, wrong content type, unknown routes', async () => {
  const root = project({ ...MK, [BTN]: 'export {};\n', 'secrets.ts': 'export {};\n' });
  const srv = await startServer(root);
  try {
    const h = { ...JSON_HDR, 'X-Guard-Token': srv.token };
    assert.equal((await call({ port: srv.port, headers: h, body: { file: 'secrets.ts' } })).status, 400);
    assert.equal((await call({ port: srv.port, headers: h, body: { file: '../../etc/passwd' } })).status, 400);
    assert.equal((await call({ port: srv.port, headers: h, body: {} })).status, 400);
    assert.equal((await call({ port: srv.port, headers: h, body: 'not json' })).status, 400);
    assert.equal((await call({ port: srv.port, headers: { 'Content-Type': 'text/plain', 'X-Guard-Token': srv.token }, body: '{"file":"x"}' })).status, 415);
    assert.equal((await call({ port: srv.port, method: 'GET', path: '/approve' })).status, 404);
    assert.equal((await call({ port: srv.port, method: 'GET', path: '/nope' })).status, 404);
    assert.equal(read(root, 'secrets.ts'), 'export {};\n');
  } finally {
    srv.child.kill();
    rmSync(root, { recursive: true, force: true });
  }
});

test('serve: a bad --port is an error, not a crash', () => {
  const root = project({ ...MK });
  const { code, out } = run(root, ['--serve', '--port', 'abc']);
  assert.equal(code, 2);
  assert.match(out, /--port needs a number/);
  rmSync(root, { recursive: true, force: true });
});
