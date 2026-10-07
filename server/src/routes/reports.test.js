import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app.js';

test('GET /api/v1/reports/agent-performance requires authentication', async () => {
  const app = await buildApp({ logLevel: 'silent' });
  try {
    const response = await app.inject({ method: 'GET', url: '/api/v1/reports/agent-performance?preset=monthly' });
    assert.equal(response.statusCode, 401);
  } finally {
    await app.close();
  }
});
