// Test-only controller. Not imported by production API or exposed outside loopback.
const path = require('node:path');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '..');
const requireApi = createRequire(path.join(root, 'apps/api/package.json'));
requireApi('reflect-metadata');
const { NestFactory } = requireApi('@nestjs/core');
const { Module, Controller, Get, Inject, BadRequestException } = requireApi('@nestjs/common');
const { AppModule } = require(path.join(root, 'apps/api/dist/app.module.js'));
const { ObservabilityModule } = require(path.join(root, 'apps/api/dist/observability/observability.module.js'));
const { TraceContext } = require(path.join(root, 'apps/api/dist/observability/trace-context.js'));
const { ApiExceptionFilter } = require(path.join(root, 'apps/api/dist/common/api-exception.filter.js'));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
class FixtureController {
  constructor(context) { this.context = context; }
  async success() {
    if (!this.context.current()) return { traced: false };
    await this.context.withSpan('rag.retrieve', async span => {
      span.set('topK', 3).set('prompt', 'w9-private-canary');
      await this.context.withSpan('tool.search', async () => delay(5));
    });
    await this.context.withSpan('llm.generate', async span => {
      span.set('model', 'fixture-model').setUsage(20, 10);
      await delay(10);
    });
    return { traced: true };
  }
  async failure() {
    if (this.context.current()) {
      await this.context.withSpan('tool.search', () => { throw new Error('w9-private-canary'); });
    }
    throw new Error('w9-private-canary');
  }
  async badRequest() { throw new BadRequestException('Invalid fixture input'); }
}
Inject(TraceContext)(FixtureController, undefined, 0);
Controller('w9-fixture')(FixtureController);
for (const method of ['success', 'failure', 'badRequest']) {
  Get(method)(FixtureController.prototype, method, Object.getOwnPropertyDescriptor(FixtureController.prototype, method));
}
class FixtureModule {}
Module({ imports: [AppModule, ObservabilityModule], controllers: [FixtureController] })(FixtureModule);
async function main() {
  const app = await NestFactory.create(FixtureModule, { logger: false });
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new ApiExceptionFilter());
  app.enableShutdownHooks();
  await app.listen(Number(process.env.API_PORT), '127.0.0.1');
  console.log('W9 fixture ready');
}
main().catch(() => { console.error('Fixture startup unavailable'); process.exitCode = 1; });
