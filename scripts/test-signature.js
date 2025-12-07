const { Project } = require('ts-morph');

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
  console.log('Creating old source file...');
  const sf1 = project.createSourceFile(`${filePath}.old`, oldContent);
  console.log('Creating new source file...');
  const sf2 = project.createSourceFile(`${filePath}.new`, newContent);
  
  console.log('\n=== Old file ===');
  for (const func of sf1.getFunctions()) {
    const name = func.getName();
    console.log('Function:', name);
    try {
      const returnType = func.getReturnType();
      console.log('  Return type object:', returnType ? 'exists' : 'undefined');
      console.log('  Return type text:', returnType?.getText());
    } catch (e) {
      console.log('  Return type ERROR:', e.message);
    }
  }
  
  console.log('\n=== New file ===');
  for (const func of sf2.getFunctions()) {
    const name = func.getName();
    console.log('Function:', name);
    try {
      const returnType = func.getReturnType();
      console.log('  Return type object:', returnType ? 'exists' : 'undefined');
      console.log('  Return type text:', returnType?.getText());
    } catch (e) {
      console.log('  Return type ERROR:', e.message);
    }
  }
  
  console.log('\nSUCCESS');
} catch (e) {
  console.error('ERROR:', e.message);
  console.error(e.stack);
}
