/**
 * Vitest coverage for the read-only `IFileSystem` shim (D-08). Exercises
 * against a real `InMemoryFs` fixture — no Jenkins client/network involved.
 */

import { type IFileSystem, InMemoryFs } from "just-bash";
import { describe, expect, it } from "vitest";
import { ReadOnlyFsError, ReadOnlyJenkinsFs } from "./readonly-fs.js";

/** Small populated InMemoryFs fixture reused across tests. */
function buildFixtureFs(): InMemoryFs {
  const fs = new InMemoryFs();
  fs.writeFileSync("/jobs/team-a/api.json", '{"name":"team-a"}');
  return fs;
}

describe("ReadOnlyJenkinsFs", () => {
  it("Test 3: structurally satisfies the just-bash IFileSystem type (compile-time)", () => {
    const inner = buildFixtureFs();
    // This assignment is the load-bearing compile-time assertion: if
    // ReadOnlyJenkinsFs ever drifts from the installed IFileSystem shape,
    // `npx tsc --noEmit` fails here.
    const roFs: IFileSystem = new ReadOnlyJenkinsFs(inner);
    expect(roFs).toBeInstanceOf(ReadOnlyJenkinsFs);
  });

  describe("Test 1: read delegation", () => {
    it("readFile/readdir/stat/exists and every other read method delegate to the wrapped InMemoryFs", async () => {
      const inner = buildFixtureFs();
      const roFs = new ReadOnlyJenkinsFs(inner);

      expect(await roFs.readFile("/jobs/team-a/api.json")).toBe(
        await inner.readFile("/jobs/team-a/api.json"),
      );
      expect(await roFs.readdir("/jobs/team-a")).toEqual(await inner.readdir("/jobs/team-a"));
      expect(await roFs.stat("/jobs/team-a/api.json")).toEqual(
        await inner.stat("/jobs/team-a/api.json"),
      );
      expect(await roFs.exists("/jobs/team-a/api.json")).toBe(true);
      expect(await roFs.exists("/does-not-exist")).toBe(false);
      expect(await roFs.lstat("/jobs/team-a/api.json")).toEqual(
        await inner.lstat("/jobs/team-a/api.json"),
      );
      expect(await roFs.readFileBuffer("/jobs/team-a/api.json")).toEqual(
        await inner.readFileBuffer("/jobs/team-a/api.json"),
      );
      expect(await roFs.readFileBytes("/jobs/team-a/api.json")).toEqual(
        await inner.readFileBytes("/jobs/team-a/api.json"),
      );
      expect(await roFs.readdirWithFileTypes("/jobs/team-a")).toEqual(
        await inner.readdirWithFileTypes("/jobs/team-a"),
      );
      expect(roFs.resolvePath("/jobs", "team-a")).toBe(inner.resolvePath("/jobs", "team-a"));
      expect(roFs.getAllPaths()).toEqual(inner.getAllPaths());
    });

    it("readlink/realpath delegate to the wrapped InMemoryFs for a symlinked path", async () => {
      const inner = buildFixtureFs();
      await inner.symlink("/jobs/team-a/api.json", "/jobs/team-a/alias.json");
      const roFs = new ReadOnlyJenkinsFs(inner);

      expect(await roFs.readlink("/jobs/team-a/alias.json")).toBe(
        await inner.readlink("/jobs/team-a/alias.json"),
      );
      expect(await roFs.realpath("/jobs/team-a/alias.json")).toBe(
        await inner.realpath("/jobs/team-a/alias.json"),
      );
    });
  });

  describe("Test 2: write rejection (D-08)", () => {
    const WRITE_OPS: Array<[string, (fs: ReadOnlyJenkinsFs) => Promise<unknown>]> = [
      ["writeFile", (fs) => fs.writeFile("/x", "y")],
      ["appendFile", (fs) => fs.appendFile("/x", "y")],
      ["mkdir", (fs) => fs.mkdir("/new-dir")],
      ["rm", (fs) => fs.rm("/jobs")],
      ["cp", (fs) => fs.cp("/jobs/team-a/api.json", "/jobs/team-a/copy.json")],
      ["mv", (fs) => fs.mv("/jobs/team-a/api.json", "/jobs/team-a/moved.json")],
      ["chmod", (fs) => fs.chmod("/jobs/team-a/api.json", 0o644)],
      ["symlink", (fs) => fs.symlink("/jobs/team-a/api.json", "/jobs/team-a/alias.json")],
      ["link", (fs) => fs.link("/jobs/team-a/api.json", "/jobs/team-a/hardlink.json")],
      ["utimes", (fs) => fs.utimes("/jobs/team-a/api.json", new Date(), new Date())],
    ];

    it.each(
      WRITE_OPS,
    )("%s throws a ReadOnlyFsError whose message names the operation and contains 'read-only'", async (op, invoke) => {
      const roFs = new ReadOnlyJenkinsFs(buildFixtureFs());

      let caught: unknown;
      try {
        await invoke(roFs);
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ReadOnlyFsError);
      const roErr = caught as ReadOnlyFsError;
      expect(roErr.name).toBe("ReadOnlyFsError");
      expect(roErr.operation).toBe(op);
      expect(roErr.message).toMatch(/read-only/i);
      expect(roErr.message).toContain(op);
    });
  });
});
