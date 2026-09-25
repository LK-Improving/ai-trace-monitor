import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { AdminTokenGuard } = require('../dist/admin/admin-token.guard.js');

function context(authorization) {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ headers: { authorization } }),
    }),
  };
}

function config(token) {
  return { get: (name) => (name === 'PLATFORM_ADMIN_TOKEN' ? token : undefined) };
}

test('管理令牌未配置时 fail closed', () => {
  const guard = new AdminTokenGuard(config(undefined));
  assert.throws(() => guard.canActivate(context('Bearer anything')), (error) => error.getStatus() === 401);
});

test('缺失、格式错误或不匹配的管理令牌均返回 401', () => {
  const guard = new AdminTokenGuard(config('configured-secret-for-test'));
  for (const authorization of [undefined, 'Basic configured-secret-for-test', 'Bearer wrong', 'Bearer one two']) {
    assert.throws(() => guard.canActivate(context(authorization)), (error) => error.getStatus() === 401);
  }
});

test('正确的 Bearer 管理令牌允许请求继续', () => {
  const guard = new AdminTokenGuard(config('configured-secret-for-test'));
  assert.equal(guard.canActivate(context('Bearer configured-secret-for-test')), true);
});
