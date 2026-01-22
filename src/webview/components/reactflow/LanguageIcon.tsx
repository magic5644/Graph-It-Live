import React from 'react';
import { LANGUAGE_COLORS } from '../../../shared/constants';

/**
 * Language icon component for file nodes
 * Displays a small language-specific icon in the top-left corner of each node
 * Icons from SuperTinyIcons: https://github.com/edent/SuperTinyIcons
 */

interface LanguageIconProps {
  filePath: string;
  label: string;
}

interface LanguageConfig {
  id: string;
  svg: string;
  fallback: string;
  color: string;
}

// SVG icon constants (reusable across extensions)
const SVG_ICONS = {
  typescript: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path d="m0 0H512V512H0" fill="#fff"/><path fill="#3178c6" d="m0 0H512V512H0"/><path d="m250 278h42v-27H173v27h42v121h34zm56 115c12 6 28 8 42 8 12 0 28-2 41-10 5-4 10-8 13-14s5-13 5-21c0-27-19-36-39-45-9-4-28-10-28-23 0-10 11-15 25-15 11 0 26 4 35 10v-31c-12-5-26-6-37-6-33 0-58 13-58 44 0 23 14 33 35 43 11 5 32 11 32 25 0 13-16 15-25 15-14 0-29-5-40-14z" fill="#fff"/></svg>',
  javascript: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path d="m0 0H512V512H0" fill="#fff"/><path d="m0 0H512V512H0" fill="#f7df1e"/><path d="m324 370q17 29 45 29 35 0 35-27c0-11-15-21-39-31q-67-22-66-75c0-36 27-64 70-64q48 0 68 39l-37 24q-12-22-31-21-22 1-23 21c0 14 9 20 39 33 43 17 67 36 67 77q-3 65-79 67-63 0-89-49zm-170 4c8 13 13 25 33 25q24 0 24-30V203h48v164q-1 71-72 72-53-1-72-44z"/></svg>',
  python: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path d="m0 0H512V512H0" fill="#fff"/><g fill="#5a9fd4"><path id="p" d="M254 64c-16 0-31 1-44 4-39 7-46 21-46 47v35h92v12H130c-27 0-50 16-58 46-8 35-8 57 0 93 7 28 23 47 49 47h32v-42c0-30 26-57 57-57h91c26 0 46-21 46-46v-88c0-24-21-43-46-47-15-3-32-4-47-4zm-50 28c10 0 17 8 17 18 0 9-7 17-17 17-9 0-17-8-17-17 0-10 8-18 17-18z"/></g><use href="#p" fill="#ffd43b" transform="rotate(180,256,255)"/></svg>',
  rust: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path d="m0 0H512V512H0" fill="#fff"/><g transform="translate(256 256)"><g id="d"><g id="c"><g id="b"><path id="a" d="M20-183 6-206c-3-5-9-5-12 0l-14 23m0 366 14 23c3 5 9 5 12 0l14-23"/><use href="#a" transform="rotate(11.25)"/></g><use href="#b" transform="rotate(22.5)"/></g><use href="#c" transform="rotate(45)"/></g><use href="#d" transform="rotate(90)"/><g id="f"><path id="e" d="M-101-161a190 190 0 00-76 230l32-16a154 154 0 01-8-73l25-13c6-3 9-9 5-15l-11-26a155 155 0 0159-61m-88 82c5-16 29-7 24 8s-29 8-24-8"/><use href="#e" transform="rotate(72)"/></g><use href="#f" transform="rotate(144)"/><use href="#e" transform="rotate(-72)"/><path d="M135 10s4 32-18 32-6-24-43-51c0 0 31-13 31-47s-40-48-57-48h-187v46h35v99h-52v49H4V42h-39V14H5c41 0 13 76 60 76h99V10M-35-28v-30h54c22 0 23 30 0 30"/></g></svg>',
  vue: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path d="m0 0H512V512H0" fill="#fff"/><path fill="#42b883" d="m64 100h148l44 77 44-77h148L256 433"/><path fill="#35495e" d="m141 100h71l44 77 44-77h71L256 300"/></svg>',
  svelte: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><path d="m0 0H512V512H0" fill="#fff"/><path fill="#ff3e00" d="M149 138a103 103 0 00-36 138A115 115 0 00274 431l89-57a108 108 0 0036-138A115 115 0 00238 81zm99 256a70 70 0 01-102-83 109 109 0 0043 21 22 22 0 0032 23l89-57a20 20 0 00-23-33l-34 21A66 66 0 01175 175l89-57a70 70 0 01102 83 115 115 0 00-43-21 21 21 0 00-32-23l-89 57a20 20 0 0023 33l34-21a66 66 0 0178 111z"/></svg>',
  graphql: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" fill="#e10098"><path d="m0 0H512V512H0" fill="#fff"/><g id="b" stroke="#e10098" transform="translate(-127 -127) scale(1.5)"><g id="a"><path stroke-width="11" d="m256 151-91 52"/><circle cx="256" cy="151" r="22"/></g><use href="#a" transform="rotate(60 256 256)"/><path stroke-width="11" d="m256 151-94 162"/></g><use href="#b" transform="rotate(120 256 256)"/><use href="#b" transform="rotate(-120 256 256)"/></svg>',
  toml: '<svg viewBox="0 0 24 24"><rect width="24" height="24" rx="2" fill="white"/><path fill="#9c4221" d="M6 7h4v2H8v8H6zm6 0h4a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2h-4v-2h4V9h-4z"/></svg>',
} as const;

