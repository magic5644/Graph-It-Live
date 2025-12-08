import { describe, it, expect } from 'vitest';
import { SpiderError, SpiderErrorCode } from '../../src/analyzer/types';

describe('SpiderError', () => {
    describe('constructor', () => {
        it('should create error with code and message', () => {
            const error = new SpiderError('Test error', SpiderErrorCode.FILE_NOT_FOUND);

            expect(error.message).toBe('Test error');
            expect(error.code).toBe(SpiderErrorCode.FILE_NOT_FOUND);
            expect(error.name).toBe('SpiderError');
            expect(error.timestamp).toBeGreaterThan(0);
        });

        it('should create error with filePath option', () => {
            const error = new SpiderError('Test', SpiderErrorCode.PARSE_ERROR, {
                filePath: '/src/test.ts',
            });

            expect(error.filePath).toBe('/src/test.ts');
        });

        it('should create error with cause option', () => {
            const cause = new Error('Original error');
            const error = new SpiderError('Wrapped', SpiderErrorCode.UNKNOWN, {
                cause,
            });

            expect(error.cause).toBe(cause);
        });
    });

    describe('fromError', () => {
        it('should return same error if already SpiderError', () => {
            const original = new SpiderError('Test', SpiderErrorCode.TIMEOUT);
            const result = SpiderError.fromError(original);

            expect(result).toBe(original);
        });

        it('should classify ENOENT as FILE_NOT_FOUND', () => {
            const nodeError = new Error('File not found') as NodeJS.ErrnoException;
            nodeError.code = 'ENOENT';

            const result = SpiderError.fromError(nodeError, '/missing.ts');

            expect(result.code).toBe(SpiderErrorCode.FILE_NOT_FOUND);
            expect(result.filePath).toBe('/missing.ts');
            expect(result.cause).toBe(nodeError);
        });

        it('should classify EACCES as PERMISSION_DENIED', () => {
            const nodeError = new Error('Permission denied') as NodeJS.ErrnoException;
            nodeError.code = 'EACCES';

            const result = SpiderError.fromError(nodeError);

            expect(result.code).toBe(SpiderErrorCode.PERMISSION_DENIED);
        });

        it('should classify EPERM as PERMISSION_DENIED', () => {
            const nodeError = new Error('Operation not permitted') as NodeJS.ErrnoException;
            nodeError.code = 'EPERM';

            const result = SpiderError.fromError(nodeError);

            expect(result.code).toBe(SpiderErrorCode.PERMISSION_DENIED);
        });

        it('should classify "too large" message as FILE_TOO_LARGE', () => {
            const error = new Error('File is too large to process');

            const result = SpiderError.fromError(error);

            expect(result.code).toBe(SpiderErrorCode.FILE_TOO_LARGE);
        });

        it('should classify parse-related message as PARSE_ERROR', () => {
            const error = new Error('Failed to parse file');

            const result = SpiderError.fromError(error);

            expect(result.code).toBe(SpiderErrorCode.PARSE_ERROR);
        });

        it('should classify syntax-related message as PARSE_ERROR', () => {
            const error = new Error('syntax error at line 5');

            const result = SpiderError.fromError(error);

            expect(result.code).toBe(SpiderErrorCode.PARSE_ERROR);
        });

        it('should classify timeout message as TIMEOUT', () => {
            const error = new Error('Operation timeout');

            const result = SpiderError.fromError(error);

            expect(result.code).toBe(SpiderErrorCode.TIMEOUT);
        });

        it('should classify ETIMEDOUT as TIMEOUT', () => {
            const nodeError = new Error('Connection timed out') as NodeJS.ErrnoException;
            nodeError.code = 'ETIMEDOUT';

            const result = SpiderError.fromError(nodeError);

            expect(result.code).toBe(SpiderErrorCode.TIMEOUT);
        });

        it('should default to UNKNOWN for unclassified errors', () => {
            const error = new Error('Something went wrong');

            const result = SpiderError.fromError(error);

            expect(result.code).toBe(SpiderErrorCode.UNKNOWN);
        });

        it('should handle non-Error objects', () => {
            const result = SpiderError.fromError('string error');

            expect(result.message).toBe('string error');
            expect(result.code).toBe(SpiderErrorCode.UNKNOWN);
            expect(result.cause).toBeUndefined();
        });
    });

    describe('isRecoverable', () => {
        it('should return true for FILE_NOT_FOUND', () => {
            const error = new SpiderError('', SpiderErrorCode.FILE_NOT_FOUND);
            expect(error.isRecoverable()).toBe(true);
        });

        it('should return true for PERMISSION_DENIED', () => {
            const error = new SpiderError('', SpiderErrorCode.PERMISSION_DENIED);
            expect(error.isRecoverable()).toBe(true);
        });

        it('should return true for PARSE_ERROR', () => {
            const error = new SpiderError('', SpiderErrorCode.PARSE_ERROR);
            expect(error.isRecoverable()).toBe(true);
        });

        it('should return true for RESOLUTION_FAILED', () => {
            const error = new SpiderError('', SpiderErrorCode.RESOLUTION_FAILED);
            expect(error.isRecoverable()).toBe(true);
        });

        it('should return false for TIMEOUT', () => {
            const error = new SpiderError('', SpiderErrorCode.TIMEOUT);
            expect(error.isRecoverable()).toBe(false);
        });

        it('should return false for UNKNOWN', () => {
            const error = new SpiderError('', SpiderErrorCode.UNKNOWN);
            expect(error.isRecoverable()).toBe(false);
        });

        it('should return false for FILE_TOO_LARGE', () => {
            const error = new SpiderError('', SpiderErrorCode.FILE_TOO_LARGE);
            expect(error.isRecoverable()).toBe(false);
        });
    });

    describe('toUserMessage', () => {
        it('should return friendly message for FILE_NOT_FOUND', () => {
            const error = new SpiderError('', SpiderErrorCode.FILE_NOT_FOUND, {
                filePath: '/test.ts',
            });
            expect(error.toUserMessage()).toBe('File not found: /test.ts');
        });

        it('should return friendly message for PERMISSION_DENIED', () => {
            const error = new SpiderError('', SpiderErrorCode.PERMISSION_DENIED, {
                filePath: '/secret.ts',
            });
            expect(error.toUserMessage()).toBe('Permission denied: /secret.ts');
        });

        it('should return friendly message for PARSE_ERROR', () => {
            const error = new SpiderError('', SpiderErrorCode.PARSE_ERROR, {
                filePath: '/broken.ts',
            });
            expect(error.toUserMessage()).toBe('Failed to parse: /broken.ts');
        });

        it('should return friendly message for TIMEOUT', () => {
            const error = new SpiderError('', SpiderErrorCode.TIMEOUT);
            expect(error.toUserMessage()).toBe('Operation timed out');
        });

        it('should return friendly message for CIRCULAR_DEPENDENCY', () => {
            const error = new SpiderError('', SpiderErrorCode.CIRCULAR_DEPENDENCY);
            expect(error.toUserMessage()).toBe('Circular dependency detected');
        });

        it('should return original message for UNKNOWN', () => {
            const error = new SpiderError('Custom error message', SpiderErrorCode.UNKNOWN);
            expect(error.toUserMessage()).toBe('Custom error message');
        });

        it('should handle missing filePath gracefully', () => {
            const error = new SpiderError('', SpiderErrorCode.FILE_NOT_FOUND);
            expect(error.toUserMessage()).toBe('File not found: unknown');
        });
    });

    describe('toJSON', () => {
        it('should serialize error to JSON', () => {
            const error = new SpiderError('Test message', SpiderErrorCode.PARSE_ERROR, {
                filePath: '/test.ts',
            });

            const json = error.toJSON();

            expect(json.name).toBe('SpiderError');
            expect(json.code).toBe(SpiderErrorCode.PARSE_ERROR);
            expect(json.message).toBe('Test message');
            expect(json.filePath).toBe('/test.ts');
            expect(json.timestamp).toBe(error.timestamp);
            expect(typeof json.stack).toBe('string');
        });
    });

    describe('SpiderErrorCode enum', () => {
        it('should have all expected codes', () => {
            expect(SpiderErrorCode.FILE_NOT_FOUND).toBe('FILE_NOT_FOUND');
            expect(SpiderErrorCode.PERMISSION_DENIED).toBe('PERMISSION_DENIED');
            expect(SpiderErrorCode.FILE_TOO_LARGE).toBe('FILE_TOO_LARGE');
            expect(SpiderErrorCode.PARSE_ERROR).toBe('PARSE_ERROR');
            expect(SpiderErrorCode.RESOLUTION_FAILED).toBe('RESOLUTION_FAILED');
            expect(SpiderErrorCode.TIMEOUT).toBe('TIMEOUT');
            expect(SpiderErrorCode.CIRCULAR_DEPENDENCY).toBe('CIRCULAR_DEPENDENCY');
            expect(SpiderErrorCode.UNKNOWN).toBe('UNKNOWN');
        });
    });
});
