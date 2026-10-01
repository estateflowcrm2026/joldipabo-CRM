// Demo-mode feature flags.
//
// The demo build ships affordances a production build must never show:
// most importantly the role switcher, which lets anyone viewing the app
// assume the identity of any seeded user — including `super-admin`.
// The "Demo only" text next to it was a label, not a control, so the
// switcher shipped to everyone.
//
// Each flag is opt-in and defaults to OFF. A flag is enabled only when
// its VITE_ variable is exactly the string 'true'.
//
// ⚠️  Vite inlines every `VITE_*` variable into the public bundle at
//     build time. These flags are therefore a build-time decision, not
//     a runtime one: they are baked into whatever artefact you deploy.
//     Turning one on means anyone with that artefact can use it.
//
// See docs/ENVIRONMENT.md and docs/PRODUCTION_LAUNCH_CHECKLIST.md §0.2.

/**
 * Read a boolean Vite flag.
 *
 * Strictly `=== 'true'`. Anything else — '1', 'TRUE', 'yes', undefined,
 * or a typo — is treated as OFF. Vite already coerces a bare `VITE_X=`
 * in a .env file to the string 'true', so the common case works, but
 * ambiguity in either direction would be the wrong default for a switch
 * that controls access.
 */
function flag(name) {
  const env = (typeof import.meta !== 'undefined' && import.meta.env) || {};
  return env[name] === 'true';
}

/**
 * Whether the demo role switcher may be rendered and used.
 *
 * Gates the desktop topbar switcher and the mobile drawer section. When
 * false, neither renders at all — not a disabled control, nothing.
 * `currentUser` is then whatever the session resolves to; in the demo
 * build that is still the seeded default, and in a real deployment it
 * will be the authenticated user.
 */
export const isDemoRoleSwitcherEnabled = () => flag('VITE_ENABLE_DEMO_ROLE_SWITCHER');

/**
 * Whether to show the "Demo mode" badge.
 *
 * Tied to the role switcher rather than being its own flag: if the
 * switcher is off there is nothing to disclose. A future demo-only
 * affordance should be added here explicitly, so the label and the
 * features it describes cannot drift apart.
 */
export const isDemoMode = () => isDemoRoleSwitcherEnabled();

export { flag };
