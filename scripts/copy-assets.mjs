import { existsSync, mkdirSync, cpSync } from 'node:fs';
import { dirname } from 'node:path';
import { execSync } from 'node:child_process';

const files = execSync("find src -type f -name '*.md'", { encoding: 'utf8' })
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean);

for (const srcPath of files) {
  const distPath = srcPath.replace(/^src\//, 'dist/');
  mkdirSync(dirname(distPath), { recursive: true });
  cpSync(srcPath, distPath);
}

const uiSourceDir = 'src/viz/ui/dist';
const uiDistDir = 'dist/viz/ui/dist';
if (existsSync(uiSourceDir)) {
  mkdirSync(dirname(uiDistDir), { recursive: true });
  cpSync(uiSourceDir, uiDistDir, { recursive: true });
}
