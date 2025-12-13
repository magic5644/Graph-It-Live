import { describe, it, expect, vi } from 'vitest';
import type { WebviewToExtensionMessage } from '../../src/shared/types';
import { WebviewMessageRouter } from '../../src/extension/services/WebviewMessageRouter';

const createLogger = () => ({
  debug: vi.fn(),
});

const createMessage = <T extends WebviewToExtensionMessage>(message: T): T => message;

describe('WebviewMessageRouter', () => {
  it('invokes handler for matching command', async () => {
    const logger = createLogger();
    const readyHandler = vi.fn();
    const router = new WebviewMessageRouter({
      logger,
      handlers: {
        ready: readyHandler,
      },
    });

    await router.handle(createMessage({ command: 'ready' }));

    expect(readyHandler).toHaveBeenCalledTimes(1);
    expect(logger.debug).toHaveBeenCalledWith('Received message', 'ready');
  });

  it('ignores messages without registered handler', async () => {
    const logger = createLogger();
    const router = new WebviewMessageRouter({
      logger,
      handlers: {},
    });

    await router.handle(createMessage({ command: 'refreshGraph' }));

    expect(logger.debug).toHaveBeenCalledWith('Received message', 'refreshGraph');
  });

  it('passes message payload to handler', async () => {
    const logger = createLogger();
    const handler = vi.fn();
    const router = new WebviewMessageRouter({
      logger,
      handlers: {
        openFile: handler,
      },
    });

    const payload = { command: 'openFile', path: '/tmp/file.ts', line: 10 } as WebviewToExtensionMessage;
    await router.handle(payload);

    expect(handler).toHaveBeenCalledWith(payload);
  });
});
