import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../app.js';

for (const [method, url] of [
  ['GET', '/api/v1/contacts'],
  ['GET', '/api/v1/contacts/ct_any'],
  ['GET', '/api/v1/contacts/ct_any/calls'],
  ['POST', '/api/v1/contacts'],
  ['POST', '/api/v1/contacts/ct_any/calls'],
  ['POST', '/api/v1/contacts/ct_any/convert'],
]) {
  test(`${method} ${url} requires authentication`, async () => {
    const app = await buildApp({ logLevel: 'silent' });
    try {
      const response = await app.inject({ method, url, payload: method === 'POST' ? {} : undefined });
      assert.equal(response.statusCode, 401);
    } finally {
      await app.close();
    }
  });
}
