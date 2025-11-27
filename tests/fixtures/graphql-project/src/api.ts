// TypeScript file that imports GraphQL files (like webpack/vite loaders do)
import userQuery from '../queries/getUser.gql';
import schema from '../schema.gql';

// Some bundlers also support importing with graphql-tag
import { gql } from 'graphql-tag';

export const GET_USER = userQuery;
export const SCHEMA = schema;

// Inline query (not imported from file)
export const GET_POSTS = gql`
  query GetPosts {
    posts {
      id
      title
    }
  }
`;
