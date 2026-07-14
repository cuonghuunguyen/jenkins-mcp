/**
 * Read-only `IFileSystem` shim over the Jenkins-mirroring `InMemoryFs` (D-08).
 *
 * `ReadOnlyJenkinsFs` wraps a populated `InMemoryFs` (built by
 * `buildJenkinsVfs`, see `./vfs.js`) and delegates every read/non-mutating
 * method to it unchanged. Every write/mutation method instead rejects with a
 * `ReadOnlyFsError` naming the attempted operation — the sandbox can only
 * ever read the Jenkins mirror, never write to it (SAFE-01/02).
 *
 * This is defense-in-depth: the VFS's own lazy providers already only ever
 * call `client.get()` (never `client.post()`), so the real Jenkins-mutation
 * blast radius from this tool is already zero by construction (see
 * `vfs.ts`). This shim exists so an agent's `>` redirect or `rm`/`mkdir`
 * command against the ephemeral per-call VFS fails loudly and immediately,
 * rather than appearing to silently "succeed" against data that is about to
 * be discarded at the end of the call anyway (D-09).
 *
 * IMPORTANT (02-01-SUMMARY finding): every write method here MUST be
 * declared `async` and reject from inside the async function body — never a
 * bare synchronous `throw` in a non-async method. A synchronous throw from a
 * write method propagates out of `bash.exec()` itself as an unhandled
 * rejection (confirmed by direct experiment against just-bash@3.1.0) instead
 * of being caught internally and converted into a normal
 * `{ stdout, stderr, exitCode: 1 }` shell-error result. Declaring the
 * methods `async` fixes this for every direct command (`mkdir`, `rm`,
 * `touch`, `cp`, `mv`, ...); the `>` redirect path still requires the
 * `jenkins_bash` tool handler (`../tools/bash.js`) to wrap `bash.exec()` in
 * its own try/catch regardless (see that file).
 */

import type { IFileSystem, InMemoryFs } from "just-bash";

/**
 * Thrown by every write/mutation method on `ReadOnlyJenkinsFs`. Follows the
 * same "small named `Error` subclass" discipline as `JenkinsError`
 * (`./errors.js`): a clear `name`, a caller-identifiable `operation`, and a
 * message that always communicates the read-only-filesystem condition.
 */
export class ReadOnlyFsError extends Error {
  readonly operation: string;

  constructor(operation: string) {
    super(
      `Read-only file system: '${operation}' is not permitted. The Jenkins ` +
        "VFS mirror exposed by jenkins_bash is read-only — it can only be " +
        "read, never written to (D-08).",
    );
    this.name = "ReadOnlyFsError";
    this.operation = operation;
  }
}

/**
 * Read-only wrapper around an `InMemoryFs`. Reads delegate to `inner`
 * unchanged; every write method rejects with `ReadOnlyFsError`.
 */
export class ReadOnlyJenkinsFs implements IFileSystem {
  // ---- Reads: delegate unchanged to the wrapped InMemoryFs. Declared here
  // (typed, no initializer) and assigned in the constructor body — NOT as
  // field initializers referencing `this.inner`, because class-field
  // initializers run before a TS parameter-property assignment lands on
  // `this`, which would make `this.inner` undefined at binding time. ----

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

  constructor(inner: InMemoryFs) {
    this.readFile = inner.readFile.bind(inner);
    this.readFileBytes = inner.readFileBytes.bind(inner);
    this.readFileBuffer = inner.readFileBuffer.bind(inner);
    this.exists = inner.exists.bind(inner);
    this.stat = inner.stat.bind(inner);
    this.lstat = inner.lstat.bind(inner);
    this.readdir = inner.readdir.bind(inner);
    this.readdirWithFileTypes = inner.readdirWithFileTypes.bind(inner);
    this.resolvePath = inner.resolvePath.bind(inner);
    this.getAllPaths = inner.getAllPaths.bind(inner);
    this.readlink = inner.readlink.bind(inner);
    this.realpath = inner.realpath.bind(inner);
  }

  // ---- Writes: reject with ReadOnlyFsError. Every method below is `async`
  // and rejects from inside its own function body (never a bare synchronous
  // `throw`) — see the class-level doc comment for why this distinction is
  // load-bearing. ----

  writeFile: IFileSystem["writeFile"] = async () => this.denyWrite("writeFile");
  appendFile: IFileSystem["appendFile"] = async () => this.denyWrite("appendFile");
  mkdir: IFileSystem["mkdir"] = async () => this.denyWrite("mkdir");
  rm: IFileSystem["rm"] = async () => this.denyWrite("rm");
  cp: IFileSystem["cp"] = async () => this.denyWrite("cp");
  mv: IFileSystem["mv"] = async () => this.denyWrite("mv");
  chmod: IFileSystem["chmod"] = async () => this.denyWrite("chmod");
  symlink: IFileSystem["symlink"] = async () => this.denyWrite("symlink");
  link: IFileSystem["link"] = async () => this.denyWrite("link");
  utimes: IFileSystem["utimes"] = async () => this.denyWrite("utimes");

  private async denyWrite(operation: string): Promise<never> {
    throw new ReadOnlyFsError(operation);
  }
}