// Language configurations mapping extensions to their SVG icons and colors
const LANGUAGE_CONFIGS: Record<string, LanguageConfig> = {
  // TypeScript variants (all use same icon and color)
  '.ts': { id: 'typescript', fallback: 'TS', color: LANGUAGE_COLORS.typescript, svg: SVG_ICONS.typescript },
  '.tsx': { id: 'typescript', fallback: 'TS', color: LANGUAGE_COLORS.typescript, svg: SVG_ICONS.typescript },
  '.mts': { id: 'typescript', fallback: 'TS', color: LANGUAGE_COLORS.typescript, svg: SVG_ICONS.typescript },
  '.cts': { id: 'typescript', fallback: 'TS', color: LANGUAGE_COLORS.typescript, svg: SVG_ICONS.typescript },
  
  // JavaScript variants (all use same icon and color)
  '.js': { id: 'javascript', fallback: 'JS', color: LANGUAGE_COLORS.javascript, svg: SVG_ICONS.javascript },
  '.jsx': { id: 'javascript', fallback: 'JS', color: LANGUAGE_COLORS.javascript, svg: SVG_ICONS.javascript },
  '.mjs': { id: 'javascript', fallback: 'JS', color: LANGUAGE_COLORS.javascript, svg: SVG_ICONS.javascript },
  '.cjs': { id: 'javascript', fallback: 'JS', color: LANGUAGE_COLORS.javascript, svg: SVG_ICONS.javascript },
  
  // Python variants
  '.py': { id: 'python', fallback: 'Py', color: LANGUAGE_COLORS.python, svg: SVG_ICONS.python },
  '.pyi': { id: 'python', fallback: 'Py', color: LANGUAGE_COLORS.python, svg: SVG_ICONS.python },
  
  // Rust
  '.rs': { id: 'rust', fallback: 'Rs', color: LANGUAGE_COLORS.rust, svg: SVG_ICONS.rust },
  
  // Vue
  '.vue': { id: 'vue', fallback: 'Vue', color: LANGUAGE_COLORS.vue, svg: SVG_ICONS.vue },
  
  // Svelte
  '.svelte': { id: 'svelte', fallback: 'Sv', color: LANGUAGE_COLORS.svelte, svg: SVG_ICONS.svelte },
  
  // GraphQL variants (both use same icon and color)
  '.gql': { id: 'graphql', fallback: 'GQL', color: LANGUAGE_COLORS.graphql, svg: SVG_ICONS.graphql },
  '.graphql': { id: 'graphql', fallback: 'GQL', color: LANGUAGE_COLORS.graphql, svg: SVG_ICONS.graphql },
  
  // TOML
  '.toml': { id: 'toml', fallback: 'TOML', color: LANGUAGE_COLORS.toml, svg: SVG_ICONS.toml },
};

const DEFAULT_CONFIG: LanguageConfig = {
  id: 'file',
  fallback: 'File',
  color: LANGUAGE_COLORS.unknown,
  svg: '<svg viewBox="0 0 24 24"><rect width="24" height="24" fill="white"/><path d="M6 2h8l4 4v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z" fill="#6b6b6b"/><path d="M14 2v4h4" fill="none" stroke="#6b6b6b" stroke-width="1.5"/></svg>',
};

function getLanguageConfig(filePath: string, label: string): LanguageConfig {
  // Try to match by file extension
  for (const [ext, config] of Object.entries(LANGUAGE_CONFIGS)) {
    if (label.endsWith(ext) || filePath.endsWith(ext)) {
      return config;
    }
  }

  // Special case for Cargo.toml
  if (label === 'Cargo.toml' || filePath.endsWith('Cargo.toml')) {
    return {
      id: 'cargo',
      fallback: 'Cargo',
      color: LANGUAGE_COLORS.rust,
      svg: '<svg viewBox="0 0 24 24"><rect width="24" height="24" rx="2" fill="white"/><path fill="#ce422b" d="M6 8h3v2H6zm5 0h3v2h-3zm5 0h3v2h-3zM6 12h12v4H6z"/></svg>',
    };
  }

  return DEFAULT_CONFIG;
}

export const LanguageIcon: React.FC<LanguageIconProps> = ({ filePath, label }) => {
  const config = getLanguageConfig(filePath, label);

  return (
    <div
      style={{
        position: 'absolute',
        top: 4,
        left: 4,
        width: 8,
        height: 8,
        borderRadius: 2,
        background: 'white',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 5,
        pointerEvents: 'none',
        boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
        border: '0.5px solid rgba(0,0,0,0.1)',
      }}
      title={`${config.id} file`}
      aria-label={`${config.id} file`}
    >
      {/* SVG inline */}
      <div
        style={{
          width: 16,
          height: 16,
        }}
        dangerouslySetInnerHTML={{ __html: config.svg }}
      />
    </div>
  );
};
