import { NestFactory } from '@nestjs/core';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // CB-006: Security headers
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"], scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'https://cdn.creativebase.co.za'],
        objectSrc: ["'none'"], frameSrc: ["'none'"],
      },
    },
    hsts: { maxAge: 31536000, includeSubDomains: true, preload: true },
  }));

  // CORS
  app.enableCors({
    origin: [process.env['APP_URL'] ?? 'http://localhost:3000'],
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  // Global validation pipe
  app.useGlobalPipes(new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    transformOptions: { enableImplicitConversion: true },
  }));

  // API versioning + prefix
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.setGlobalPrefix('api');

  // CB-003: OpenAPI / Swagger docs
  const config = new DocumentBuilder()
    .setTitle('CreativeBase API')
    .setDescription('CreativeBase platform REST API')
    .setVersion('1.0')
    .addBearerAuth()
    .addTag('auth').addTag('creators').addTag('search')
    .addTag('unlocks').addTag('subscriptions').addTag('admin').addTag('health')
    .build();
  SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, config));

  await app.listen(process.env['PORT'] ?? 3001);
  console.log('CreativeBase API running on port', process.env['PORT'] ?? 3001);
}

bootstrap().catch(console.error);