import fs from 'node:fs';
import path from 'node:path';
import type { ProjectMetadataFreshness, VerseProjectMetadata, VerseProjectPackage } from '../types.js';

interface ProjectDescriptor {
  title?: unknown;
}

interface VProjectFile {
  packages?: unknown;
}

interface VProjectPackageRecord {
  desc?: {
    name?: unknown;
    dirPath?: unknown;
    settings?: {
      role?: unknown;
    };
  };
  readOnly?: unknown;
}

export interface ProjectDiscoveryOptions {
  environment?: NodeJS.ProcessEnv;
  savedVerseProjectRoot?: string;
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
}

function listFiles(root: string, predicate: (filePath: string) => boolean): string[] {
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];
  const visit = (directory: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(entryPath);
      else if (entry.isFile() && predicate(entryPath)) files.push(entryPath);
    }
  };
  visit(root);
  return files.sort((left, right) => left.localeCompare(right));
}

function pathKey(value: string): string {
  return path.resolve(value).replace(/[\\/]+$/, '').toLowerCase();
}

function pathsMatch(left: string, right: string): boolean {
  return pathKey(left) === pathKey(right);
}

function findWorkspaceFile(projectRoot: string, projectName: string): string | undefined {
  const preferred = path.join(projectRoot, `${projectName}.code-workspace`);
  if (fs.existsSync(preferred)) return preferred;
  try {
    const candidate = fs.readdirSync(projectRoot, { withFileTypes: true })
      .find(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.code-workspace'));
    return candidate ? path.join(projectRoot, candidate.name) : undefined;
  } catch {
    return undefined;
  }
}

function generatedRootCandidates(projectRoot: string, projectName: string, options: ProjectDiscoveryOptions): string[] {
  const explicit = options.savedVerseProjectRoot;
  if (explicit) return [path.resolve(explicit)];
  const localAppData = options.environment?.LOCALAPPDATA ?? process.env.LOCALAPPDATA;
  if (!localAppData) return [];
  const base = path.join(localAppData, 'UnrealEditorFortnite', 'Saved', 'VerseProject');
  const names = [...new Set([projectName, path.basename(projectRoot)])];
  return names.map(name => path.join(base, name));
}

function findVProject(generatedRoots: string[], contentPath: string): { filePath?: string; generatedRoot?: string } {
  for (const generatedRoot of generatedRoots) {
    const vprojectDirectory = path.join(generatedRoot, 'vproject');
    if (!fs.existsSync(vprojectDirectory)) continue;
    const candidates = listFiles(vprojectDirectory, filePath => filePath.toLowerCase().endsWith('.vproject'));
    for (const candidate of candidates) {
      try {
        const value = readJson(candidate) as VProjectFile;
        const packages = Array.isArray(value.packages) ? value.packages as VProjectPackageRecord[] : [];
        if (packages.some(pkg => typeof pkg?.desc?.dirPath === 'string' && pathsMatch(pkg.desc.dirPath, contentPath))) {
          return { filePath: candidate, generatedRoot };
        }
      } catch {
        // Keep looking; a stale or partially-written generated record is not authoritative.
      }
    }
    const preferred = listFiles(vprojectDirectory, filePath => filePath.toLowerCase().endsWith('.vproject'))[0];
    if (preferred) return { filePath: preferred, generatedRoot };
  }
  return {};
}

function parsePackages(vprojectPath: string): VerseProjectPackage[] {
  const value = readJson(vprojectPath) as VProjectFile;
  if (!Array.isArray(value.packages)) return [];
  return value.packages.flatMap(packageValue => {
    const packageRecord = packageValue as VProjectPackageRecord;
    const name = typeof packageRecord.desc?.name === 'string' ? packageRecord.desc.name : undefined;
    if (!name) return [];
    const directory = typeof packageRecord.desc?.dirPath === 'string' ? packageRecord.desc.dirPath : undefined;
    return [{
      name,
      directory,
      role: typeof packageRecord.desc?.settings?.role === 'string' ? packageRecord.desc.settings.role : undefined,
      readOnly: typeof packageRecord.readOnly === 'boolean' ? packageRecord.readOnly : undefined,
      digestFiles: directory ? listFiles(directory, filePath => filePath.toLowerCase().endsWith('.digest.verse')) : [],
    } satisfies VerseProjectPackage];
  });
}

function metadataFreshness(vprojectPath: string, sourceFiles: string[]): ProjectMetadataFreshness {
  try {
    const vprojectMtime = fs.statSync(vprojectPath).mtimeMs;
    const sourceMtimes = sourceFiles.map(filePath => fs.statSync(filePath).mtimeMs);
    return sourceMtimes.some(mtime => mtime > vprojectMtime) ? 'possibly-stale' : 'fresh-by-mtime';
  } catch {
    return 'unknown';
  }
}

function failedMetadata(
  descriptorPath: string,
  projectRoot: string,
  contentPath: string,
  projectName: string,
  workspaceFilePath: string | undefined,
  error: string,
): VerseProjectMetadata {
  return {
    projectName,
    descriptorPath,
    projectRoot,
    contentPath,
    workspaceFilePath,
    packages: [],
    sourceFiles: listFiles(contentPath, filePath => filePath.toLowerCase().endsWith('.verse')),
    metadataAvailable: false,
    error,
  };
}

/** Discover a UEFN descriptor, generated .vproject, source files, and package digests without mutating the project. */
export function discoverVerseProjectMetadata(projectPath: string, options: ProjectDiscoveryOptions = {}): VerseProjectMetadata {
  const descriptorPath = path.resolve(projectPath);
  const projectRoot = path.dirname(descriptorPath);
  const projectName = path.basename(descriptorPath, path.extname(descriptorPath));
  const contentPath = path.join(projectRoot, 'Content');
  const workspaceFilePath = findWorkspaceFile(projectRoot, projectName);

  if (!fs.existsSync(descriptorPath)) {
    return failedMetadata(descriptorPath, projectRoot, contentPath, projectName, workspaceFilePath, 'The .uefnproject file does not exist.');
  }
  try {
    const descriptor = readJson(descriptorPath) as ProjectDescriptor;
    const descriptorName = typeof descriptor.title === 'string' && descriptor.title.trim() ? descriptor.title.trim() : projectName;
    const generated = findVProject(generatedRootCandidates(projectRoot, descriptorName, options), contentPath);
    if (!generated.filePath) {
      return failedMetadata(descriptorPath, projectRoot, contentPath, descriptorName, workspaceFilePath, 'UEFN generated .vproject metadata was not found for this project.');
    }
    const packages = parsePackages(generated.filePath);
    if (!packages.some(pkg => typeof pkg.directory === 'string' && pathsMatch(pkg.directory, contentPath))) {
      return failedMetadata(descriptorPath, projectRoot, contentPath, descriptorName, workspaceFilePath, 'The generated .vproject does not describe this project Content directory.');
    }
    const sourceFiles = listFiles(contentPath, filePath => filePath.toLowerCase().endsWith('.verse'));
    return {
      projectName: descriptorName,
      descriptorPath,
      projectRoot,
      contentPath,
      workspaceFilePath,
      vprojectPath: generated.filePath,
      generatedRoot: generated.generatedRoot,
      packages,
      sourceFiles,
      metadataAvailable: true,
      metadataFreshness: metadataFreshness(generated.filePath, sourceFiles),
    };
  } catch (error) {
    return failedMetadata(
      descriptorPath,
      projectRoot,
      contentPath,
      projectName,
      workspaceFilePath,
      error instanceof Error ? `Could not read project metadata: ${error.message}` : 'Could not read project metadata.',
    );
  }
}

export function workspaceFoldersForProject(metadata: VerseProjectMetadata): string[] {
  if (metadata.workspaceFilePath) {
    try {
      const value = readJson(metadata.workspaceFilePath) as { folders?: unknown };
      if (Array.isArray(value.folders)) {
        const workspacePaths = value.folders.flatMap(folder => {
          if (!folder || typeof folder !== 'object') return [];
          const folderPath = (folder as { path?: unknown }).path;
          if (typeof folderPath !== 'string' || !folderPath.trim()) return [];
          const resolved = path.isAbsolute(folderPath) ? folderPath : path.resolve(path.dirname(metadata.workspaceFilePath as string), folderPath);
          return [resolved];
        });
        const existing = [...new Set(workspacePaths.filter(filePath => fs.existsSync(filePath)))];
        if (existing.length > 0) return existing;
      }
    } catch {
      // Fall back to the package topology when the generated workspace file is stale or malformed.
    }
  }
  const paths = [metadata.contentPath];
  if (metadata.packages.length > 0) {
    for (const packageInfo of metadata.packages) if (packageInfo.directory) paths.push(packageInfo.directory);
  }
  if (metadata.vprojectPath) paths.push(path.dirname(metadata.vprojectPath));
  return [...new Set(paths.filter(filePath => fs.existsSync(filePath)))];
}
