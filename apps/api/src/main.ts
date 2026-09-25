import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { ApiExceptionFilter } from './common/api-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: false });
  app.useBodyParser('json', { limit: '4mb' });
  app.useBodyParser('urlencoded', { extended: true, limit: '4mb' });
  app.enableShutdownHooks();
  app.setGlobalPrefix('api/v1');
  app.enableCors({
    origin: process.env.WEB_ORIGIN ?? 'http://localhost:5173',
    exposedHeaders: ['x-trace-id'],
  });
  app.useGlobalFilters(new ApiExceptionFilter());

  const port = Number(process.env.API_PORT ?? 3001);
  await app.listen(port, '0.0.0.0');
  console.log(`Trace Ops API listening on http://localhost:${port}/api/v1`);
}

void bootstrap();
