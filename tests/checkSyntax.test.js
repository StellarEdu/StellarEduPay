'use strict';

/**
 * Unit tests for scripts/check-syntax.js — the CI syntax gate.
 *
 * The script must never confuse its own failure with a detected syntax error:
 *   exit 0 → clean          exit 1 → syntax error found      exit 2 → gate broke
 * These tests exercise runChecks() against fixture trees so no repo source is
 * mutated, plus one integration run of the real CLI against the live tree.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const { collectFiles, checkWithNode, checkWithBabel, runChecks, GateError } =
  require('../scripts/check-syntax');

const ROOT = path.resolve(__dirname, '..');

// ── Fixture helpers ───────────────────────────────────────────────────────────

let tmpRoot;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'check-syntax-'));
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function write(rel, contents) {
  const abs = path.join(tmpRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, contents);
}

const GOOD_JS = "'use strict';\nconst a = 1;\nconsole.log(a);\n";
const DUP_CONST_JS = "'use strict';\nconst a = 1;\nconst a = 2;\n";
const BROKEN_JS = "function oops( {\n  return 1;\n}\n";
const GOOD_JSX = "export default function Ok() {\n  return <div className=\"x\">hi</div>;\n}\n";
const BROKEN_JSX = "export default function Broken() {\n  const x = (\n    <div>\n      <span>unclosed\n  );\n}\n";

function target(dir, parser, exts) {
  return { label: path.basename(dir), dir, exts: exts || ['.js'], parser };
}

// ── File collection ───────────────────────────────────────────────────────────

describe('collectFiles', () => {
  it('walks subdirectories and filters by extension', () => {
    write('src/a.js', GOOD_JS);
    write('src/nested/deep/b.js', GOOD_JS);
    write('src/skip.txt', 'not js');
    write('src/other.jsx', GOOD_JS);

    const files = collectFiles(target(path.join(tmpRoot, 'src'), 'node'));

    expect(files).toHaveLength(2);
    expect(files.every((f) => f.endsWith('.js'))).toBe(true);
  });

  it('raises a GateError when the target directory does not exist', () => {
    expect(() =>
      collectFiles(target(path.join(tmpRoot, 'missing'), 'node'))
    ).toThrow(GateError);
  });
});

// ── Parsers ───────────────────────────────────────────────────────────────────

describe('checkWithNode', () => {
  it('returns null for a valid CommonJS file', () => {
    write('ok.js', GOOD_JS);
    expect(checkWithNode(path.join(tmpRoot, 'ok.js'))).toBeNull();
  });

  it('names file and line for a duplicate declaration', () => {
    write('dup.js', DUP_CONST_JS);
    const abs = path.join(tmpRoot, 'dup.js');
    const problem = checkWithNode(abs);
    expect(problem).not.toBeNull();
    // Paths are reported relative to the repository root.
    expect(problem.file).toBe(path.relative(ROOT, abs));
    expect(problem.line).toBe(3);
    expect(problem.detail).toMatch(/already been declared/i);
  });

  it('names file and line for malformed syntax', () => {
    write('broken.js', BROKEN_JS);
    const problem = checkWithNode(path.join(tmpRoot, 'broken.js'));
    expect(problem).not.toBeNull();
    expect(problem.line).toBeGreaterThan(0);
  });
});

describe('checkWithBabel', () => {
  it('returns null for valid JSX', () => {
    write('ok.jsx', GOOD_JSX);
    expect(checkWithBabel(path.join(tmpRoot, 'ok.jsx'))).toBeNull();
  });

  it('names file and line for broken JSX', () => {
    write('broken.jsx', BROKEN_JSX);
    const problem = checkWithBabel(path.join(tmpRoot, 'broken.jsx'));
    expect(problem).not.toBeNull();
    expect(problem.line).toBe(4);
  });

  it('catches duplicate declarations too (parser-level redeclaration check)', () => {
    write('dup.js', DUP_CONST_JS);
    const problem = checkWithBabel(path.join(tmpRoot, 'dup.js'));
    expect(problem).not.toBeNull();
    expect(problem.line).toBe(3);
  });
});

// ── Orchestration + exit-code contract ────────────────────────────────────────

describe('runChecks', () => {
  it('exits 0 with a clean tree and reports per-target counts', () => {
    write('backend/src/one.js', GOOD_JS);
    write('frontend/src/two.jsx', GOOD_JSX);

    const result = runChecks(
      [
        target(path.join(tmpRoot, 'backend/src'), 'node'),
        target(path.join(tmpRoot, 'frontend/src'), 'babel', ['.js', '.jsx']),
      ],
      { log: () => {}, error: () => {} }
    );

    expect(result.code).toBe(0);
    expect(result.checked).toBe(2);
    expect(result.problems).toEqual([]);
  });

  it('exits 1 and names the offending file + line on a syntax error', () => {
    write('backend/src/good.js', GOOD_JS);
    write('backend/src/routes/dup.js', DUP_CONST_JS);

    const errors = [];
    const result = runChecks([target(path.join(tmpRoot, 'backend/src'), 'node')], {
      log: () => {},
      error: (msg) => errors.push(msg),
    });

    expect(result.code).toBe(1);
    expect(result.problems).toHaveLength(1);
    // Output must name the offending file and line.
    expect(errors[0]).toContain('routes/dup.js');
    expect(errors[0]).toContain(':3');
    expect(errors.join('\n')).toMatch(/already been declared/i);
  });

  it('reports every broken file, across parsers', () => {
    write('backend/src/bad.js', BROKEN_JS);
    write('frontend/src/bad.jsx', BROKEN_JSX);

    const result = runChecks(
      [
        target(path.join(tmpRoot, 'backend/src'), 'node'),
        target(path.join(tmpRoot, 'frontend/src'), 'babel', ['.js', '.jsx']),
      ],
      { log: () => {}, error: () => {} }
    );

    expect(result.code).toBe(1);
    expect(result.problems).toHaveLength(2);
    expect(result.problems.map((p) => p.file)).toEqual(
      expect.arrayContaining([
        expect.stringContaining('bad.js'),
        expect.stringContaining('bad.jsx'),
      ])
    );
  });

  it('raises GateError (exit-2 class) when the walk finds zero files', () => {
    write('empty/.gitkeep', '');

    expect(() =>
      runChecks([target(path.join(tmpRoot, 'empty'), 'node')], { log: () => {}, error: () => {} })
    ).toThrow(GateError);
  });

  it('raises GateError when a target directory is missing entirely', () => {
    expect(() =>
      runChecks([target(path.join(tmpRoot, 'ghost'), 'node')], { log: () => {}, error: () => {} })
    ).toThrow(GateError);
  });
});

// ── Live CLI integration ──────────────────────────────────────────────────────
// Acceptance criterion: `npm run check:syntax` runs to completion from a clean
// checkout and passes against the current tree.

describe('check-syntax CLI against the real repository', () => {
  jest.setTimeout(120_000);

  it('runs to completion and exits 0 on the current tree', () => {
    const res = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-syntax.js')], {
      encoding: 'utf8',
      timeout: 110_000,
    });

    expect(res.error).toBeUndefined();
    expect(res.stderr).not.toMatch(/GATE ERROR/);
    expect(res.status).toBe(0);
    expect(res.stdout).toMatch(/files passed the syntax check/);
  });
});
