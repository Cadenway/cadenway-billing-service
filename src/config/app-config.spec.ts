import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

import { ConfigError, loadConfig } from '@cadenway/nest-common';
import { describe, expect, it } from 'vitest';

import { appConfigSchema, migrationConfigSchema } from './app-config.js';

describe('appConfigSchema', () => {
  const trustedIssuers: string =
    '{"api-gateway":[{"kty":"OKP","crv":"Ed25519","x":"MVZQc5h6AXxnMpaBTaYw5kI-yWWawl6zp8Srhuf5NK0","kid":"local-placeholder"}]}';
  const complete: Readonly<Record<string, string>> = {
    PORT: '3012',
    DATABASE_URL: 'postgres://billing_app:billing_app@localhost:5432/billing',
    NATS_URL: 'nats://localhost:4222',
    NATS_USER: 'billing',
    NATS_PASSWORD: 'billing',
    INTERNAL_TOKEN_AUDIENCE: 'billing-service',
    INTERNAL_TOKEN_TRUSTED_ISSUERS: trustedIssuers,
  };

  it('reads the variables of the service with the defaults of the kit', () => {
    expect(loadConfig(appConfigSchema, complete)).toEqual({
      NODE_ENV: 'production',
      PORT: 3012,
      LOG_LEVEL: 'info',
      LOG_PRETTY: false,
      DATABASE_URL: 'postgres://billing_app:billing_app@localhost:5432/billing',
      DATABASE_TRANSACTION_MAX_ATTEMPTS: 3,
      NATS_URL: 'nats://localhost:4222',
      NATS_USER: 'billing',
      NATS_PASSWORD: 'billing',
      BILLING_USAGE_ENABLED: false,
      BILLING_STRIPE_WEBHOOK_MODE: 'test',
      INTERNAL_TOKEN_AUDIENCE: 'billing-service',
      INTERNAL_TOKEN_TRUSTED_ISSUERS: {
        'api-gateway': [
          {
            kty: 'OKP',
            crv: 'Ed25519',
            x: 'MVZQc5h6AXxnMpaBTaYw5kI-yWWawl6zp8Srhuf5NK0',
            kid: 'local-placeholder',
          },
        ],
      },
    });
  });

  it('accepts the committed .env.example as it is', () => {
    const example: NodeJS.Dict<string> = parseEnv(
      readFileSync(new URL('../../.env.example', import.meta.url), 'utf8'),
    );

    expect(() => loadConfig(appConfigSchema, example)).not.toThrow();
    expect(() => loadConfig(migrationConfigSchema, example)).not.toThrow();
  });

  it('loads a mode and two overlapping webhook keys for rotation', () => {
    expect(
      loadConfig(appConfigSchema, {
        ...complete,
        BILLING_STRIPE_WEBHOOK_MODE: 'live',
        BILLING_STRIPE_WEBHOOK_SECRETS: JSON.stringify(['whsec_current', 'whsec_previous']),
      }),
    ).toMatchObject({
      BILLING_STRIPE_WEBHOOK_MODE: 'live',
      BILLING_STRIPE_WEBHOOK_SECRETS: ['whsec_current', 'whsec_previous'],
    });
  });

  it('reports malformed webhook key configuration without printing the keys', () => {
    const malformed = {
      ...complete,
      BILLING_STRIPE_WEBHOOK_SECRETS: '["whsec_placeholder", broken]',
    };
    expect(() => loadConfig(appConfigSchema, malformed)).toThrow(/BILLING_STRIPE_WEBHOOK_SECRETS/u);
    expect(() => loadConfig(appConfigSchema, malformed)).not.toThrow(/whsec_placeholder/u);
  });

  it('requires both source origins and the signing key when usage is enabled', () => {
    const enabled = { ...complete, BILLING_USAGE_ENABLED: 'true' };

    expect(() => loadConfig(appConfigSchema, enabled)).toThrow(
      /ORGANIZATION_SERVICE_URL[\s\S]*STORAGE_SERVICE_URL[\s\S]*INTERNAL_TOKEN_PRIVATE_JWK/u,
    );
  });

  it('refuses credentials and paths in the internal source origins without echoing them', () => {
    const config = {
      ...complete,
      ORGANIZATION_SERVICE_URL: 'https://billing:example-credential@organization.local',
      STORAGE_SERVICE_URL: 'https://storage.local/example-path',
    };

    expect(() => loadConfig(appConfigSchema, config)).toThrow(
      /ORGANIZATION_SERVICE_URL[\s\S]*STORAGE_SERVICE_URL/u,
    );
    expect(() => loadConfig(appConfigSchema, config)).not.toThrow(
      /example-credential|example-path/u,
    );
  });

  it('refuses to start without the database, the broker, the audience or the trusted issuers', () => {
    expect(() => loadConfig(appConfigSchema, { PORT: '3012' })).toThrow(ConfigError);
    try {
      loadConfig(appConfigSchema, { PORT: '3012' });
    } catch (error) {
      const issues: readonly string[] = (error as ConfigError).issues;
      expect(issues.map((issue) => issue.split(':')[0])).toEqual(
        expect.arrayContaining([
          'DATABASE_URL',
          'NATS_URL',
          'INTERNAL_TOKEN_AUDIENCE',
          'INTERNAL_TOKEN_TRUSTED_ISSUERS',
        ]),
      );
    }
  });

  it('refuses a database URL that is not PostgreSQL, without printing it', () => {
    const secret: string = 'mysql://billing_app:s3cret@localhost/billing';

    expect(() => loadConfig(appConfigSchema, { ...complete, DATABASE_URL: secret })).toThrow(
      /DATABASE_URL/u,
    );
    expect(() => loadConfig(appConfigSchema, { ...complete, DATABASE_URL: secret })).not.toThrow(
      /s3cret/u,
    );
  });

  it('refuses a broker URL that is not NATS, without printing it', () => {
    const secret: string = 'http://billing:s3cret@localhost:4222';

    expect(() => loadConfig(appConfigSchema, { ...complete, NATS_URL: secret })).toThrow(
      /NATS_URL/u,
    );
    expect(() => loadConfig(appConfigSchema, { ...complete, NATS_URL: secret })).not.toThrow(
      /s3cret/u,
    );
  });

  it('refuses a private key listed as a verification key', () => {
    const withPrivateKey: string = trustedIssuers.replace('"kid"', `"d":"${'A'.repeat(43)}","kid"`);

    expect(() =>
      loadConfig(appConfigSchema, { ...complete, INTERNAL_TOKEN_TRUSTED_ISSUERS: withPrivateKey }),
    ).toThrow(/INTERNAL_TOKEN_TRUSTED_ISSUERS/u);
  });

  it('does not read the migrator URL: the running service never needs it', () => {
    expect(loadConfig(appConfigSchema, complete)).not.toHaveProperty('MIGRATION_DATABASE_URL');
  });
});

