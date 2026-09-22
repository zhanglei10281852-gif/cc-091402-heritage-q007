import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function freshDataDir(context, label) {
  const dir = mkdtempSync(join(tmpdir(), `heritage-${label}-`));
  context.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
