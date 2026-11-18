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

// ---- --added-markers: config edits that narrow the check ----
// The config is a second way to make a component stop being flagged: ignore its
// directory, or drop it from components:. Nothing reported that, so an agent could
// silence the guard without touching a marker.

function gitRepo(files) {
  const root = project(files);
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
    });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'base');
  git('checkout', '-qb', 'feat');
  const commit = (path, body) => {
    writeFileSync(join(root, path), body);
    git('add', '-A');
    git('commit', '-qm', `edit ${path}`);
  };
  return { root, commit };
}

const CONFIG_BASE = 'components: src/components/ui, src/components/app\ntypography-base: true\n';

test('--added-markers reports a directory added to components-ignore', () => {
  const { root, commit } = gitRepo({ 'design-guard.config': CONFIG_BASE });
  commit('design-guard.config', CONFIG_BASE + 'components-ignore: src/components/shared\n');
  const { code, out } = run(root, ['--added-markers', 'main...HEAD']);
  assert.equal(code, 1);
  assert.match(out, /config changes that narrow the check/);
  assert.match(out, /components-ignore: added src\/components\/shared/);
  rmSync(root, { recursive: true, force: true });
});

test('--added-markers reports a directory removed from components', () => {
  const { root, commit } = gitRepo({ 'design-guard.config': CONFIG_BASE });
  commit('design-guard.config', 'components: src/components/ui\ntypography-base: true\n');
  const { code, out } = run(root, ['--added-markers', 'main...HEAD']);
  assert.equal(code, 1);
  assert.match(out, /components: removed src\/components\/app/);
  rmSync(root, { recursive: true, force: true });
});

test('--added-markers reports typography-base switched off, including by deleting the key', () => {
  const { root, commit } = gitRepo({ 'design-guard.config': CONFIG_BASE });
  commit('design-guard.config', 'components: src/components/ui, src/components/app\n');
  const { code, out } = run(root, ['--added-markers', 'main...HEAD']);
  assert.equal(code, 1);
  assert.match(out, /typography-base: true -> off/);
  rmSync(root, { recursive: true, force: true });
});

test('--added-markers sees a narrowing edit in context/STACK.md too', () => {
  const { root, commit } = gitRepo({ 'context/STACK.md': '# Stack\ncomponents: src/components/ui\n' });
  commit('context/STACK.md', '# Stack\ncomponents: src/components/ui\ncomponents-ignore: src/components/legacy\n');
  const { code, out } = run(root, ['--added-markers', 'main...HEAD']);
  assert.equal(code, 1);
  assert.match(out, /components-ignore: added src\/components\/legacy/);
  rmSync(root, { recursive: true, force: true });
});

test('--added-markers stays quiet on config edits that widen the check', () => {
  const { root, commit } = gitRepo({
    'design-guard.config': 'components: src/components/ui\ncomponents-ignore: src/components/legacy\ntypography-base: false\n',
  });
  // add a directory, stop ignoring one, turn typography on, reorder — all stricter or neutral
  commit('design-guard.config', 'typography-base: true\ncomponents: src/components/app, src/components/ui   # now two\n');
  const { code, out } = run(root, ['--added-markers', 'main...HEAD']);
  assert.equal(code, 0, out);
  assert.match(out, /No config changes narrowing the check/);
  rmSync(root, { recursive: true, force: true });
});

test('--added-markers treats deleting the config as narrowing when it listed more than the default', () => {
  const { root } = gitRepo({ 'design-guard.config': CONFIG_BASE });
  rmSync(join(root, 'design-guard.config'));
  // single-rev range: compares against the working tree, like `git diff main`
  const { code, out } = run(root, ['--added-markers', 'main']);
  assert.equal(code, 1);
  assert.match(out, /components: removed src\/components\/app/);
  assert.match(out, /typography-base: true -> off/);
  assert.doesNotMatch(out, /removed src\/components\/ui\b/); // the default still covers it
  rmSync(root, { recursive: true, force: true });
});

test('--added-markers reports markers and config edits together', () => {
  const { root, commit } = gitRepo({
    'design-guard.config': CONFIG_BASE,
    'src/components/ui/card.tsx': 'export const Card = () => null;\n',
  });
  commit('src/components/ui/card.tsx', '// @approved\nexport const Card = () => null;\n');
  commit('design-guard.config', CONFIG_BASE + 'components-ignore: src/components/shared\n');
  const { code, out } = run(root, ['--added-markers', 'main...HEAD']);
  assert.equal(code, 1);
  assert.match(out, /markers added in main\.\.\.HEAD/);
  assert.match(out, /card\.tsx/);
  assert.match(out, /components-ignore: added src\/components\/shared/);
  rmSync(root, { recursive: true, force: true });
});

// ---- --added-markers: the exceptions file ----
// allowed-customization.md used to tell the agent to add its own exceptions. Whatever
// it lists stops being a finding, so a change to it is approval and gets reported.

