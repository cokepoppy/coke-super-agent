import { posix } from 'node:path';

export interface TaskArtifact {
  path: string;
  name: string;
  sizeBytes: number;
  modifiedAt: string | null;
  mediaType: string;
  previewable: boolean;
}

export interface ArtifactFilesystem {
  list(path: string): Promise<Array<Record<string, unknown>>>;
}

const maxArtifacts = 200;
const maxDepth = 5;
const artifactTypes: Record<string, string> = {
  '.html': 'text/html', '.htm': 'text/html', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf',
};
const previewTypes = new Set(['text/html', 'text/plain', 'text/markdown', 'text/csv', 'application/json', 'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf']);

function safeEntryName(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value === '.' || value === '..' || value.startsWith('.') || /[\/\\\0]/.test(value)) return null;
  return value;
}

function sizeInBytes(value: unknown): number | null {
  const size = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(size) && size >= 0 ? size : null;
}

function modifiedTime(value: unknown): string | null {
  if (typeof value === 'string' && value) return value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

export async function listTaskArtifacts(filesystem: ArtifactFilesystem, taskRoot: string): Promise<TaskArtifact[]> {
  const artifacts: TaskArtifact[] = [];

  async function visit(directory: string, relativeDirectory: string, depth: number): Promise<void> {
    if (depth > maxDepth || artifacts.length >= maxArtifacts) return;
    const entries = await filesystem.list(directory);
    for (const entry of entries) {
      if (artifacts.length >= maxArtifacts) break;
      const name = safeEntryName(entry.name);
      if (!name) continue;
      const type = String(entry.type || '').toUpperCase();
      // Check links before directories so a directory symlink is never walked.
      if (type.includes('SYMLINK') || type.includes('LINK')) continue;
      const isDirectory = type.includes('DIRECTORY') || entry.isDirectory === true || entry.isDir === true;
      const relativePath = relativeDirectory ? posix.join(relativeDirectory, name) : name;
      if (isDirectory) {
        if (depth < maxDepth) await visit(posix.join(directory, name), relativePath, depth + 1);
        continue;
      }
      const sizeBytes = sizeInBytes(entry.size);
      const isFile = !type.includes('SYMLINK') && (type.includes('FILE') || entry.isFile === true || (sizeBytes !== null && !type.includes('LINK')));
      if (!isFile) continue;
      const mediaType = artifactTypes[posix.extname(name).toLowerCase()] || 'application/octet-stream';
      artifacts.push({ path: relativePath, name, sizeBytes: sizeBytes ?? 0, modifiedAt: modifiedTime(entry.modifiedTime), mediaType, previewable: previewTypes.has(mediaType) });
    }
  }

  await visit(taskRoot, '', 0);
  return artifacts.sort((left, right) => left.path.localeCompare(right.path));
}

export function taskArtifactAbsolutePath(taskRoot: string, relativePath: string): string | null {
  if (!relativePath || relativePath.startsWith('/') || relativePath.includes('\\') || relativePath.includes('\0')) return null;
  const parts = relativePath.split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.startsWith('.'))) return null;
  const absolute = posix.join(taskRoot, ...parts);
  return absolute.startsWith(taskRoot + '/') ? absolute : null;
}
