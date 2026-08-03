import { describe, expect, test } from 'vitest';
import { ConfigError, loadConfig } from './config.js';

// A complete, valid env with the two optional vars (PORT, LOG_LEVEL) omitted so
// their defaults are exercised. Each test clones and mutates this.
const VALID_ENV: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgres://user:pass@localhost:5432/gb',
  FIREBASE_PROJECT_ID: 'gb-project',
  SWEEP_SHARED_SECRET: 'a-sufficiently-long-secret',
  APP_BASE_URL: 'https://gb.example.com',
};

describe('loadConfig', () => {
  test('parses a valid env and applies PORT/LOG_LEVEL defaults', () => {
    const config = loadConfig({ ...VALID_ENV });
    expect(config.DATABASE_URL).toBe('postgres://user:pass@localhost:5432/gb');
    expect(config.FIREBASE_PROJECT_ID).toBe('gb-project');
    expect(config.SWEEP_SHARED_SECRET).toBe('a-sufficiently-long-secret');
    expect(config.APP_BASE_URL).toBe('https://gb.example.com');
    expect(config.PORT).toBe(8080);
    expect(config.LOG_LEVEL).toBe('info');
  });

  test('coerces an explicit PORT to an int and accepts a LOG_LEVEL override', () => {
    const config = loadConfig({ ...VALID_ENV, PORT: '3000', LOG_LEVEL: 'debug' });
    expect(config.PORT).toBe(3000);
    expect(config.LOG_LEVEL).toBe('debug');
  });

  test('aggregates every failure into ONE error naming each bad var', () => {
    // DATABASE_URL omitted (missing) AND APP_BASE_URL invalid.
    const bad: NodeJS.ProcessEnv = {
      FIREBASE_PROJECT_ID: VALID_ENV.FIREBASE_PROJECT_ID,
      SWEEP_SHARED_SECRET: VALID_ENV.SWEEP_SHARED_SECRET,
      APP_BASE_URL: 'not-a-valid-url',
    };
    let thrown: unknown;
    try {
      loadConfig(bad);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ConfigError);
    const message = (thrown as ConfigError).message;
    // A single aggregated error naming BOTH offending vars.
    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('APP_BASE_URL');
  });

  test('rejects a SWEEP_SHARED_SECRET shorter than 16 characters', () => {
    expect(() => loadConfig({ ...VALID_ENV, SWEEP_SHARED_SECRET: 'short' })).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ ...VALID_ENV, SWEEP_SHARED_SECRET: 'short' })).toThrow(
      /SWEEP_SHARED_SECRET/,
    );
  });

  test('a 16-character SWEEP_SHARED_SECRET is the accepted boundary', () => {
    const sixteen = '0123456789abcdef'; // exactly 16
    expect(sixteen).toHaveLength(16);
    const config = loadConfig({ ...VALID_ENV, SWEEP_SHARED_SECRET: sixteen });
    expect(config.SWEEP_SHARED_SECRET).toBe(sixteen);
  });

  test('a missing required var still throws ConfigError', () => {
    // FIREBASE_PROJECT_ID omitted.
    const bad: NodeJS.ProcessEnv = {
      DATABASE_URL: VALID_ENV.DATABASE_URL,
      SWEEP_SHARED_SECRET: VALID_ENV.SWEEP_SHARED_SECRET,
      APP_BASE_URL: VALID_ENV.APP_BASE_URL,
    };
    expect(() => loadConfig(bad)).toThrow(ConfigError);
    expect(() => loadConfig(bad)).toThrow(/FIREBASE_PROJECT_ID/);
  });
});