const EXCEPTIONS = '# Allowed customization\n\n## Never allowed, anywhere\n\n- `!important`\n';

test('--added-markers reports an exception added to allowed-customization.md, wherever it is installed', () => {
  const path = '.claude/skills/design-guard/allowed-customization.md';
  const { root, commit } = gitRepo({ 'design-guard.config': CONFIG_BASE, [path]: EXCEPTIONS });
  commit(path, EXCEPTIONS + '\n## Exceptions\n\n- `ring-*` on Input\n');
  const { code, out } = run(root, ['--added-markers', 'main...HEAD']);
  assert.equal(code, 1);
  assert.match(out, /exceptions file changed/);
  assert.match(out, /\.claude\/skills\/design-guard\/allowed-customization\.md  \(\+2 -0 lines\)/);
  rmSync(root, { recursive: true, force: true });
});

test('--added-markers reports a rule removed from allowed-customization.md, even a Markdown line starting with --', () => {
  const body = EXCEPTIONS + '-- spreading props\n';
  const { root, commit } = gitRepo({ 'allowed-customization.md': body });
  // removing "-- spreading props" shows in the diff as "--- spreading props", which
  // looks like a file header; it must still count as a removed line
  commit('allowed-customization.md', EXCEPTIONS);
  const { code, out } = run(root, ['--added-markers', 'main...HEAD']);
  assert.equal(code, 1);
  assert.match(out, /allowed-customization\.md  \(\+0 -1 lines\)/);
  rmSync(root, { recursive: true, force: true });
});

test('--added-markers reports deleting allowed-customization.md', () => {
  const { root } = gitRepo({ 'allowed-customization.md': EXCEPTIONS });
  rmSync(join(root, 'allowed-customization.md'));
  const { code, out } = run(root, ['--added-markers', 'main']);
  assert.equal(code, 1);
  assert.match(out, /allowed-customization\.md  \(\+0 -3 lines\)/);
  rmSync(root, { recursive: true, force: true });
});

test('--added-markers ignores other Markdown and whitespace-only edits to the exceptions file', () => {
  const { root, commit } = gitRepo({ 'allowed-customization.md': EXCEPTIONS, 'docs/notes.md': 'x\n' });
  commit('docs/notes.md', 'x\n- `ring-*` is fine\n');
  commit('allowed-customization.md', EXCEPTIONS + '\n\n');
  const { code, out } = run(root, ['--added-markers', 'main...HEAD']);
  assert.equal(code, 0, out);
  assert.doesNotMatch(out, /exceptions file changed/);
  rmSync(root, { recursive: true, force: true });
});

test('--added-markers reports "unstyled by design" added to an existing marker line', () => {
  const { root, commit } = gitRepo({
    'design-guard.config': CONFIG_BASE,
    'src/components/ui/card.tsx': '// @approved\nexport const Card = () => null;\n',
  });
  commit('src/components/ui/card.tsx', '// @approved — unstyled by design\nexport const Card = () => null;\n');
  const { code, out } = run(root, ['--added-markers', 'main...HEAD']);
  assert.equal(code, 1);
  assert.match(out, /markers added in main\.\.\.HEAD/);
  assert.match(out, /card\.tsx/);
  rmSync(root, { recursive: true, force: true });
});

// ---- --added-markers: only real markers count ----
// It used to report any added line containing "@approved", anywhere in any file, so
// the linter's own source, its tests and the README all read as approvals. In CI
// that fails every PR that mentions the word.

test('--added-markers ignores @approved mentioned in code, tests and docs', () => {
  const { root, commit } = gitRepo({ 'design-guard.config': CONFIG_BASE, 'README.md': '# x\n', 'src/lib.ts': 'x\n' });
  commit('README.md', '# x\n\nAdd `// @approved` to a component file.\n\n\n\nMore: // @approved\n');
  commit('src/lib.ts', 'const RE = /@approved/;\nconst s = "@approved";\n' + 'x\n'.repeat(40) + '// @approved\n');
  const { code, out } = run(root, ['--added-markers', 'main...HEAD']);
  assert.equal(code, 0, out);
  assert.match(out, /No @approved markers added/);
  rmSync(root, { recursive: true, force: true });
});

test('--added-markers ignores a marker below the 5-line window, and reports one moved into it', () => {
  const below = 'a\nb\nc\nd\ne\n// @approved\nexport const Card = () => null;\n';
  const { root, commit } = gitRepo({ 'design-guard.config': CONFIG_BASE, 'src/components/ui/card.tsx': 'export const Card = () => null;\n' });
  commit('src/components/ui/card.tsx', below);
  const low = run(root, ['--added-markers', 'main...HEAD']);
  assert.equal(low.code, 0, low.out);

  // deleting lines above pulls the existing marker into the window: no marker line
  // is "added" in the diff, but the component is now approved
  commit('src/components/ui/card.tsx', below.replace('a\nb\n', ''));
  const up = run(root, ['--added-markers', 'main...HEAD']);
  assert.equal(up.code, 1);
  assert.match(up.out, /card\.tsx/);
  rmSync(root, { recursive: true, force: true });
});

