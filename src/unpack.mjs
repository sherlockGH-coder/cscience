import { readFile, mkdir, writeFile, copyFile, stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import lief from 'node-lief';

const BUN_TRAILER = Buffer.from('\n---- Bun! ----\n');
const OFFSETS_SIZE = 32;
const MODULE_V1 = 36;
const MODULE_V2 = 52;
const MODULE_VERSIONS = [
  { name: 'v2', size: MODULE_V2 },
  { name: 'v1', size: MODULE_V1 },
];
const LOADERS = [
  'jsx','js','ts','tsx','css','file','json','jsonc',
  'toml','wasm','napi','base64','dataurl','text',
  'bunsh','sqlite','sqlite_embedded','html','yaml',
];
const ENCODINGS = ['binary','latin1','utf8'];
const FORMATS  = ['none','esm','cjs'];
const BASE_PATH = '/$bunfs/';
const BASE_PUBLIC = 'root/';

function detectSectionPrefix(data) {
  if (data.length >= 8) {
    const s = Number(data.readBigUInt64LE(0));
    if (s + 8 === data.length) return { prefixSize: 8, dataSize: s };
  }
  if (data.length >= 4) {
    const s = data.readUInt32LE(0);
    if (s + 4 === data.length) return { prefixSize: 4, dataSize: s };
  }
  return null;
}

function detectModuleStruct(len) {
  for (const v of MODULE_VERSIONS)
    if (len > 0 && len % v.size === 0)
      return { version: v.name, size: v.size, count: len / v.size };
  return null;
}

function parseOffsets(buf, pos) {
  return {
    byteCount:    Number(buf.readBigUInt64LE(pos)),
    modulesPtr:   { offset: buf.readUInt32LE(pos + 8), length: buf.readUInt32LE(pos + 12) },
    entryPointId: buf.readUInt32LE(pos + 16),
  };
}

function parseModuleEntry(bunData, offset, entrySize) {
  const readSP = (o) => ({ offset: bunData.readUInt32LE(o), length: bunData.readUInt32LE(o + 4) });
  const extract = (sp) => sp.length > 0 ? bunData.subarray(sp.offset, sp.offset + sp.length) : null;
  const namePtr      = readSP(offset);
  const contentsPtr  = readSP(offset + 8);
  const sourcemapPtr = readSP(offset + 16);
  const metaOffset   = entrySize === MODULE_V2 ? offset + 48 : offset + 32;
  return {
    name:      extract(namePtr)?.toString('utf8') ?? '',
    contents:  extract(contentsPtr),
    sourcemap: extract(sourcemapPtr),
    encoding:  ENCODINGS[bunData[metaOffset]]     ?? 'binary',
    loader:    LOADERS[bunData[metaOffset + 1]]    ?? 'unknown',
    format:    FORMATS[bunData[metaOffset + 2]]    ?? 'none',
    side:      bunData[metaOffset + 3] === 0 ? 'server' : 'client',
  };
}

function findBunSection(binaryPath) {
  lief.logging.disable();
  const raw = readFileSync(binaryPath);
  const magic = raw.readUInt32LE(0);

  if (magic === 0xFEEDFACF || magic === 0xCEFAEDFE) {
    const fat = lief.MachO.parse(binaryPath);
    const bin = fat.at(0);
    const seg = bin.getSegment('__BUN');
    if (!seg) throw Error('MachO: __BUN segment not found');
    const sec = seg.getSection('__bun');
    if (!sec) throw Error('MachO: __bun section not found');
    return { content: Buffer.from(sec.content), format: 'MachO' };
  }

  if (raw.readUInt32BE(0) === 0x7F454C46) {
    const bin = lief.parse(binaryPath);
    const sec = bin.getSection('.bun');
    if (!sec) throw Error('ELF: .bun section not found');
    return { content: Buffer.from(sec.content), format: 'ELF' };
  }

  if (raw.readUInt16LE(0) === 0x5A4D) {
    const bin = lief.parse(binaryPath);
    const sec = bin.getSection('.bun');
    if (!sec) throw Error('PE: .bun section not found');
    return { content: Buffer.from(sec.content), format: 'PE' };
  }

  throw Error('Unsupported binary format');
}

function parseBunData(sectionContent) {
  const prefix = detectSectionPrefix(sectionContent);
  if (!prefix) throw Error('Section size prefix not recognized');
  const bunData = sectionContent.subarray(prefix.prefixSize, prefix.prefixSize + prefix.dataSize);
  if (bunData.length < OFFSETS_SIZE + BUN_TRAILER.length) throw Error('Bun data too small');
  const trailer = bunData.subarray(bunData.length - BUN_TRAILER.length);
  if (!trailer.equals(BUN_TRAILER)) throw Error('Bun trailer mismatch');
  const offsetsStart = bunData.length - OFFSETS_SIZE - BUN_TRAILER.length;
  return { prefixSize: prefix.prefixSize, offsets: parseOffsets(bunData, offsetsStart), bunData };
}

function parseModules(offsets, bunData) {
  const raw = bunData.subarray(offsets.modulesPtr.offset, offsets.modulesPtr.offset + offsets.modulesPtr.length);
  const info = detectModuleStruct(raw.length);
  if (!info) throw Error(`Module struct unrecognized (${raw.length} bytes)`);
  const modules = [];
  for (let i = 0; i < info.count; i++)
    modules.push(parseModuleEntry(bunData, offsets.modulesPtr.offset + i * info.size, info.size));
  return { version: info.version, structSize: info.size, modules };
}

const WORKER_SYMLINKS = [
  { target: 'sqliteWorkerEntry.ts', linkTo: 'sqliteWorkerEntry.js' },
  { target: 'orgsImportWorker.ts',  linkTo: 'orgsImportWorker.js' },
  { target: 'sandbox/gitScanWorker.ts', linkTo: 'gitScanWorker.js' },
];

export async function unpack(binaryPath, outputDir) {
  console.log(`[unpack] Binary: ${binaryPath}`);
  const { content, format } = findBunSection(binaryPath);
  console.log(`[unpack] Format: ${format}, __BUN section: ${(content.length / 1024 / 1024).toFixed(1)} MB`);

  const { prefixSize, offsets, bunData } = parseBunData(content);
  const { version, structSize, modules } = parseModules(offsets, bunData);
  console.log(`[unpack] Module struct: ${version} (${structSize}B/entry), ${modules.length} modules`);
  console.log(`[unpack] Entry point: #${offsets.entryPointId} -> ${modules[offsets.entryPointId]?.name ?? '?'}`);

  await mkdir(outputDir, { recursive: true });
  let assetsTarPath = null;

  for (let i = 0; i < modules.length; i++) {
    const mod = modules[i];
    let name = mod.name;
    if (name.startsWith(BASE_PATH)) name = name.slice(BASE_PATH.length);
    if (name.startsWith(BASE_PUBLIC)) name = name.slice(BASE_PUBLIC.length);
    if (i === offsets.entryPointId) {
      const dot = name.lastIndexOf('.');
      name = (dot > 0 ? name.slice(0, dot) : name) + '.' + mod.loader;
    }
    if (!mod.contents?.length) { console.log(`  [skip] #${i} ${name}`); continue; }

    const outPath = join(outputDir, name);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, mod.contents);
    const kb = (mod.contents.length / 1024).toFixed(1);
    console.log(`  [dump] #${i} ${name} (${kb} KB, ${mod.loader}/${mod.format})`);

    if (mod.loader === 'file' && name.includes('assets') && name.endsWith('.gz'))
      assetsTarPath = outPath;
  }

  if (assetsTarPath) {
    const assetsDir = join(outputDir, 'assets');
    console.log(`[unpack] Extracting assets -> ${assetsDir}`);
    await mkdir(assetsDir, { recursive: true });
    execFileSync('tar', ['xzf', assetsTarPath, '-C', assetsDir], { stdio: 'pipe' });
  }

  for (const { target, linkTo } of WORKER_SYMLINKS) {
    const destPath = join(outputDir, target);
    try { await stat(destPath); } catch {
      await mkdir(dirname(destPath), { recursive: true });
      await copyFile(join(outputDir, linkTo), destPath);
      console.log(`  [copy] ${target} <- ${linkTo}`);
    }
  }

  console.log(`[unpack] Done`);
  return { format, modules: modules.length, entryPointId: offsets.entryPointId };
}
