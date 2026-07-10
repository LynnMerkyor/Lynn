import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const root = path.resolve(process.cwd(), 'desktop/src/react');
const sourceExtensions = ['.ts', '.tsx'];

function collectSourceFiles(directory, files = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__') collectSourceFiles(fullPath, files);
      continue;
    }
    if (!sourceExtensions.includes(path.extname(entry.name))) continue;
    if (/\.(?:test|spec)\.[^.]+$/u.test(entry.name)) continue;
    files.push(fullPath);
  }
  return files;
}

function resolveLocalImport(importer, specifier, knownFiles) {
  if (!specifier.startsWith('.')) return null;
  let base = path.resolve(path.dirname(importer), specifier);
  if (/\.[cm]?js$/u.test(base)) base = base.replace(/\.[cm]?js$/u, '');
  const candidates = [
    base,
    ...sourceExtensions.map((extension) => `${base}${extension}`),
    ...sourceExtensions.map((extension) => path.join(base, `index${extension}`)),
  ];
  return candidates.find((candidate) => knownFiles.has(candidate)) || null;
}

function isRuntimeImport(node) {
  const clause = node.importClause;
  if (!clause) return true;
  if (clause.isTypeOnly) return false;
  if (clause.name) return true;
  if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) return true;
  if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
    return clause.namedBindings.elements.some((element) => !element.isTypeOnly);
  }
  return false;
}

function isRuntimeExport(node) {
  if (node.isTypeOnly) return false;
  if (!node.exportClause) return true;
  if (ts.isNamedExports(node.exportClause)) {
    return node.exportClause.elements.some((element) => !element.isTypeOnly);
  }
  return true;
}

const files = collectSourceFiles(root);
const knownFiles = new Set(files);
const graph = new Map(files.map((file) => [file, new Set()]));

for (const file of files) {
  const sourceText = fs.readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(
    file,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  for (const statement of sourceFile.statements) {
    let specifier = null;
    if (ts.isImportDeclaration(statement) && isRuntimeImport(statement)) {
      specifier = statement.moduleSpecifier;
    } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && isRuntimeExport(statement)) {
      specifier = statement.moduleSpecifier;
    }
    if (!specifier || !ts.isStringLiteral(specifier)) continue;
    const dependency = resolveLocalImport(file, specifier.text, knownFiles);
    if (dependency) graph.get(file).add(dependency);
  }
}

let nextIndex = 0;
const indices = new Map();
const lowLinks = new Map();
const stack = [];
const onStack = new Set();
const cycles = [];

function visit(file) {
  indices.set(file, nextIndex);
  lowLinks.set(file, nextIndex);
  nextIndex += 1;
  stack.push(file);
  onStack.add(file);

  for (const dependency of graph.get(file)) {
    if (!indices.has(dependency)) {
      visit(dependency);
      lowLinks.set(file, Math.min(lowLinks.get(file), lowLinks.get(dependency)));
    } else if (onStack.has(dependency)) {
      lowLinks.set(file, Math.min(lowLinks.get(file), indices.get(dependency)));
    }
  }

  if (lowLinks.get(file) !== indices.get(file)) return;
  const component = [];
  let member;
  do {
    member = stack.pop();
    onStack.delete(member);
    component.push(member);
  } while (member !== file);

  if (component.length > 1 || graph.get(file).has(file)) cycles.push(component);
}

for (const file of files) {
  if (!indices.has(file)) visit(file);
}

if (cycles.length > 0) {
  console.error(`Frontend runtime import cycles detected (${cycles.length}):`);
  for (const component of cycles) {
    console.error(`  - ${component.map((file) => path.relative(root, file)).sort().join(' -> ')}`);
  }
  process.exit(1);
}

console.log(`Frontend architecture gate passed: ${files.length} modules, no runtime import cycles.`);