test('--added-markers does not re-report a marker that was already there', () => {
  const { root, commit } = gitRepo({
    'design-guard.config': CONFIG_BASE,
    'src/components/ui/card.tsx': '// @approved\nexport const Card = () => null;\n',
  });
  commit('src/components/ui/card.tsx', '// @approved\nexport const Card = () => <div />;\n');
  const { code, out } = run(root, ['--added-markers', 'main...HEAD']);
  assert.equal(code, 0, out);
  rmSync(root, { recursive: true, force: true });
});

test('--added-markers works from a project in a subdirectory of the repository', () => {
  const { root, commit } = gitRepo({
    'apps/web/design-guard.config': 'components: src/components/ui\n',
    'apps/web/src/components/ui/card.tsx': 'export const Card = () => null;\n',
  });
  commit('apps/web/src/components/ui/card.tsx', '// @approved\nexport const Card = () => null;\n');
  const { code, out } = run(join(root, 'apps/web'), ['--added-markers', 'main...HEAD']);
  assert.equal(code, 1);
  assert.match(out, /src\/components\/ui\/card\.tsx/);
  rmSync(root, { recursive: true, force: true });
});

// ---- --codeowners ----
// CODEOWNERS lines for every file that decides approval, generated from the config
// so there is no second list to keep in sync.

test('--codeowners lists every component dir, the config, the exceptions file and CODEOWNERS itself', () => {
  const root = project({
    'design-guard.config': 'components: src/components/ui, src/components/app\n',
    '.claude/skills/design-guard/allowed-customization.md': '# x\n',
    'src/components/ui/button.tsx': 'export const Button = () => null;\n',
  });
  execFileSync('git', ['init', '-q'], { cwd: root });
  const { code, out } = run(root, ['--codeowners', '@acme/design-system', '@lead']);
  assert.equal(code, 0, out);
  const o = '@acme/design-system @lead';
  assert.match(out, new RegExp(`^/src/components/ui/ ${o}$`, 'm'));
  assert.match(out, new RegExp(`^/src/components/app/ ${o}$`, 'm'));
  assert.match(out, new RegExp(`^/design-guard\\.config ${o}$`, 'm'));
  assert.match(out, new RegExp(`^/\\.claude/skills/design-guard/allowed-customization\\.md ${o}$`, 'm'));
  assert.match(out, new RegExp(`^/\\.github/CODEOWNERS ${o}$`, 'm'));
  rmSync(root, { recursive: true, force: true });
});

test('--codeowners owns design-guard.config even when the keys live in context/STACK.md', () => {
  const root = project({ 'context/STACK.md': 'components: src/ui\n', 'CODEOWNERS': '* @x\n' });
  execFileSync('git', ['init', '-q'], { cwd: root });
  const { code, out } = run(root, ['--codeowners', '@ds']);
  assert.equal(code, 0, out);
  assert.match(out, /^\/src\/ui\/ @ds$/m);
  assert.match(out, /^\/design-guard\.config @ds$/m); // creating it would override STACK.md
  assert.match(out, /^\/context\/STACK\.md @ds$/m);
  assert.match(out, /^\/CODEOWNERS @ds$/m); // the existing file, not .github/
  assert.match(out, /no allowed-customization\.md found/);
  rmSync(root, { recursive: true, force: true });
});

test('--codeowners writes repository-root paths for a project in a subdirectory', () => {
  const root = project({
    'apps/web/design-guard.config': 'components: src/components/ui\n',
    '.claude/skills/design-guard/allowed-customization.md': '# x\n',
  });
  execFileSync('git', ['init', '-q'], { cwd: root });
  const { code, out } = run(join(root, 'apps/web'), ['--codeowners', '@ds']);
  assert.equal(code, 0, out);
  assert.match(out, /^\/apps\/web\/src\/components\/ui\/ @ds$/m);
  assert.match(out, /^\/apps\/web\/design-guard\.config @ds$/m);
  assert.match(out, /^\/\.claude\/skills\/design-guard\/allowed-customization\.md @ds$/m); // outside the project, still found
  rmSync(root, { recursive: true, force: true });
});

test('--codeowners refuses a missing or malformed owner', () => {
  const root = project({ 'design-guard.config': 'components: src/ui\n' });
  const none = run(root, ['--codeowners']);
  assert.equal(none.code, 2);
  assert.match(none.out, /needs at least one owner/);
  const bad = run(root, ['--codeowners', 'acme']);
  assert.equal(bad.code, 2);
  assert.match(bad.out, /not a GitHub owner: acme/);
  rmSync(root, { recursive: true, force: true });
});

