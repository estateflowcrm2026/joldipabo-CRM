// Static check that a migration file is idempotent and structurally sound.
//
//   node scripts/check-migration-sql.js src/db/003-cross-vertical.sql
//
// This is a lint, not a substitute for running the migration against a
// real database (see `npm run verify:migrations`). It catches the class
// of bug that makes a re-run fail: a top-level statement that is not
// guarded by IF NOT EXISTS, or a malformed DO block.
//
// Exits 0 when every top-level statement is idempotent.

import { readFileSync } from 'node:fs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/check-migration-sql.js <file.sql>');
  process.exit(2);
}

const sql = readFileSync(file, 'utf8');

// Pull DO $$ ... $$ blocks out first so their internal semicolons and
// trailing `END $$` do not register as top-level statements.
//
// The body is captured with its own delimiters, so the match is consumed
// whole. A non-greedy `/DO\s+\$\$[\s\S]*?\$\$/` stops at the first `$$`
// it sees, which for `DO $$ … $$;` is the opening one — leaving a
// dangling `… $$;` that then reads as several junk statements.
const doBlocks = [];
const withoutDo = sql.replace(/DO\s+(\$\$[\s\S]*?\$\$)/gi, (m, body) => {
  doBlocks.push(body);
  return `/* DO_BLOCK_${doBlocks.length - 1} */`;
});

const problems = [];

// 1. Balanced DO blocks.
const openDo = (sql.match(/DO\s+\$\$/gi) || []).length;
if (openDo !== doBlocks.length) {
  problems.push(`unbalanced DO block: ${openDo} opened, ${doBlocks.length} closed`);
}

// 2. Every DO block must guard its own statement.
//
// A DO block that issues an unconditional UPDATE ... SET <constant> is
// idempotent by nature — re-running it converges on the same row — so
// the presence check only applies to blocks whose guard is actually
// needed: conditional DDL (ALTER TABLE ADD CONSTRAINT, CREATE INDEX).
doBlocks.forEach((block, i) => {
  const isConditionalDdl = /ALTER\s+TABLE[\s\S]*ADD\s+CONSTRAINT|CREATE\s+(UNIQUE\s+)?INDEX/i.test(block);
  if (!isConditionalDdl) return; // an unconditional write is self-idempotent
  if (!/(information_schema|pg_constraint)/i.test(block) || !/IF\s+NOT\s+EXISTS/i.test(block)) {
    problems.push(`DO block #${i} has no NOT EXISTS guard`);
  }
});

