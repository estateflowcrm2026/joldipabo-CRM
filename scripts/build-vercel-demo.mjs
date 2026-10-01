// The client preview must never inherit live API or auth settings from Vercel.
process.env.VITE_USE_API_REPOSITORY = 'false';
process.env.VITE_ENABLE_DEMO_ROLE_SWITCHER = 'true';
process.env.VITE_API_BASE_URL = '';
process.env.VITE_DEV_AUTH_TOKEN = '';

const { build } = await import('vite');
await build({ mode: 'demo' });