test('--added-markers reports a change to CODEOWNERS', () => {
  const { root, commit } = gitRepo({ '.github/CODEOWNERS': '/src/components/ui/ @ds\n' });
  commit('.github/CODEOWNERS', '# owners\n');
  const { code, out } = run(root, ['--added-markers', 'main...HEAD']);
  assert.equal(code, 1);
  assert.match(out, /CODEOWNERS changed/);
  assert.match(out, /\.github\/CODEOWNERS  \(\+1 -1 lines\)/);
  rmSync(root, { recursive: true, force: true });
});

// ---- props spread onto a design-system component ----
// allowed-customization.md forbade it, the linter never checked: <Button {...props}>
// forwards className and style, so a wrapper lets any caller restyle Button unseen.

const SPREAD_BASE = {
  'design-guard.config': 'components: src/components/ui\n',
  'src/components/ui/button.tsx': '// @approved\nexport const Button = (p: any) => null;\n',
  'src/components/ui/input.tsx': '// @approved\nexport const Input = (p: any) => null;\n',
};

test('flags a spread on a design-system component in app code and in a wrapper', () => {
  const root = project({
    ...SPREAD_BASE,
    'src/routes/page.tsx': 'import { Button } from "@/components/ui/button";\nexport const P = (props: any) => (\n  <Button\n    variant="primary"\n    {...props}\n  >Go</Button>\n);\n',
    // the bypass: a wrapper outside the component directories that forwards everything
    'src/components/shared/my-button.tsx': 'import { Button as B } from "@/components/ui/button";\nexport const MyButton = ({ children, ...rest }: any) => <B {...rest}>{children}</B>;\n',
  });
  const { code, out } = run(root, ['src']);
  assert.equal(code, 1);
  assert.match(out, /props spread onto a design-system component/);
  assert.match(out, /src\/routes\/page\.tsx:5: <Button> \{\.\.\.props\}/); // the spread's own line
  assert.match(out, /src\/components\/shared\/my-button\.tsx:2: <B> \{\.\.\.rest\}/);
  rmSync(root, { recursive: true, force: true });
});

test('a spread inside an expression prop is not a spread on the tag', () => {
  const root = project({
    ...SPREAD_BASE,
    'src/routes/page.tsx': [
      'import { Button } from "@/components/ui/button";',
      'export const P = ({ args }: any) => <Button onClick={() => go(...args)} data={{ ...base, x: 1 }}>Go</Button>;',
      // a spread on a plain element or a third-party component isn't the design system's concern
      'export const Q = (p: any) => <><div {...p} /><Thing {...p} /></>;',
    ].join('\n'),
  });
  const { out } = run(root, ['src/routes']);
  assert.doesNotMatch(out, /props spread onto a design-system component/);
  rmSync(root, { recursive: true, force: true });
});

test('form wiring is exempt: {...field} and spreads of a call', () => {
  const root = project({
    ...SPREAD_BASE,
    'src/routes/form.tsx': [
      'import { Input } from "@/components/ui/input";',
      'export const F = ({ field, form, register, getInputProps }: any) => (<>',
      '  <Input {...field} />',
      '  <Input {...register("email", { required: true })} />',
      '  <Input {...form.register("name")} />',
      '  <Input {...getInputProps()} />',
      '  <Input {...fieldProps} />',
      '</>);',
    ].join('\n'),
  });
  const { code, out } = run(root, ['src/routes']);
  assert.equal(code, 1);
  assert.match(out, /form\.tsx:7: <Input> \{\.\.\.fieldProps\}/); // a near-miss name is not exempt
  const hits = out.split('\n').filter((l) => l.startsWith('src/routes/form.tsx'));
  assert.deepEqual(hits, ['src/routes/form.tsx:7: <Input> {...fieldProps}']);
  rmSync(root, { recursive: true, force: true });
});

test('a spread inside a component directory is composition, not a finding', () => {
  const root = project({
    ...SPREAD_BASE,
    'src/components/ui/icon-button.tsx': '// @approved\nimport { Button } from "./button";\nexport const IconButton = (props: any) => <Button size="icon" {...props} />;\n',
  });
  const { out } = run(root, ['src']);
  assert.doesNotMatch(out, /props spread onto a design-system component/);
  rmSync(root, { recursive: true, force: true });
});

// ---- variant / size values a component doesn't declare ----
// <Button variant="ghostly"> passed every check: approved component, no override.
// The value just isn't one Button has, so it silently renders the default.

