import { describe, it, expect } from "vitest";
import { ExitCode, CliError, classifyError } from "@/cli/errors";

describe("CliError", () => {
  it("creates error with correct exit code", () => {
    const err = new CliError("test message", ExitCode.GENERAL_ERROR);
    expect(err.message).toBe("test message");
    expect(err.exitCode).toBe(1);
    expect(err.name).toBe("CliError");
    expect(err).toBeInstanceOf(Error);
  });

  it("has correct exit codes", () => {
    expect(ExitCode.SUCCESS).toBe(0);
    expect(ExitCode.GENERAL_ERROR).toBe(1);
    expect(ExitCode.AMBIGUOUS_SYMBOL).toBe(2);
    expect(ExitCode.WORKSPACE_NOT_FOUND).toBe(3);
    expect(ExitCode.UNSUPPORTED_FORMAT).toBe(4);
    expect(ExitCode.SECURITY_VIOLATION).toBe(5);
  });
});

describe("classifyError", () => {
  it("returns CliError fields directly", () => {
    const err = new CliError("cli error", ExitCode.WORKSPACE_NOT_FOUND);
    const result = classifyError(err);
    expect(result.message).toBe("cli error");
    expect(result.exitCode).toBe(ExitCode.WORKSPACE_NOT_FOUND);
  });

  it("classifies path traversal as security violation", () => {
    const result = classifyError(new Error("Path traversal detected"));
    expect(result.exitCode).toBe(ExitCode.SECURITY_VIOLATION);
  });

  it("classifies outside workspace as security violation", () => {
    const result = classifyError(new Error("path is outside workspace"));
    expect(result.exitCode).toBe(ExitCode.SECURITY_VIOLATION);
  });

  it("classifies not initialized as workspace not found", () => {
    const result = classifyError(new Error("Worker not initialized"));
    expect(result.exitCode).toBe(ExitCode.WORKSPACE_NOT_FOUND);
  });

  it("classifies unknown errors as general error", () => {
    const result = classifyError(new Error("something random"));
    expect(result.exitCode).toBe(ExitCode.GENERAL_ERROR);
    expect(result.message).toBe("something random");
  });

  it("handles non-Error values", () => {
    const result = classifyError("plain string error");
    expect(result.exitCode).toBe(ExitCode.GENERAL_ERROR);
    expect(result.message).toBe("plain string error");
  });
});
