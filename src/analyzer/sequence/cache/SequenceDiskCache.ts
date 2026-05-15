import * as fs from "node:fs";
import * as path from "node:path";

import type { SequenceModel } from "@/analyzer/sequence/types";

const CACHE_DIR_SEGMENTS = [".graph-it", "sequence-cache"] as const;
const CACHE_KEY_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;

export class SequenceDiskCache {
  private readonly cacheDirPath: string;

  constructor(private readonly workspaceRoot: string) {
    this.cacheDirPath = path.join(this.workspaceRoot, ...CACHE_DIR_SEGMENTS);
  }

  get cacheDir(): string {
    return this.cacheDirPath;
  }

  read(key: string): SequenceModel | undefined {
    const filePath = this.getCacheFilePath(key);
    if (!filePath) {
      return undefined;
    }

    try {
      const content = fs.readFileSync(filePath, "utf8");
      return JSON.parse(content) as SequenceModel;
    } catch {
      return undefined;
    }
  }

  write(key: string, model: SequenceModel): void {
    const filePath = this.getCacheFilePath(key);
    if (!filePath) {
      return;
    }

    fs.mkdirSync(this.cacheDirPath, { recursive: true });

    const tempPath = `${filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(model), "utf8");
    fs.renameSync(tempPath, filePath);
  }

  delete(key: string): boolean {
    const filePath = this.getCacheFilePath(key);
    if (!filePath) {
      return false;
    }

    try {
      fs.unlinkSync(filePath);
      return true;
    } catch {
      return false;
    }
  }

  clear(): void {
    fs.rmSync(this.cacheDirPath, { recursive: true, force: true });
  }

  private getCacheFilePath(key: string): string | undefined {
    if (!CACHE_KEY_PATTERN.test(key)) {
      return undefined;
    }

    return path.join(this.cacheDirPath, `${key}.json`);
  }
}