const CVA_BUTTON = [
  '// @approved',
  'import { cva, type VariantProps } from "class-variance-authority";',
  'const buttonVariants = cva("inline-flex", {',
  '  variants: {',
  '    variant: { default: "bg-primary", outline: "border", ghost: "hover:bg-accent" },',
  '    size: { default: "h-9", sm: "h-8", lg: "h-10", icon: "size-9" },',
  '  },',
  '  defaultVariants: { variant: "default", size: "default" },',
  '});',
  'export interface ButtonProps extends VariantProps<typeof buttonVariants> { asChild?: boolean }',
  'export function Button({ variant, size, ...props }: ButtonProps) { return null; }',
].join('\n');

const VARIANT_BASE = {
  'design-guard.config': 'components: src/components/ui\ntypography-base: false\n',
  'src/components/ui/button.tsx': CVA_BUTTON,
  'src/components/ui/badge.tsx': '// @approved\ntype Tone = "info" | "warn";\nexport function Badge({ variant }: { variant?: Tone }) { return null; }\n',
};

const variantLines = (out, file) => out.split('\n').filter((l) => l.startsWith(file));

test('flags variant and size values a component does not declare (cva and string union)', () => {
  const root = project({
    ...VARIANT_BASE,
    'src/routes/page.tsx': [
      'import { Button } from "@/components/ui/button";',
      'import { Badge as Tag } from "@/components/ui/badge";',
      'export const P = () => (<>',
      '  <Button variant="ghostly">a</Button>',
      '  <Button variant="ghost" size="xl">b</Button>',
      '  <Button variant={"outline"} size=\'icon\'>c</Button>',
      '  <Button variant={\'destructive\'}>d</Button>',
      '  <Tag variant="error" />',
      '  <Tag variant="warn" />',
      '</>);',
    ].join('\n'),
  });
  const { code, out } = run(root, ['src/routes']);
  assert.equal(code, 1);
  assert.match(out, /variant or size the component doesn't declare/);
  assert.deepEqual(variantLines(out, 'src/routes/page.tsx'), [
    'src/routes/page.tsx:4: <Button> variant="ghostly" — declared: default, outline, ghost',
    'src/routes/page.tsx:5: <Button> size="xl" — declared: default, sm, lg, icon',
    'src/routes/page.tsx:7: <Button> variant="destructive" — declared: default, outline, ghost',
    'src/routes/page.tsx:8: <Tag> variant="error" — declared: info, warn',
  ]);
  rmSync(root, { recursive: true, force: true });
});

test('variant check stays silent when it cannot be sure', () => {
  const root = project({
    ...VARIANT_BASE,
    // values not readable from the file
    'src/components/ui/chip.tsx': '// @approved\nimport type { ButtonProps } from "./button";\nexport function Chip({ variant }: { variant?: ButtonProps["variant"] }) { return null; }\n',
    // two cva blocks: no telling which export owns which
    'src/components/ui/toggle.tsx': '// @approved\nconst a = cva("", { variants: { variant: { on: "" } } });\nconst b = cva("", { variants: { variant: { off: "" } } });\nexport function Toggle() { return null; }\nexport function ToggleItem() { return null; }\n',
    'src/routes/page.tsx': [
      'import { Button } from "@/components/ui/button";',
      'import { Badge } from "@/components/ui/badge";',
      'import { Chip } from "@/components/ui/chip";',
      'import { Toggle, ToggleItem } from "@/components/ui/toggle";',
      'export const P = ({ v }: any) => (<>',
      '  <Button variant={v} size={`${v}`}>dynamic</Button>',
      '  <Button data-variant="nope" render={() => <Other variant="nope" />}>not this tag\'s</Button>',
      '  <Badge size="huge" />',
      '  <Chip variant="anything" />',
      '  <Toggle variant="off" /><ToggleItem variant="on" />',
      '  <Thing variant="whatever" />',
      '</>);',
    ].join('\n'),
  });
  const { out } = run(root, ['src/routes']);
  assert.doesNotMatch(out, /variant or size the component doesn't declare/);
  rmSync(root, { recursive: true, force: true });
});

test('variant check passes the demo project without new findings', () => {
  const demo = join(dirname(SCRIPT), '..', 'examples', 'demo');
  const { out } = run(demo, ['src']);
  assert.doesNotMatch(out, /variant or size the component doesn't declare/);
});

test('scan: an indexed or non-union variant type declares no values', () => {
  const root = project({
    'design-guard.config': 'components: src/components/ui\n',
    'src/components/ui/chip.tsx': '// @approved\nexport function Chip({ variant }: { variant?: ButtonProps["variant"] }) { return null; }\n',
    'src/components/ui/pill.tsx': '// @approved\nexport function Pill({ size }: { size?: "sm" | "lg" | undefined }) { return null; }\n',
  });
  const by = Object.fromEntries(scan(root, ['src']).map((c) => [c.name, c]));
  assert.deepEqual(by.Chip.variants, {});
  assert.deepEqual(by.Pill.variants.size, ['sm', 'lg']);
  rmSync(root, { recursive: true, force: true });
});

// ---- className built in code ----
// The override and typography checks only read className="…". In a shadcn codebase
// most classes go through cn(), template literals or constants, and passed unseen.

const BUILT = {
  'design-guard.config': 'components: src/components/ui\ntypography-base: true\n',
  'src/components/ui/card.tsx': '// @approved\nexport const Card = (p: any) => null;\n',
};

const linesFor = (out, file) => out.split('\n').filter((l) => l.startsWith(file));

test('appearance overrides are found in cn(), template literals, ternaries and same-file constants', () => {
  const root = project({
    ...BUILT,
    'src/routes/page.tsx': [
      'import { Card } from "@/components/ui/card";',
      'import { cn } from "@/lib/utils";',
      'const surface = "rounded-xl";',
      'export const P = ({ active, x, className }: any) => (<>',
      '  <Card className={cn("mt-4 flex", active && "bg-primary", className)} />',
      '  <Card className={`shadow-lg ${x}`} />',
      '  <Card className={active ? "p-4" : "border-dashed"} />',
      '  <Card className={surface} />',
      '  <Card className={clsx({ "opacity-50": !active, "w-full": true })} />',
      '  <Card',
      '    className={cn(',
      '      "gap-2",',
      '      x && `ring-2 ${active ? "ring-offset-2" : ""}`,',
      '    )}',
      '  />',
      '</>);',
    ].join('\n'),
  });
  const { code, out } = run(root, ['src/routes']);
  assert.equal(code, 1);
  assert.deepEqual(linesFor(out, 'src/routes/page.tsx'), [
    'src/routes/page.tsx:5: <Card> bg-primary (background)',
    'src/routes/page.tsx:6: <Card> shadow-lg (shadow)',
    'src/routes/page.tsx:7: <Card> border-dashed (border)',
    'src/routes/page.tsx:8: <Card> rounded-xl (radius)',
    'src/routes/page.tsx:9: <Card> opacity-50 (opacity)',
    'src/routes/page.tsx:10: <Card> ring-offset-2 (ring)',
    'src/routes/page.tsx:10: <Card> ring-2 (ring)',
  ]);
  rmSync(root, { recursive: true, force: true });
});

test('built classNames: layout stays legal and unresolvable values stay silent', () => {
  const root = project({
    ...BUILT,
    'src/routes/page.tsx': [
      'import { Card } from "@/components/ui/card";',
      'import { styles } from "./styles";',
      'const pad = "p-6";',
      'export const P = ({ className, x }: any) => (<>',
      '  <Card className={cn("mt-4 grid gap-2", pad, className)} />',
      '  <Card className={styles.card} />',
      '  <Card className={getClasses(x)} />',
      '  <Card render={() => <div className="bg-muted" />} />',
      '</>);',
    ].join('\n'),
  });
  const { out } = run(root, ['src/routes']);
  assert.deepEqual(linesFor(out, 'src/routes/page.tsx'), []);
  rmSync(root, { recursive: true, force: true });
});

test('typography utilities are found in built classNames on semantic elements', () => {
  const root = project({
    ...BUILT,
    'src/routes/page.tsx': [
      'const title = "text-2xl";',
      'export const P = ({ big }: any) => (<>',
      '  <h1 className={cn("mb-4", big && "font-semibold")}>A</h1>',
      '  <h2 className={title}>B</h2>',
      '  <p className={`max-w-md ${big ? "leading-tight" : ""}`}>C</p>',
      '  <a className={cn("underline-offset-4")} href="#">D</a>',
      '</>);',
    ].join('\n'),
  });
  const { code, out } = run(root, ['src/routes']);
  assert.equal(code, 1);
  assert.deepEqual(linesFor(out, 'src/routes/page.tsx'), [
    'src/routes/page.tsx:3: <h1> font-semibold (font weight) — the base layer already sets this',
    'src/routes/page.tsx:4: <h2> text-2xl (text size) — the base layer already sets this',
    'src/routes/page.tsx:5: <p> leading-tight (line height) — the base layer already sets this',
  ]);
  rmSync(root, { recursive: true, force: true });
});

test('appearance overrides through a renamed import and in a wrapper outside the component directories', () => {
  const root = project({
    ...BUILT,
    'src/routes/page.tsx': 'import { Card as Box } from "~/components/ui/card";\nexport const P = () => <Box className="bg-muted" />;\n',
    'src/components/shared/panel.tsx': 'import { Card } from "../ui/card";\nexport const Panel = () => <Card className={cn("shadow-sm")} />;\n',
  });
  const { code, out } = run(root, ['src']);
  assert.equal(code, 1);
  assert.match(out, /src\/routes\/page\.tsx:2: <Box> bg-muted \(background\)/);
  assert.match(out, /src\/components\/shared\/panel\.tsx:2: <Card> shadow-sm \(shadow\)/);
  assert.match(out, /component directories not listed in components:[\s\S]*src\/components\/shared/);
  rmSync(root, { recursive: true, force: true });
});

test('a relative import from a sibling directory resolves to the component it points at', () => {
  const root = project({
    'design-guard.config': 'components: src/components/ui\ncomponents-ignore: src/components/shared\n',
    'src/components/ui/popover.tsx': 'export const Popover = () => null;\n',
    // "../ui/popover" never contains "components/ui"; only resolving the path finds it
    'src/routes/page.tsx': 'import { Wrap } from "../components/shared/wrap";\n',
    'src/components/shared/wrap.tsx': 'import { Popover } from "../ui/popover";\nexport const Wrap = () => <Popover />;\n',
  });
  const lint = run(root, ['src']);
  assert.equal(lint.code, 1);
  assert.match(lint.out, /src\/components\/shared\/wrap\.tsx  ->  components\/ui\/popover/);
  const reg = run(root, ['--registry', 'src']);
  assert.match(reg.out, /Unmarked but in use \(1\)\n  components\/ui\/popover\s+used in 1 file/);
  rmSync(root, { recursive: true, force: true });
});

// ---- hand-rolled interactive elements ----
// <button> was caught; <div role="button" onClick> styled like Button was not.

const HAND = { 'design-guard.config': 'components: src/components/ui\ntypography-base: false\n',
  'src/components/ui/button.tsx': '// @approved\nexport const Button = (p: any) => null;\n' };

test('flags interactive roles and click handlers on plain elements', () => {
  const root = project({
    ...HAND,
    'src/routes/page.tsx': [
      'export const P = ({ go }: any) => (<>',
      '  <div role="button" onClick={go} className="rounded-md bg-primary px-4 py-2">Save</div>',
      '  <span onClick={() => go()}>x</span>',
      '  <li role="tab">Tab</li>',
      '  <a role={"menuitem"} href="#">Item</a>',
      '  <div',
      '    role="switch"',
      '    aria-checked={true}',
      '  />',
      '</>);',
    ].join('\n'),
  });
  const { code, out } = run(root, ['src/routes']);
  assert.equal(code, 1);
  assert.deepEqual(linesFor(out, 'src/routes/page.tsx'), [
    'src/routes/page.tsx:2: <div role="button" onClick>',
    'src/routes/page.tsx:3: <span onClick>',
    'src/routes/page.tsx:4: <li role="tab">',
    'src/routes/page.tsx:5: <a role="menuitem">',
    'src/routes/page.tsx:6: <div role="switch">',
  ]);
  rmSync(root, { recursive: true, force: true });
});

test('hand-rolled check leaves non-interactive roles, links, components and nested props alone', () => {
  const root = project({
    ...HAND,
    'src/routes/page.tsx': [
      'import { Button } from "@/components/ui/button";',
      'export const P = ({ go }: any) => (<>',
      '  <div role="presentation" /><section role="region" /><div role="list" />',
      '  <Button onClick={go}>ok</Button>',
      '  <a href="/x" onClick={go}>link with a handler</a>',
      '  <div className="rounded-lg bg-muted p-4">a card-like box is not a control</div>',
      // the outer div doesn't inherit onClick from a component nested in one of its props
      '  <div data-slot={() => <Button onClick={go} />} />',
      '  <divider onClick={go} />',
      '</>);',
    ].join('\n'),
  });
  const { out } = run(root, ['src/routes']);
  assert.doesNotMatch(out, /hand-rolled interactive element/);
  assert.doesNotMatch(out, /link styled as a button/);
  rmSync(root, { recursive: true, force: true });
});

test('a link styled as a button warns without failing the check', () => {
  const root = project({
    ...HAND,
    'src/routes/page.tsx': [
      'export const P = ({ big }: any) => (<>',
      '  <a href="/start" className={cn("inline-flex rounded-md bg-primary px-4 py-2", big && "h-10")}>Start</a>',
      '  <a href="/x" className="bg-muted">only a background</a>',
      '  <a href="/y" className="rounded-md bg-transparent px-2 py-1">transparent</a>',
      '</>);',
    ].join('\n'),
  });
  const { code, out } = run(root, ['src/routes']);
  assert.equal(code, 0, out);
  assert.match(out, /warning \(does not fail the check\): link styled as a button/);
  assert.deepEqual(linesFor(out, 'src/routes/page.tsx'), ['src/routes/page.tsx:2: <a> rounded-md bg-primary px-4 py-2']);
  assert.match(out, /Design system check: clean/);
  rmSync(root, { recursive: true, force: true });
});

// ---- @deprecated ----
// Approval was binary, so a team couldn't say "we're phasing this out, use X".

const DEP = {
  'design-guard.config': 'components: src/components/ui\ntypography-base: false\n',
  'src/components/ui/new-card.tsx': '// @approved\nexport const NewCard = () => null;\n',
  'src/components/ui/card.tsx': '// @approved\n// @deprecated → NewCard\nexport const Card = () => null;\n',
  'src/components/ui/panel.tsx': '/** @deprecated use NewCard */\nexport const Panel = () => null;\n',
  'src/components/ui/box.tsx': '// @approved\n// @deprecated\nexport const Box = () => null;\n',
  // not a deprecation: below the window, or a different word
  'src/components/ui/tile.tsx': '// @approved\n// a\n// b\n// c\n// d\n// @deprecated → NewCard\nexport const Tile = () => null;\n',
  'src/components/ui/chip.tsx': '// @approved\n// @deprecated-soon\nexport const Chip = () => null;\n',
};

test('every use of a deprecated component is flagged, naming the replacement', () => {
  const root = project({
    ...DEP,
    'src/routes/page.tsx': [
      'import { Card } from "@/components/ui/card";',
      'import { Panel } from "@/components/ui/panel";',
      'import { Box } from "@/components/ui/box";',
      'import { NewCard } from "@/components/ui/new-card";',
      'import { Tile } from "@/components/ui/tile";',
      'import { Chip } from "@/components/ui/chip";',
    ].join('\n'),
  });
  const { code, out } = run(root, ['src/routes']);
  assert.equal(code, 1);
  const section = out.split('== deprecated component in use\n')[1].split('\n\n')[0].split('\n');
  assert.deepEqual(section, [
    'src/routes/page.tsx  ->  components/ui/box',
    'src/routes/page.tsx  ->  components/ui/card  (use NewCard instead)',
    'src/routes/page.tsx  ->  components/ui/panel  (use NewCard instead)',
  ]);
  // Panel is unapproved too, but deprecation is the one finding; Tile and Chip aren't deprecated
  assert.doesNotMatch(out, /component used but not marked @approved/);
  rmSync(root, { recursive: true, force: true });
});

test('a deprecated component may still be used inside the component directories', () => {
  const root = project({
    ...DEP,
    'src/components/ui/legacy-list.tsx': '// @approved\nimport { Card } from "./card";\nexport const LegacyList = () => <Card />;\n',
  });
  const { out } = run(root, ['src']);
  assert.doesNotMatch(out, /deprecated component in use/);
  rmSync(root, { recursive: true, force: true });
});

test('registry lists deprecated components apart, most-used first, with the replacement', () => {
  const root = project({
    ...DEP,
    'src/routes/a.tsx': 'import { Card } from "@/components/ui/card";\nimport { Box } from "@/components/ui/box";\n',
    'src/routes/b.tsx': 'import { Card } from "@/components/ui/card";\n',
  });
  const { out } = run(root, ['--registry', 'src']);
  const approved = out.split('Approved (')[1].split('\n\n')[0];
  assert.doesNotMatch(approved, /components\/ui\/card\b|components\/ui\/box\b/);
  assert.match(out, /Deprecated \(3\)\n  components\/ui\/card\s+used in 2 file\(s\)  -> NewCard\n  components\/ui\/box\s+used in 1 file\(s\)\n  components\/ui\/panel\s+used in 0 file\(s\)  -> NewCard/);
  const by = Object.fromEntries(scan(root, ['src']).map((c) => [c.name, c]));
  assert.equal(by.Card.status, 'deprecated');
  assert.equal(by.Card.replacement, 'NewCard');
  assert.equal(by.Box.replacement, null);
  assert.equal(by.Tile.deprecated, false);
  assert.equal(by.Chip.deprecated, false);
  rmSync(root, { recursive: true, force: true });
});

test('--added-markers reports deprecations added, lifted and changed', () => {
  const { root, commit } = gitRepo({
    'design-guard.config': 'components: src/components/ui\n',
    'src/components/ui/a.tsx': '// @approved\nexport const A = () => null;\n',
    'src/components/ui/b.tsx': '// @approved\n// @deprecated → A\nexport const B = () => null;\n',
    'src/components/ui/c.tsx': '// @approved\n// @deprecated → A\nexport const C = () => null;\n',
  });
  commit('src/components/ui/a.tsx', '// @approved\n// @deprecated → B\nexport const A = () => null;\n');
  commit('src/components/ui/b.tsx', '// @approved\nexport const B = () => null;\n');
  commit('src/components/ui/c.tsx', '// @approved\n// @deprecated → B\nexport const C = () => null;\n');
  const { code, out } = run(root, ['--added-markers', 'main...HEAD']);
  assert.equal(code, 1);
  assert.match(out, /No @approved markers added/);
  assert.match(out, /== @deprecated markers changed in main\.\.\.HEAD\n  src\/components\/ui\/a\.tsx  \(added\)\n  src\/components\/ui\/b\.tsx  \(removed\)\n  src\/components\/ui\/c\.tsx  \(changed\)/);
  rmSync(root, { recursive: true, force: true });
});
