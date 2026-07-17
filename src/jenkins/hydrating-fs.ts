/**
 * Generic hydrate-on-access `IFileSystem` composition wrapper (LAZY-HYDRATION).
 *
 * `HydratingJenkinsFs` is storage/domain-agnostic: it owns no Jenkins or
 * network knowledge at all. It wraps an inner `InMemoryFs` and an injected
 * `hydrateDir` callback that populates a single VFS directory's immediate
 * children (all Jenkins/REST-fetch knowledge lives in that callback, see
 * `./vfs.js`). This class only decides WHEN to call `hydrateDir` before
 * delegating to `inner`:
 *
 * - `readdir`/`readdirWithFileTypes(P)`: hydrate `P` itself (force: true —
 *   we need P's own children, and a leaf/unknown dir a user explicitly lists
 *   should still be attempted).
 * - `stat`/`lstat`/`exists`/`readFile*(P)`: hydrate `dirname(P)` (P is
 *   registered as a side effect of hydrating its PARENT) — this is the
 *   mandatory read-path ancestor hydration that keeps a deep `cat` with no
 *   prior `ls` working.
 * - `resolvePath`/`getAllPaths` (sync) and `realpath`/`readlink` (async):
 *   pass straight through to `inner`, no hydration.
 * - Write methods: delegate straight to `inner`. They are unreachable in
 *   practice because `bash.ts` always wraps this class in `ReadOnlyJenkinsFs`
 *   first (which denies every write before it ever reaches here) — they
 *   exist only so this class structurally satisfies `IFileSystem` and so
 *   `ReadOnlyJenkinsFs`'s constructor `.bind()` calls succeed.
 *
 * A fired `AbortSignal.timeout` inside the injected `hydrateDir` propagates
 * out of these methods as a `JenkinsError` (see `errors.ts`'s TimeoutError
 * branch) — this class does not catch or wrap it.
 */

import type { IFileSystem, InMemoryFs } from "just-bash";

/** Options passed to the injected `hydrateDir` callback. */
export interface HydrateDirOptions {
  /** Attempt the fetch even if the directory is already known to be a leaf. */
  force?: boolean;
}

/**
 * Returns the substring of `path` before its last `/`, root-safe: a
 * top-level path's dirname resolves to something outside `/jobs` (so a
 * hydrate-ancestor walk naturally stops), and a root-level file's dirname is
 * the filesystem root.
 */
function dirname(path: string): string {
  const idx = path.lastIndexOf("/");
  if (idx <= 0) return "/";
  return path.slice(0, idx);
}

export class HydratingJenkinsFs implements IFileSystem {
  readFile: IFileSystem["readFile"];
  readFileBytes: NonNullable<IFileSystem["readFileBytes"]>;
  readFileBuffer: IFileSystem["readFileBuffer"];
  exists: IFileSystem["exists"];
  stat: IFileSystem["stat"];
  lstat: IFileSystem["lstat"];
  readdir: IFileSystem["readdir"];
  readdirWithFileTypes: NonNullable<IFileSystem["readdirWithFileTypes"]>;
  resolvePath: IFileSystem["resolvePath"];
  getAllPaths: IFileSystem["getAllPaths"];
  readlink: IFileSystem["readlink"];
  realpath: IFileSystem["realpath"];

  writeFile: IFileSystem["writeFile"];
  appendFile: IFileSystem["appendFile"];
  mkdir: IFileSystem["mkdir"];
  rm: IFileSystem["rm"];
  cp: IFileSystem["cp"];
  mv: IFileSystem["mv"];
  chmod: IFileSystem["chmod"];
  symlink: IFileSystem["symlink"];
  link: IFileSystem["link"];
  utimes: IFileSystem["utimes"];

  constructor(
    inner: InMemoryFs,
    hydrateDir: (vfsDir: string, opts?: HydrateDirOptions) => Promise<void>,
  ) {
    // Reads that need this path's own children hydrated first (force: true).
    this.readdir = async (path) => {
      await hydrateDir(path, { force: true });
      return inner.readdir(path);
    };
    this.readdirWithFileTypes = async (path) => {
      await hydrateDir(path, { force: true });
      return inner.readdirWithFileTypes(path);
    };

    // Reads that need this path registered by hydrating its PARENT
    // (mandatory ancestor hydration for a deep read with no prior `ls`).
    this.stat = async (path) => {
      await hydrateDir(dirname(path));
      return inner.stat(path);
    };
    this.lstat = async (path) => {
      await hydrateDir(dirname(path));
      return inner.lstat(path);
    };
    this.exists = async (path) => {
      await hydrateDir(dirname(path));
      return inner.exists(path);
    };
    this.readFile = async (path, options) => {
      await hydrateDir(dirname(path));
      return inner.readFile(path, options);
    };
    this.readFileBytes = async (path) => {
      await hydrateDir(dirname(path));
      return inner.readFileBytes(path);
    };
    this.readFileBuffer = async (path) => {
      await hydrateDir(dirname(path));
      return inner.readFileBuffer(path);
    };

    // Pass-through, no hydration.
    this.resolvePath = (base, path) => inner.resolvePath(base, path);
    this.getAllPaths = () => inner.getAllPaths();
    this.realpath = (path) => inner.realpath(path);
    this.readlink = (path) => inner.readlink(path);

    // Writes: delegate to inner unchanged. Unreachable behind
    // ReadOnlyJenkinsFs; present only to structurally satisfy IFileSystem.
    this.writeFile = (path, content, options) => inner.writeFile(path, content, options);
    this.appendFile = (path, content, options) => inner.appendFile(path, content, options);
    this.mkdir = (path, options) => inner.mkdir(path, options);
    this.rm = (path, options) => inner.rm(path, options);
    this.cp = (src, dest, options) => inner.cp(src, dest, options);
    this.mv = (src, dest) => inner.mv(src, dest);
    this.chmod = (path, mode) => inner.chmod(path, mode);
    this.symlink = (target, linkPath) => inner.symlink(target, linkPath);
    this.link = (existingPath, newPath) => inner.link(existingPath, newPath);
    this.utimes = (path, atime, mtime) => inner.utimes(path, atime, mtime);
  }
}
