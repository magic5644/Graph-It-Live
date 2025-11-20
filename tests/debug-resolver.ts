import { PathResolver } from '@/analyzer/PathResolver';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const fixturesPath = path.join(__dirname, '../fixtures/sample-project');

async function test() {
  const resolver = new PathResolver(
    fixturesPath,
    path.join(fixturesPath, 'tsconfig.json')
  );
  
  const mainFile = path.join(fixturesPath, 'src/main.ts');
  
  console.log('Testing @components/Button resolution...');
  const result = await resolver.resolve(mainFile, '@components/Button');
  console.log('Result:', result);
  
  console.log('\nTesting ./utils resolution...');
  const result2 = await resolver.resolve(mainFile, './utils');
  console.log('Result:', result2);
}

test().catch(console.error);
