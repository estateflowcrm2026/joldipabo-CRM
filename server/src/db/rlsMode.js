// Which RLS mode this process runs in.
//
// WHY A MODE AT ALL
// -----------------
// Enabling row-level security is not a single change. The policies have
// to be right, the application has to set a tenant on every scoped
// transaction, and the connecting role has to actually be subject to
// policy. Any one of those can be wrong, and a broken rollout is a
// production outage rather than a security failure — which is the
// easier mistake to make.
//
// So RLS is a mode, resolved once at startup, and each mode is a
// different assertion about how far the rollout has got:
//
//   off      (default) No RLS. The app behaves exactly as it did before.
//                     Predicates in the repositories are the only
//                     isolation, as before this module existed.
//
//   probe    Policies exist and ENABLE ROW LEVEL SECURITY is set, but the
//            application is expected to behave IDENTICALLY. The test
//            suite and the smokes run unchanged, and any divergence is
//            a failure. This is how a policy is proved correct before
//            it is allowed to deny anything.
//
//   enforce  RLS is live. Protected tables are invisible without a tenant
//            context. Only correct with a non-owner, non-BYPASSRLS role
//            — see docs/RLS_ROLLOUT_PLAN.md §1.
//
// NOT a security control
// ----------------------
// This is a rollout switch, not a boundary. Anyone who can set an
// environment variable can turn RLS off; that is the same property as
// `DEV_AUTH_ENABLED`, and it is deliberate so that the rollback step is
// "change one variable and redeploy" rather than "revert a migration".
// What protects the setting is the same thing that protects every other
// one: the production environment, and the boot guards in
// src/config/index.js.

const MODES = new Set(['off', 'probe', 'enforce']);

/**
 * @returns {'off'|'probe'|'enforce'}
 */
export function rlsMode() {
  // An empty string is treated as unset. A compose file or CI matrix
  // that sets `DB_RLS_MODE=${{ inputs.rls }}` with no default produces
  // "", and refusing to boot over that would be a worse failure than
  // defaulting to the inert mode.
  const raw = String(process.env.DB_RLS_MODE ?? '').trim().toLowerCase();
  if (raw === '') return 'off';

  if (!MODES.has(raw)) {
    // An unrecognised value must not fall back to a permissive default.
    // `off` is the current behaviour, so a typo there is merely inert;
    // a typo that resolved to `enforce` would break production. Refuse
    // instead, so a misconfiguration is visible at boot.
    throw new Error(
      `DB_RLS_MODE must be one of ${[...MODES].join(', ')}; got "${raw}".\n` +
        '  See docs/RLS_ROLLOUT_PLAN.md §5.',
    );
  }
  return raw;
}

/** True when `ENABLE ROW LEVEL SECURITY` should be set. */
export function rlsEnabled() {
  return rlsMode() !== 'off';
}

/** True when RLS should be treated as live for tenant-scoped writes. */
export function rlsEnforced() {
  return rlsMode() === 'enforce';
}

/**
 * Describe the mode for logs and for the test oracle.
 *
 * @returns {{mode: string, enabled: boolean, enforced: boolean}}
 */
export function describeRls() {
  const mode = rlsMode();
  return { mode, enabled: mode !== 'off', enforced: mode === 'enforce' };
}
