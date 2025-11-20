import { PathResolver } from '@/analyzer/PathResolver';
import path from 'node:path';

const fixturesPath = '/Users/gildaslebournault/github/Graph-It-Live/tests/fixtures/sample-project';

async function test() {
  const tsConfigPath = path.join(fixturesPath, 'tsconfig.json');
  console.log('TsConfig path:', tsConfigPath);
  console.log('Fixtures path:', fixturesPath);
  
  const resolver = new PathResolver(fixturesPath, tsConfigPath);
  
  // Give it a moment to load
  await new Promise(resolve => setTimeout(resolve, 100));
  
  const mainFile = path.join(fixturesPath, 'src/main.ts');
  
  console.log('\nTesting @components/Button resolution...');
  const result = await resolver.resolve(mainFile, '@components/Button');
  console.log('Result:', result);
  
  console.log('\nTesting ./utils resolution...');
  const result2 = await resolver.resolve(mainFile, './utils');
  console.log('Result:', result2);
}

test().then(() => console.log('Done')).catch(console.error);