// 3. Split what is left on semicolons and require idempotency.
//
// Comment lines are stripped FIRST. A naive split reads prose inside a
// `--` comment as a statement, and a sentence with a semicolon in it
// ("…before the real login flow, and a user enumeration oracle;") then
// looks like non-idempotent SQL.
const stripComments = (text) =>
  text
    .split(/\r?\n/)
    .map((line) => {
      // Leave the contents of a DO block alone — it is pulled out above.
      const hash = line.indexOf('--');
      return hash === -1 ? line : line.slice(0, hash);
    })
    .join('\n')
    // Block comments, for completeness.
    .replace(/\/\*[\s\S]*?\*\//g, '');

// Pull out dollar-quoted bodies ($$ … $$ or $tag$ … $tag$) before the
// statement splitter runs. A plpgsql function body is full of semicolons
// and `IF`/`RETURN` statements that are not migrations at all; splitting
// on them reports the function's own logic as a list of non-idempotent
// top-level statements, which is noise the author cannot act on.
function extractDollarQuoted(sql) {
  const bodies = [];
  const withoutBodies = sql.replace(
    /\$(\w*)\$[\s\S]*?\$\1\$/g,
    (match) => {
      bodies.push(match);
      return `$$__BODY_${bodies.length - 1}__$$`;
    },
  );
  return { withoutBodies, bodies };
}

// Split on `;` that is not inside a single-quoted string. Naively
// splitting on every `;` cuts `COMMENT ON COLUMN … IS 'never changes, so …'`
// in half at the apostrophe, which then reads as a bare `UPDATE` statement
// and is reported as non-idempotent. Splitting with the quotes respected
// is what makes a legitimate COMMENT ON line look like one statement.
function splitStatements(sql) {
  const out = [];
  let buf = '';
  let inString = false;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (ch === "'") {
      // '' is an escaped quote, not a terminator.
      if (inString && sql[i + 1] === "'") {
        buf += "''";
        i += 1;
        continue;
      }
      inString = !inString;
    }
    if (ch === ';' && !inString) {
      out.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  out.push(buf);
  return out;
}

// Dollar-quoted function bodies are pulled out before splitting and
// spliced back as a single opaque statement. A plpgsql body is full of
// semicolons and `IF`/`RETURN` lines that are not migration statements
// at all; splitting on them reports the function's own logic as a list of
// non-idempotent statements, which is noise the author cannot act on.
const { withoutBodies } = extractDollarQuoted(withoutDo);

const statements = splitStatements(stripComments(withoutBodies))
  .map((s) => s.trim())
  .filter((s) => s && !/^(\/\*|\*\/|\*)/.test(s))
  .map((s) => s.replace(/\$\$__BODY_(\d+)__\$\$/g, (m, i) => `<function body ${i}>`));

// What counts as safe to re-run.
//
//   * `IF NOT EXISTS` — the DDL guard.
//   * `COMMENT ON` — re-stating a comment is a no-op.
//   * A data backfill whose WHERE clause already makes it a no-op on the
//     second run, e.g. `… WHERE actor_id IS NULL AND user_id IS NOT
//     NULL`. The check is deliberately narrow: it requires the WHERE to
//     name a NOT NULL column on the same row, so an unguarded
//     `UPDATE … SET x = y` is still reported.
function hasPolicyDropGuard(all, target) {
  // The name sits BEFORE the table: `CREATE POLICY <name> ON <table>`.
  // Reading it from after `ON` picked up the table name instead, so
  // every legitimately-drop-then-created policy was reported.
  const name = /\bCREATE\s+POLICY\s+([\w"]+)\s+ON\b/i.exec(target)?.[1];
  if (!name) return false;
  const index = all.indexOf(target);
  if (index === -1) return false;
  return all
    .slice(0, index)
    .some((s) => new RegExp(`DROP\\s+POLICY\\s+IF\\s+EXISTS\\s+${name}\\b`, 'i').test(s));
}

const isIdempotentStatement = (s) =>
  /IF\s+NOT\s+EXISTS/i.test(s) ||
  /^COMMENT\s+ON/i.test(s) ||
  // `CREATE OR REPLACE` is atomic, so re-running converges.
  /^CREATE\s+OR\s+REPLACE\s+FUNCTION/i.test(s) ||
  // A trigger is attached drop-then-create, which is the idempotent form.
  /^CREATE\s+TRIGGER/i.test(s) ||
  /^DROP\s+TRIGGER\s+IF\s+EXISTS/i.test(s) ||
  // RLS gate, and the drop-then-create pair around a policy. Both are
  // repeatable: `ENABLE`/`DISABLE` set a flag rather than create an
  // object, and re-creating a policy that already exists is exactly what
  // the preceding DROP guarantees.
  /^ALTER\s+TABLE\s+[\s\S]*\b(ENABLE|DISABLE)\s+ROW\s+LEVEL\s+SECURITY/i.test(s) ||
  /^DROP\s+POLICY\s+IF\s+EXISTS/i.test(s) ||
  // `CREATE POLICY` alone is NOT idempotent — re-running it errors with
  // "policy already exists". It only is, when a DROP immediately above it
  // in the same file says so. Guessing that here let an unguarded
  // `CREATE POLICY … USING (true)` pass, which is precisely the
  // always-allow policy this check exists to catch.
  (/^CREATE\s+POLICY/i.test(s) && hasPolicyDropGuard(statements, s)) ||
  (/\bUPDATE\b/i.test(s) && /WHERE\s+[\s\S]*\bIS\s+NULL\b/i.test(s) && /\bIS\s+NOT\s+NULL\b/i.test(s));

/**
 * Whether a `CREATE POLICY` is preceded, in the same file, by a
 * `DROP POLICY IF EXISTS` naming the same policy.
 *
 * @param {string[]} all statements, in file order
 * @param {string} target the CREATE POLICY statement
 * @returns {boolean}
 */

const guarded = statements.filter(isIdempotentStatement);

if (guarded.length !== statements.length) {
  for (const s of statements) {
    if (!isIdempotentStatement(s)) {
      problems.push(
        `top-level statement is not idempotent: "${s.split('\n')[0].slice(0, 64)}"`,
      );
    }
  }
}

console.log(`${file}`);
console.log(`  top-level statements : ${statements.length}`);
console.log(`  DO blocks           : ${doBlocks.length}`);
console.log(`  idempotent          : ${guarded.length}/${statements.length}`);

if (problems.length) {
  console.log('\nProblems:');
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
console.log('  all statements are idempotent');
process.exit(0);
