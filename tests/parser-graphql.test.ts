import { describe, it, expect } from 'vitest';
import { Parser } from '../src/analyzer/Parser';

describe('Parser - GraphQL Support', () => {
    const parser = new Parser();

    describe('GraphQL #import directive', () => {
        it('should parse #import with double quotes', () => {
            const content = `#import "./fragments/user.gql"

type Query {
  user(id: ID!): User
}`;
            const imports = parser.parse(content, 'schema.gql');
            expect(imports).toHaveLength(1);
            expect(imports[0].module).toBe('./fragments/user.gql');
            expect(imports[0].type).toBe('import');
        });

        it('should parse #import with single quotes', () => {
            const content = `#import './fragments/post.graphql'

fragment PostFields on Post {
  id
  title
}`;
            const imports = parser.parse(content, 'test.gql');
            expect(imports).toHaveLength(1);
            expect(imports[0].module).toBe('./fragments/post.graphql');
        });

        it('should parse multiple #import directives', () => {
            const content = `#import "./fragments/user.gql"
#import "./fragments/post.graphql"
#import '../common/pagination.gql'

type Query {
  users: [User!]!
  posts: [Post!]!
}`;
            const imports = parser.parse(content, 'schema.gql');
            expect(imports).toHaveLength(3);
            expect(imports[0].module).toBe('./fragments/user.gql');
            expect(imports[1].module).toBe('./fragments/post.graphql');
            expect(imports[2].module).toBe('../common/pagination.gql');
        });

        it('should work with .graphql extension', () => {
            const content = `#import "./common.gql"

fragment UserFields on User {
  id
  name
}`;
            const imports = parser.parse(content, 'user.graphql');
            expect(imports).toHaveLength(1);
            expect(imports[0].module).toBe('./common.gql');
        });

        it('should ignore GraphQL comments that are not imports', () => {
            const content = `# This is a regular comment
# Another comment about the schema
#import "./fragment.gql"

# Comment about the type
type User {
  id: ID!
}`;
            const imports = parser.parse(content, 'schema.gql');
            expect(imports).toHaveLength(1);
            expect(imports[0].module).toBe('./fragment.gql');
        });

        it('should handle empty GraphQL files', () => {
            const content = `# Empty schema file`;
            const imports = parser.parse(content, 'empty.gql');
            expect(imports).toHaveLength(0);
        });

        it('should handle GraphQL files with no imports', () => {
            const content = `type Query {
  hello: String!
}`;
            const imports = parser.parse(content, 'simple.gql');
            expect(imports).toHaveLength(0);
        });
    });

    describe('JS/TS importing GraphQL files', () => {
        it('should parse import of .gql file from TypeScript', () => {
            const content = `import userQuery from './queries/user.gql';
import { gql } from 'graphql-tag';

export const GET_USER = userQuery;`;
            const imports = parser.parse(content, 'api.ts');
            expect(imports).toHaveLength(2);
            expect(imports[0].module).toBe('./queries/user.gql');
            expect(imports[1].module).toBe('graphql-tag');
        });

        it('should parse import of .graphql file from JavaScript', () => {
            const content = `import schema from '../schema.graphql';

export default schema;`;
            const imports = parser.parse(content, 'index.js');
            expect(imports).toHaveLength(1);
            expect(imports[0].module).toBe('../schema.graphql');
        });

        it('should parse require of .gql file', () => {
            const content = `const query = require('./query.gql');

module.exports = query;`;
            const imports = parser.parse(content, 'query.js');
            expect(imports).toHaveLength(1);
            expect(imports[0].module).toBe('./query.gql');
            expect(imports[0].type).toBe('require');
        });

        it('should parse dynamic import of .gql file', () => {
            const content = `async function loadQuery() {
  const query = await import('./dynamic.gql');
  return query;
}`;
            const imports = parser.parse(content, 'loader.ts');
            expect(imports).toHaveLength(1);
            expect(imports[0].module).toBe('./dynamic.gql');
            expect(imports[0].type).toBe('dynamic');
        });
    });
});
