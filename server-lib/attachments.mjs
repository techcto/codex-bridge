import { join, extname } from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

export function sanitizeAttachments(attachments) {
  if (!Array.isArray(attachments)) {
    return [];
  }

  return attachments
    .map((attachment) => ({
      name: String(attachment?.name || '').trim(),
      mime_type: String(attachment?.mime_type || attachment?.mimeType || '').trim(),
      data_url: String(attachment?.data_url || attachment?.dataUrl || '').trim(),
    }))
    .filter((attachment) => attachment.data_url !== '');
}

export function inferImageExtension(mimeType = '') {
  const normalized = String(mimeType || '').trim().toLowerCase();
  if (normalized === 'image/jpeg') return '.jpg';
  if (normalized === 'image/png') return '.png';
  if (normalized === 'image/webp') return '.webp';
  if (normalized === 'image/gif') return '.gif';
  return '';
}

export async function materializeImageAttachments(attachments = [], bridgeTempRoot) {
  if (!attachments.length) {
    return [];
  }

  await mkdir(bridgeTempRoot, { recursive: true });
  const createdPaths = [];
  for (const attachment of attachments) {
    const dataUrl = String(attachment?.data_url || '').trim();
    const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
    if (!match) {
      continue;
    }

    const mimeType = String(match[1] || '').trim();
    if (!mimeType.startsWith('image/')) {
      continue;
    }

    const bytes = Buffer.from(match[2], 'base64');
    const originalName = String(attachment?.name || '').trim();
    const originalExtension = extname(originalName);
    const extension = originalExtension || inferImageExtension(mimeType) || '.img';
    const targetPath = join(bridgeTempRoot, `${Date.now()}-${randomUUID()}${extension}`);
    await writeFile(targetPath, bytes);
    createdPaths.push(targetPath);
  }

  return createdPaths;
}

export async function cleanupTempFiles(paths = []) {
  await Promise.all(paths.map(async (filePath) => {
    if (!filePath) {
      return;
    }

    try {
      await rm(filePath, { force: true });
    } catch (_error) {}
  }));
}
