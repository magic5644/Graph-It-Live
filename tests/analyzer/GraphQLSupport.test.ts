import { describe, it, expect, beforeEach } from 'vitest';
import path from 'node:path';
import { Spider } from '../../src/analyzer/Spider';

// Use absolute path for test fixtures
const fixturesPath = path.resolve(process.cwd(), 'tests/fixtures/graphql-project');

describe('Spider - GraphQL Support', () => {
    let spider: Spider;

    beforeEach(() => {
        spider = new Spider({
            rootDir: fixturesPath,
            maxDepth: 10,
            excludeNodeModules: true,
        });
    });

    it('should analyze .gql file and find #import dependencies', async () => {
        const schemaPath = path.join(fixturesPath, 'schema.gql');
        const dependencies = await spider.analyze(schemaPath);
        
        expect(dependencies).toHaveLength(2);
        
        const modules = dependencies.map((d) => path.basename(d.path));
        expect(modules).toContain('user.gql');
        expect(modules).toContain('post.graphql');
    });

    it('should analyze .graphql file and find #import dependencies', async () => {
        const postPath = path.join(fixturesPath, 'fragments/post.graphql');
        const dependencies = await spider.analyze(postPath);
        
        expect(dependencies).toHaveLength(2);
        
        const modules = dependencies.map((d) => path.basename(d.path));
        expect(modules).toContain('common.gql');
        expect(modules).toContain('user.gql');
    });

    it('should handle GraphQL file with no imports', async () => {
        const commonPath = path.join(fixturesPath, 'fragments/common.gql');
        const dependencies = await spider.analyze(commonPath);
        
        expect(dependencies).toHaveLength(0);
    });

    it('should crawl GraphQL dependency graph', async () => {
        const schemaPath = path.join(fixturesPath, 'schema.gql');
        const graph = await spider.crawl(schemaPath);
        
        // schema.gql -> user.gql, post.graphql
        // user.gql -> common.gql
        // post.graphql -> common.gql, user.gql
        expect(graph.nodes.length).toBeGreaterThanOrEqual(4);
        expect(graph.edges.length).toBeGreaterThanOrEqual(2);
        
        const nodeNames = graph.nodes.map((n: string) => path.basename(n));
        expect(nodeNames).toContain('schema.gql');
        expect(nodeNames).toContain('user.gql');
        expect(nodeNames).toContain('post.graphql');
        expect(nodeNames).toContain('common.gql');
    });

    it('should analyze TypeScript file importing .gql files', async () => {
        const apiPath = path.join(fixturesPath, 'src/api.ts');
        const dependencies = await spider.analyze(apiPath);
        
        // Should find: ../queries/getUser.gql and ../schema.gql
        // (graphql-tag is excluded as node_module)
        expect(dependencies.length).toBeGreaterThanOrEqual(2);
        
        const modules = dependencies.map((d) => path.basename(d.path));
        expect(modules).toContain('getUser.gql');
        expect(modules).toContain('schema.gql');
    });

    it('should handle circular imports in GraphQL files', async () => {
        // post.graphql imports user.gql
        // user.gql imports common.gql
        // This tests that circular detection doesn't break
        const postPath = path.join(fixturesPath, 'fragments/post.graphql');
        const graph = await spider.crawl(postPath);
        
        expect(graph.nodes.length).toBeGreaterThan(0);
        // Should complete without infinite loop
    });
});
