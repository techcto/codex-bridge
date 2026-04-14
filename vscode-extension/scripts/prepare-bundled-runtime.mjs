import { copyFile, mkdir } from 'node:fs/promises';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';

function readArg(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1 || index + 1 >= process.argv.length) {
    return '';
  }

  return process.argv[index + 1];
}

async function main() {
  const source = readArg('--source');
  const platform = readArg('--platform') || `${process.platform}-${process.arch}`;

  if (!source) {
    throw new Error('Usage: npm run prepare:bundled-runtime -- --source /absolute/path/to/codex[.exe] [--platform win32-x64]');
  }

  const executableName = platform.startsWith('win32-') ? 'codex.exe' : 'codex';
  const targetDir = new URL(`../bundled-runtime/${platform}/`, import.meta.url);
  const targetFile = new URL(`../bundled-runtime/${platform}/${executableName}`, import.meta.url);

  await mkdir(fileURLToPath(targetDir), { recursive: true });
  await copyFile(source, fileURLToPath(targetFile));

  console.log(`Copied ${basename(source)} to bundled-runtime/${platform}/${executableName}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
