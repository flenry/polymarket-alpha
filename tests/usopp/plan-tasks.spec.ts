import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';

const ROOT = path.resolve(__dirname, '..', '..');
const DRIZZLE = path.join(ROOT, 'drizzle');
const META = path.join(DRIZZLE, 'meta');

function run(cmd: string, cwd = ROOT): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    exec(cmd, { cwd, shell: true }, (error, stdout, stderr) => {
      resolve({ stdout: String(stdout), stderr: String(stderr), code: error && (error as any).code ? (error as any).code : 0 });
    });
  });
}

describe('PLAN.md Tasks (Test-First) — failing tests until implementation', () => {
  it('Task 1 — drizzle/ should only contain 0000_*, 0002_* and meta/ (delete orphan 0001)', () => {
    const entries = fs.readdirSync(DRIZZLE).sort();
    // Expect exactly these entries
    const expected = ['0000_misty_thaddeus_ross.sql', '0002_partition_trades.sql', 'meta'].sort();
    expect(entries).toEqual(expected);
  });

  it('Task 2 — drizzle/meta/_journal.json should have 2 entries and register 0002_partition_trades as idx 1', () => {
    const journalPath = path.join(META, '_journal.json');
    expect(fs.existsSync(journalPath)).toBe(true);
    const raw = fs.readFileSync(journalPath, 'utf-8');
    const j = JSON.parse(raw);
    expect(Array.isArray(j.entries)).toBe(true);
    expect(j.entries.length).toBe(2);
    expect(j.entries[1].tag).toBe('0002_partition_trades');
    expect(j.entries[1].idx).toBe(1);
  });

  it('Task 4 — drizzle/meta/README.md should exist and document the missing 0001_snapshot.json', () => {
    const readme = path.join(DRIZZLE, 'README.md');
    expect(fs.existsSync(readme)).toBe(true);
    const txt = fs.readFileSync(readme, 'utf-8');
    // check for the operational rule sentence from PLAN.md
    expect(txt.includes('Never run `drizzle-kit push` or `drizzle-kit generate` against a DB that has already had `0002` applied')).toBe(true);
  });

  it('Task 5 — pnpm db:generate must be idempotent ("No changes detected")', async () => {
    const { stdout, stderr, code } = await run('pnpm db:generate');
    // We expect the generate command to succeed and report no changes
    expect(code).toBe(0);
    const out = (stdout + '\n' + stderr).toLowerCase();
    expect(out.includes('no changes detected') || out.includes('no changes')).toBe(true);
  });

  it('Task 6 — package.json should include db:migrate:partitions script (conditional fallback)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'));
    expect(pkg.scripts).toBeDefined();
    expect(pkg.scripts['db:migrate:partitions']).toBeDefined();
  });
});
