// Test helper for requireDb.test.js.
//
// Runs in a child process with a controlled environment, because
// src/test-support/requireDb.js reads process.env when it is imported and
// `config` in src/config/index.js is frozen the same way.
//
// Prints one marker line so the parent can tell which branch ran.

import { dbConfigured, skipIfNoDb, skipIfDbConfigured } from './requireDb.js';

const fakeT = {
  skip(reason) {
    console.log(`SKIPPED: ${reason}`);
  },
};

// Case 1: a test that NEEDS a database.
if (skipIfNoDb(fakeT)) {
  console.log('RESULT: skipped-db-test');
} else {
  console.log('RESULT: ran-db-test');
}

// Case 2: a test that needs NO database (degraded path).
if (skipIfDbConfigured(fakeT, 'degraded path')) {
  console.log('RESULT: skipped-degraded-test');
} else {
  console.log('RESULT: ran-degraded-test');
}

console.log(`DB_CONFIGURED: ${dbConfigured}`);
