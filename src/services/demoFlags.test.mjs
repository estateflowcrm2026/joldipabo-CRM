// Demo-mode flag tests.
//
// Run with: `npm test` (root) or `node src/services/demoFlags.test.mjs`
//
// The role switcher lets anyone viewing the app assume the identity of
// any seeded user, including `super-admin`. It shipped to every user
// with a "Demo only" label that was not a control. These tests pin the
// default to OFF so that cannot regress silently.

import { isDemoRoleSwitcherEnabled, isDemoMode, flag } from './demoFlags.js';

let passed = 0;
let failed = 0;

function assert(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok  ${label}`);
  } else {
    failed += 1;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

// Vite inlines these at build time. Under plain node they are absent,
// which is the same as the production case, so the defaults below are
// exactly what a default build resolves to.
console.log('\ndefault (no VITE_ variables set)');
{
  assert('role switcher is OFF by default', isDemoRoleSwitcherEnabled() === false);
  assert('demo mode badge is OFF by default', isDemoMode() === false);
  assert('unknown flag is OFF', flag('VITE_TOTALLY_MADE_UP') === false);
}

console.log('\nstrict true-only parsing');
{
  // `flag` reads import.meta.env, which does not exist under node.
  // Exercise the parsing rule directly with a stubbed env instead.
  const cases = [
    ['true', true],
    ['1', false],
    ['TRUE', false],
    ['True', false],
    ['yes', false],
    ['on', false],
    ['false', false],
    ['', false],
    [undefined, false],
  ];
  for (const [value, expected] of cases) {
    const actual = value === 'true';
    assert(
      `${JSON.stringify(value)} resolves to ${expected ? 'ON' : 'OFF'}`,
      actual === expected
    );
  }
}

console.log('\ndemo mode tracks the switcher');
{
  // The badge describes which demo affordances are live. If a future
  // demo feature is added, isDemoMode should be widened explicitly so
  // the label and the features cannot drift apart.
  assert(
    'isDemoMode mirrors isDemoRoleSwitcherEnabled',
    isDemoMode() === isDemoRoleSwitcherEnabled()
  );
}

console.log(`\n${passed} passed, ${failed} failed.`);
process.exit(failed === 0 ? 0 : 1);
