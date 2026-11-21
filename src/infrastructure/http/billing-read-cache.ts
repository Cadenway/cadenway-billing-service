import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';

const billingReadPath = /^\/internal\/v1\/billing\/(?:subscription|entitlement)\/?$/iu;

/** Applies private cache control before guards and to body-parser errors on Billing reads. */
export function configureBillingReadCache(app: Pick<NestExpressApplication, 'use'>): void {
  app.use(billingReadPath, (request: Request, response: Response, next: NextFunction): void => {
    response.setHeader('Cache-Control', 'private, no-store');
    if (request.method === 'GET' || request.method === 'HEAD') {
      delete request.headers['if-none-match'];
      delete request.headers['if-modified-since'];
    }
    next();
  });
  app.use(
    billingReadPath,
    (error: unknown, _request: Request, response: Response, next: NextFunction): void => {
      response.setHeader('Cache-Control', 'private, no-store');
      next(error);
    },
  );
}
