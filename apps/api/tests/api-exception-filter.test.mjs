import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { ApiExceptionFilter } = require('../dist/common/api-exception.filter.js');

function invokeFilter(exception) {
  let responseBody;
  let responseStatus;
  const response = {
    status(code) { responseStatus = code; return this; },
    json(body) { responseBody = body; },
  };
  const host = {
    switchToHttp() { return { getResponse() { return response; } }; },
  };
  new ApiExceptionFilter().catch(exception, host);
  return { status: responseStatus, body: responseBody };
}

test('body parser 超限和 JSON 解析错误使用安全固定文案，不回显附带 body', () => {
  const sentinel = 'private-request-body-marker';
  const tooLarge = invokeFilter({ type: 'entity.too.large', body: sentinel, message: sentinel });
  assert.equal(tooLarge.status, 413);
  assert.equal(tooLarge.body.message, 'Request body is too large');
  assert.equal(JSON.stringify(tooLarge.body).includes(sentinel), false);

  const invalidJson = invokeFilter({ type: 'entity.parse.failed', body: sentinel, message: sentinel });
  assert.equal(invalidJson.status, 400);
  assert.equal(invalidJson.body.message, 'Request body is invalid JSON');
  assert.equal(JSON.stringify(invalidJson.body).includes(sentinel), false);
});
