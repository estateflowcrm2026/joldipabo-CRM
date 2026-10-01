// Test helper: imported by a child process to exercise the boot guard with
// the environment already set, because src/config/index.js freezes
// `config` when it is first imported.
import { assertDatabaseTlsUsable } from './index.js';
assertDatabaseTlsUsable();
