import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../logger.js";

describe("logger", () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
    vi.unstubAllEnvs();
  });

  it("writes an info line to stderr and never touches stdout", () => {
    logger.info("hello");

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stdoutSpy).toHaveBeenCalledTimes(0);

    const line = stderrSpy.mock.calls[0][0] as string;
    expect(line.endsWith("\n")).toBe(true);

    const parsed = JSON.parse(line);
    expect(parsed.level).toBe("info");
    expect(parsed.msg).toBe("hello");
    expect(typeof parsed.ts).toBe("string");
  });

  it("includes a meta object in the serialized line", () => {
    logger.info("with meta", { requestId: "abc123" });

    const line = stderrSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(line);
    expect(parsed.requestId).toBe("abc123");
  });

  it("suppresses a debug call at the default (info) log level", () => {
    logger.debug("should not appear");

    expect(stderrSpy).toHaveBeenCalledTimes(0);
    expect(stdoutSpy).toHaveBeenCalledTimes(0);
  });

  it("writes warn and error lines at the default log level", () => {
    logger.warn("warn line");
    logger.error("error line");

    expect(stderrSpy).toHaveBeenCalledTimes(2);
    expect(stdoutSpy).toHaveBeenCalledTimes(0);

    const warnParsed = JSON.parse(stderrSpy.mock.calls[0][0] as string);
    const errorParsed = JSON.parse(stderrSpy.mock.calls[1][0] as string);
    expect(warnParsed.level).toBe("warn");
    expect(errorParsed.level).toBe("error");
  });
});
