// E2E round 5 bug 2: validation errors are 400 with a short message, not 500 with raw JSON.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { errStatus, errMessage } from '../src/errors.ts';

describe('errStatus / errMessage', () => {
  it('maps a ZodError to 400 with a one-line message', () => {
    const r = z.object({ password: z.string().min(8) }).safeParse({ password: 'short' });
    assert.equal(r.success, false);
    const e = (r as { error: z.ZodError }).error;
    assert.equal(errStatus(e), 400);
    assert.match(errMessage(e), /^invalid input: password: /);
    assert.ok(!errMessage(e).includes('['));
  });
  it('keeps status and message of other errors; unknown is 500', () => {
    const e = Object.assign(new Error('not found'), { status: 404 });
    assert.equal(errStatus(e), 404);
    assert.equal(errMessage(e), 'not found');
    assert.equal(errStatus(new Error('boom')), 500);
  });
});