describe('migrationConfigSchema', () => {
  it('reads the URL of the migrator role', () => {
    expect(
      loadConfig(migrationConfigSchema, {
        MIGRATION_DATABASE_URL:
          'postgres://billing_migrator:billing_migrator@localhost:5432/billing',
      }),
    ).toEqual({
      MIGRATION_DATABASE_URL: 'postgres://billing_migrator:billing_migrator@localhost:5432/billing',
    });
  });

  it('names MIGRATION_DATABASE_URL when it is missing', () => {
    expect(() =>
      loadConfig(migrationConfigSchema, {
        DATABASE_URL: 'postgres://billing_app:billing_app@localhost:5432/billing',
      }),
    ).toThrow(/MIGRATION_DATABASE_URL: required, not set/u);
  });

  it('names MIGRATION_DATABASE_URL when it is not a PostgreSQL URL, without printing it', () => {
    const secret: string = 'mysql://billing_migrator:s3cret@localhost/billing';

    expect(() => loadConfig(migrationConfigSchema, { MIGRATION_DATABASE_URL: secret })).toThrow(
      /MIGRATION_DATABASE_URL: Expected the postgres:\/\/ URL of the migrator role/u,
    );
    expect(() => loadConfig(migrationConfigSchema, { MIGRATION_DATABASE_URL: secret })).not.toThrow(
      /s3cret/u,
    );
  });
});
