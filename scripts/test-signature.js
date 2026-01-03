const { Project } = require('ts-morph');
const util = require('node:util');

function log(...args) {
  process.stdout.write(`${util.format(...args)}\n`);
}

function error(...args) {
  process.stderr.write(`${util.format(...args)}\n`);
}

// Use virtual paths instead of real paths
const filePath = '/virtual/utils.ts';

const oldContent = `export function greet(name: string): string {
  return \`Hello, \${name}!\`;
}

export function add(a: number): number {
  return a;
}`;

const newContent = `export function greet(name: string): string {
  return \`Hello, \${name}!\`;
}

export function add(a: number, b: number): number {
  return a + b;
}`;

const project = new Project({
  skipAddingFilesFromTsConfig: true,
  useInMemoryFileSystem: true,
  compilerOptions: {
    target: 99,
    module: 99,
    strict: true,
  },
});

try {
  log('Creating old source file...');
  const sf1 = project.createSourceFile(`${filePath}.old`, oldContent);
  log('Creating new source file...');
  const sf2 = project.createSourceFile(`${filePath}.new`, newContent);
  
  log('\n=== Old file ===');
  for (const func of sf1.getFunctions()) {
    const name = func.getName();
    log('Function:', name);
    try {
      const returnType = func.getReturnType();
      log('  Return type object:', returnType ? 'exists' : 'undefined');
      log('  Return type text:', returnType?.getText());
    } catch (e) {
      log('  Return type ERROR:', e.message);
    }
  }
  
  log('\n=== New file ===');
  for (const func of sf2.getFunctions()) {
    const name = func.getName();
    log('Function:', name);
    try {
      const returnType = func.getReturnType();
      log('  Return type object:', returnType ? 'exists' : 'undefined');
      log('  Return type text:', returnType?.getText());
    } catch (e) {
      log('  Return type ERROR:', e.message);
    }
  }
  
  log('\nSUCCESS');
} catch (e) {
  error('ERROR:', e.message);
  error(e.stack);
}
