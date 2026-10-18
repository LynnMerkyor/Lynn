declare module "proper-lockfile" {
  import type fs from "node:fs";
  interface LockOptions {
    realpath: boolean;
    stale: number;
    update: number;
    retries: { retries: number; minTimeout: number; maxTimeout: number; factor: number };
    fs: Omit<typeof fs, "rmdir"> & {
      rmdir(path: fs.PathLike, callback: fs.NoParamCallback): void;
    };
  }
  const lockfile: {
    lock(path: string, options: LockOptions): Promise<() => Promise<void>>;
  };
  export default lockfile;
}
