'use strict';

/**
 * docs/error-handling.md documents `unhandledRejection` as "log + exit(1)",
 * the same policy as `uncaughtException`. The handler previously only logged
 * and never called process.exit(1) for unhandledRejection, silently
 * contradicting the documented policy (and Node's own default fatal
 * behavior, which registering a handler at all suppresses). This suite pins
 * the fixed behavior: both handlers now agree with each other and with docs.
 */

jest.mock('../src/utils/logger', () => ({
  error: jest.fn(),
}));

const logger = require('../src/utils/logger');
const { setupEnforceConsoleErrorLogging } = require('../src/errorHandling');

describe('process-level error handlers (docs/error-handling.md policy)', () => {
  let exitSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    process.removeAllListeners('unhandledRejection');
    process.removeAllListeners('uncaughtException');
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {});
    setupEnforceConsoleErrorLogging();
  });

  afterEach(() => {
    process.removeAllListeners('unhandledRejection');
    process.removeAllListeners('uncaughtException');
    exitSpy.mockRestore();
  });

  it('logs and exits(1) on an unhandled promise rejection', () => {
    const reason = new Error('boom');
    process.emit('unhandledRejection', reason, Promise.resolve());

    expect(logger.error).toHaveBeenCalledWith(
      'Unhandled promise rejection',
      expect.objectContaining({ reason: { message: 'boom', stack: reason.stack } })
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('logs and exits(1) on an uncaught exception', () => {
    const err = new Error('kaboom');
    process.emit('uncaughtException', err);

    expect(logger.error).toHaveBeenCalledWith(
      'Uncaught exception — process is in an untrusted state',
      expect.objectContaining({ error: { message: 'kaboom', stack: err.stack } })
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('both handlers exit with the same code, per the documented policy', () => {
    process.emit('unhandledRejection', new Error('a'), Promise.resolve());
    process.emit('uncaughtException', new Error('b'));

    expect(exitSpy).toHaveBeenNthCalledWith(1, 1);
    expect(exitSpy).toHaveBeenNthCalledWith(2, 1);
  });
});
