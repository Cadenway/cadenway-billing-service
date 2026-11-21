import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';

const subscriptionPath = /^\/internal\/v1\/billing\/subscription\/?$/iu;

/** Applies private cache control before guards and to body-parser errors for the subscription route. */
export function configureBillingSubscriptionCache(app: Pick<NestExpressApplication, 'use'>): void {
  app.use(subscriptionPath, (request: Request, response: Response, next: NextFunction): void => {
    response.setHeader('Cache-Control', 'private, no-store');
    if (request.method === 'GET' || request.method === 'HEAD') {
      delete request.headers['if-none-match'];
      delete request.headers['if-modified-since'];
    }
    next();
  });
  app.use(
    subscriptionPath,
    (error: unknown, _request: Request, response: Response, next: NextFunction): void => {
      response.setHeader('Cache-Control', 'private, no-store');
      next(error);
    },
  );
}
