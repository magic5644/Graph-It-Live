import { describe, it, expect, beforeEach } from 'vitest';
import { getLogger, setLoggerBackend } from '../../src/shared/logger';

describe('Logger backend integration', () => {
  beforeEach(() => {
    // Reset backend
    setLoggerBackend(undefined);
  });

  it('logger without prefix uses backend', () => {
    const events: Array<{ level: string; message: string }> = [];

    const fakeBackend = {
      createLogger(prefix: string, level?: any) {
        return {
          level: level ?? 'info',
          setLevel() {},
          debug(message: string) { events.push({ level: 'debug', message }); },
          info(message: string) { events.push({ level: 'info', message }); },
          warn(message: string) { events.push({ level: 'warn', message }); },
          error(message: string) { events.push({ level: 'error', message }); },
        };
      }
    };

    setLoggerBackend(fakeBackend);
    const logger = getLogger('');
    logger.info('test message');
    expect(events.length).toBe(1);
    expect(events[0]).toEqual({ level: 'info', message: 'test message' });
  });

  it('preserves existing logger references and forwards to backend', () => {
    const events: Array<{ level: string; prefix: string; message: string }> = [];

    const fakeBackend = {
      createLogger(prefix: string, level?: any) {
        return {
          level: level ?? 'info',
          setLevel() {},
          debug(message: string) { events.push({ level: 'debug', prefix, message }); },
          info(message: string) { events.push({ level: 'info', prefix, message }); },
          warn(message: string) { events.push({ level: 'warn', prefix, message }); },
          error(message: string) { events.push({ level: 'error', prefix, message }); },
        };
      }
    };

    // Create a logger reference before installing backend
    const logger = getLogger('pre-exists');
    logger.setLevel('debug'); // make sure debug logs are allowed

    // This should not go to the fake backend since it's not installed yet
    logger.debug('first');
    expect(events.length).toBe(0);

    // Install backend and log using existing reference
    setLoggerBackend(fakeBackend);
    logger.info('second');
    logger.debug('third');

    expect(events.length).toBe(2);
    expect(events[0]).toEqual({ level: 'info', prefix: 'pre-exists', message: 'second' });
    expect(events[1]).toEqual({ level: 'debug', prefix: 'pre-exists', message: 'third' });
  });

  it('uses backend for new loggers', () => {
    const events: Array<{ level: string; prefix: string; message: string }> = [];
    const fakeBackend = {
      createLogger(prefix: string, level?: any) {
        return {
          level: level ?? 'info',
          setLevel() {},
          debug(message: string) { events.push({ level: 'debug', prefix, message }); },
          info(message: string) { events.push({ level: 'info', prefix, message }); },
          warn(message: string) { events.push({ level: 'warn', prefix, message }); },
          error(message: string) { events.push({ level: 'error', prefix, message }); },
        };
      }
    };

    setLoggerBackend(fakeBackend);
    const logger = getLogger('new-logger');
    logger.info('ok');
    expect(events.length).toBe(1);
    expect(events[0]).toEqual({ level: 'info', prefix: 'new-logger', message: 'ok' });
  });
});
