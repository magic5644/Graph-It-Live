# Graph-It-Live

A Visual Studio Code extension that visualizes file dependencies in a real-time interactive graph. Perfect for understanding code architecture and navigating complex TypeScript/JavaScript projects.

## Features

- 🔄 **Real-time Dependency Visualization**: Interactive graph showing file dependencies
- 🎯 **Focus Mode**: Isolate specific files and their dependencies with configurable depth
- 🎨 **VS Code Integration**: Native look and feel using VS Code themes and Codicons
- 🔍 **Interactive Navigation**: Click on nodes to open files directly
- 📊 **Powered by ReactFlow & Dagre**: Smooth, automatic graph layout
- ⚙️ **Configurable**: Adjust max depth and exclude patterns

## Prerequisites

- **Node.js**: v18 or higher
- **npm**: v9 or higher
- **VS Code**: v1.85.0 or higher

## Installation

### For Development

1. **Clone the repository**:
   ```bash
   git clone https://github.com/magic5644/Graph-It-Live.git
   cd Graph-It-Live
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Build the extension**:
   ```bash
   npm run build
   ```

4. **Test in VS Code**:
   - Press `F5` in VS Code to open a new Extension Development Host window
   - The extension will be loaded and ready to use

### For Users

Install directly from the VS Code Marketplace (when published) or:

1. Download the `.vsix` file from releases
2. In VS Code: `Extensions` → `...` → `Install from VSIX...`
3. Select the downloaded `.vsix` file

## Usage

1. **Open a TypeScript/JavaScript project** in VS Code
2. **Access the Graph View**:
   - Click the Graph-It-Live icon in the Activity Bar (left sidebar)
   - Or use Command Palette: `Graph-It-Live: Show Dependency Graph`
   - Or click the graph icon in the editor title bar when viewing TS/JS files

3. **Interact with the Graph**:
   - **Pan**: Click and drag the background
   - **Zoom**: Mouse wheel or pinch gesture
   - **Navigate**: Click on any node to open that file
   - **Focus**: Use the "Isolate" feature to focus on specific files
   - **Adjust Depth**: Use the depth slider to control dependency depth

## Development

### Project Structure

```
Graph-It-Live/
├── src/
│   ├── analyzer/          # Dependency analysis logic
│   │   ├── DependencyAnalyzer.ts
│   │   ├── PathResolver.ts
│   │   └── ...
│   ├── extension/         # VS Code extension entry point
│   │   └── extension.ts
│   ├── shared/            # Shared types and utilities
│   │   └── types.ts
│   └── webview/           # React-based webview UI
│       ├── components/
│       ├── Graph.tsx
│       └── index.tsx
├── tests/                 # Unit tests
├── dist/                  # Compiled output (gitignored)
├── out/                   # TypeScript build output (gitignored)
├── media/                 # Static assets
├── esbuild.js            # Build configuration
├── tsconfig.json         # TypeScript config (extension)
├── tsconfig.webview.json # TypeScript config (webview)
└── vitest.config.ts      # Test configuration
```

### Available Scripts

| Command | Description |
|---------|-------------|
| `npm run build` | Build the extension for production |
| `npm run watch` | Build and watch for changes during development |
| `npm run compile` | Alias for build |
| `npm test` | Run tests with Vitest |
| `npm run test:watch` | Run tests in watch mode |
| `npm run lint` | Lint TypeScript files |
| `npm run lint:fix` | Auto-fix linting issues |
| `npm run package` | Package the extension as `.vsix` |
| `npm run publish` | Publish to VS Code Marketplace |

### Development Workflow

1. **Make changes** to the code in `src/`
2. **Watch mode** (recommended):
   ```bash
   npm run watch
   ```
   This will automatically rebuild when you save files.

3. **Test changes**:
   - Press `F5` in VS Code to launch Extension Development Host
   - Or reload the window (`Cmd+R` / `Ctrl+R`) if already running

4. **Run tests**:
   ```bash
   npm test
   ```

5. **Lint before committing**:
   ```bash
   npm run lint:fix
   ```

### Key Technologies

- **VS Code Extension API**: Extension host communication
- **TypeScript**: Primary language
- **React**: Webview UI framework
- **ReactFlow**: Graph visualization library
- **Dagre**: Automatic graph layout algorithm
- **esbuild**: Fast bundler for both extension and webview
- **Vitest**: Unit testing framework

### Configuration

Users can customize the extension through VS Code settings:

```json
{
  "graph-it-live.maxDepth": 3,           // Maximum dependency depth (1-5)
  "graph-it-live.excludeNodeModules": true  // Exclude node_modules
}
```

### Building for Production

To create a `.vsix` package for distribution:

```bash
npm run package
```

This creates `graph-it-live-<version>.vsix` that can be:
- Shared with users for manual installation
- Published to the VS Code Marketplace
- Distributed through your organization

### Publishing

1. **Get a Personal Access Token** from [Azure DevOps](https://dev.azure.com/)
2. **Create a publisher** on the [VS Code Marketplace](https://marketplace.visualstudio.com/manage)
3. **Update `package.json`** with your publisher name
4. **Publish**:
   ```bash
   vsce login <publisher>
   npm run publish
   ```

## Testing

This extension uses Vitest for unit testing:

- **Run all tests**: `npm test`
- **Watch mode**: `npm run test:watch`
- **Test files**: Located in `tests/` directory

### Writing Tests

Create test files with `.test.ts` extension:

```typescript
import { describe, it, expect } from 'vitest';
import { myFunction } from '../src/analyzer/myModule';

describe('myFunction', () => {
  it('should work correctly', () => {
    expect(myFunction('input')).toBe('expected');
  });
});
```

## Troubleshooting

### Common Issues

**Extension doesn't show up**:
- Make sure you've run `npm run build`
- Check the Output panel (View → Output → Graph-It-Live)

**Graph not rendering**:
- Ensure you're in a TypeScript/JavaScript project
- Check console for errors (Help → Toggle Developer Tools)

**Dependencies not detected**:
- Verify file imports/requires are standard ES6/CommonJS syntax
- Check that files are not excluded by settings

**Build errors**:
- Delete `node_modules` and `dist`, then run `npm install` and `npm run build`

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

### Development Guidelines

- Follow existing code style (enforced by ESLint)
- Add tests for new features
- Update documentation as needed
- Keep commits atomic and well-described

## License

MIT License - see [LICENSE](LICENSE) file for details

## Author

**magic56** (magic5644)

## Links

- [GitHub Repository](https://github.com/magic5644/Graph-It-Live)
- [VS Code Marketplace](https://marketplace.visualstudio.com/) (when published)
- [Report Issues](https://github.com/magic5644/Graph-It-Live/issues)

## Acknowledgments

- Built with [ReactFlow](https://reactflow.dev/)
- Layout powered by [Dagre](https://github.com/dagrejs/dagre)
- Inspired by the need to visualize complex codebases
