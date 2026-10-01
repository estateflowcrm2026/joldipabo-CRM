// Repository accessor. Returns the currently active repository implementation.
// Today that is the demo repository backed by seed data; the API repository
// can be enabled with `VITE_USE_API_REPOSITORY=true` (see
// `docs/API_REPOSITORY_SETUP.md`). When enabled, only listings calls go to
// the backend — every other entity still falls back to the demo.
//
// Usage:
//   import { getRepository } from '../services/index.js';
//   const repo = getRepository();
//   const { items } = await repo.list('listings');
//
// To swap at runtime (for an integration test or an A/B cohort):
//   import { apiRepository } from './apiRepository.js';
//   import { setRepository } from './index.js';
//   setRepository(apiRepository);
//
// To force a particular implementation regardless of env flag:
//   import { selectRepositoryFromEnv, setRepository } from './index.js';
//   setRepository(selectRepositoryFromEnv());

import { demoRepository } from './demoRepository.js';
import { apiRepository } from './apiRepository.js';

// Initialize the active repository from the env flag at module load. Without
// this, VITE_USE_API_REPOSITORY=true is inert and the demo is always used.
// `selectRepositoryFromEnv()` itself reads the flag at call time, so a test
// that mutates `import.meta.env` between imports gets the right behaviour;
// reading it once at module load matches how Vite inlines the value in a
// production build.
let activeRepository = selectRepositoryFromEnv();

export const getRepository = () => activeRepository;

export const setRepository = (next) => {
  if (!next) {
    throw new Error('Repository implementation is required');
  }
  activeRepository = next;
};

export const resetRepository = () => {
  activeRepository = demoRepository;
};

/**
 * Whether the ACTIVE repository is the backend-backed API implementation.
 *
 * This is the single source of truth for "are we in live mode?" — the UI
 * data layers must key off the repository, not the demo role-switcher flag
 * (`isDemoMode()` in demoFlags.js). Those two flags are independent:
 * `VITE_USE_API_REPOSITORY` picks the data origin, `VITE_ENABLE_DEMO_ROLE_SWITCHER`
 * only controls the demo affordance. Keying listings off the switcher flag
 * meant a build with both flags on silently served seed listings and never
 * touched the backend.
 *
 * @returns {boolean}
 */
export const isApiRepositoryActive = () => activeRepository === apiRepository;

/**
 * Returns the repository implementation chosen by the `VITE_USE_API_REPOSITORY`
 * env flag. When the flag is unset or anything other than the literal string
 * `'true'`, returns the demo repository. When set to `'true'`, returns the
 * API repository (which itself delegates non-listings calls back to demo).
 *
 * Reading the env at *call time* — not at module load — keeps the choice
 * overridable in tests that mutate `import.meta.env` after import. In a
 * production build Vite inlines the value, so this read is effectively
 * constant.
 *
 * @returns {{ list: Function, get: Function, create: Function, update: Function, remove: Function, custom: object }}
 */
export function selectRepositoryFromEnv() {
  const env = (typeof import.meta !== 'undefined' && import.meta.env) || {};
  const flag = env.VITE_USE_API_REPOSITORY;
  if (flag === 'true') return apiRepository;
  return demoRepository;
}

// Re-export both implementations so tests, the smoke script, and the
// runtime swap path can grab either directly.
export { demoRepository, apiRepository };

// Re-export the contract types for convenience. The actual types live in
// repositoryTypes.js as JSDoc typedefs; importing this file gives consumers
// a single entry point.
export { ENTITY_NAMES } from './repositoryTypes.js';
