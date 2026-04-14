import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const bundledRuntimeRoot = new URL('../bundled-runtime/', import.meta.url);
const bundledRuntimePath = fileURLToPath(bundledRuntimeRoot);

async function main() {
  await mkdir(bundledRuntimeRoot, { recursive: true });

  const entries = await readdir(bundledRuntimeRoot, { withFileTypes: true });
  const runtimes = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const runtimeDir = join(bundledRuntimePath, entry.name);
    const executableName = entry.name.startsWith('win32-') ? 'codex.exe' : 'codex';
    const executablePath = join(runtimeDir, executableName);

    try {
      const details = await stat(executablePath);
      runtimes.push({
        platform: entry.name,
        executable: `bundled-runtime/${entry.name}/${executableName}`,
        size: details.size,
      });
    } catch (error) {
      continue;
    }
  }

  const manifest = {
    generated_at: new Date().toISOString(),
    runtimes,
  };

  await writeFile(new URL('../bundled-runtime/manifest.json', import.meta.url), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
