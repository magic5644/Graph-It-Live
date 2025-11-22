<div align="center">
  <img src="media/Graph-It-Live.png" alt="Graph-It-Live Logo" width="200"/>
</div>

# Graph-It-Live

A Visual Studio Code extension that visualizes file dependencies in a **real-time interactive graph**. Perfect for understanding code architecture and navigating complex **TypeScript**,** JavaScript**,** Vue** and **Svelte** projects.

## Features

- **Real-time Dependency Visualization**: Interactive graph showing file dependencies.
- **Multi-Language Support**: First-class support for **TypeScript** (`.ts`, `.tsx`), **JavaScript** (`.js`, `.jsx`), **Vue** (`.vue`), and **Svelte** (`.svelte`).
- **Cycle Detection**: Automatically detects and highlights circular dependencies with red dashed lines and badges.
- **Smart Navigation**: Navigate through your code history with a built-in "Back" button in the graph view.
- **Interactive Graph**:
    - **Expand/Collapse**: Dynamically load dependencies by clicking the `+` / `-` buttons on nodes.
    - **File Navigation**: Click on any node to instantly open the corresponding file in the editor.
- **VS Code Integration**: Native look and feel using VS Code themes, colors, and fonts.
- **Powered by ReactFlow & Dagre**: Smooth, automatic graph layout that adjusts as you explore.

## Prerequisites

- **Node.js**: v24 or higher
- **VS Code**: v1.85.0 or higher

## Installation

### From Marketplace
Install directly from the VS Code Marketplace (when published) or search for "Graph-It-Live" in the Extensions view (`Ctrl+Shift+X` or `Cmd+Shift+X`).

### From Open VSX Registry
The extension is also available on the [Open VSX Registry](https://open-vsx.org/). You can install it using a compatible editor (like VSCodium) or by downloading the `.vsix` from the registry page.

### From VSIX
1. Download the `.vsix` file from releases.
2. In VS Code: `Extensions` → `...` (Views and More Actions) → `Install from VSIX...`
3. Select the downloaded `.vsix` file.

## Usage

1. **Open a Project**: Open a folder containing TypeScript, JavaScript, Vue, or Svelte files.
2. **Open the Graph**:
   - Click the **Graph-It-Live** icon in the Activity Bar (left sidebar).
   - Or run the command: `Graph-It-Live: Show Dependency Graph`.
   - Or click the graph icon in the editor title bar when viewing a supported file.
3. **Interact**:
   - **Navigate**: Click a node to open the file.
   - **Expand**: Click the small `+` button on a node to reveal its dependencies.
   - **Go Back**: Use the "Back" button in the top-left corner to return to previously viewed files.
   - **Pan/Zoom**: Drag the background to pan; scroll or pinch to zoom.

## Configuration

Customize the extension in VS Code Settings (`Cmd+,` or `Ctrl+,`):

| Setting | Default | Description |
|---------|---------|-------------|
| `graph-it-live.maxDepth` | `50` | Maximum depth of dependencies to analyze initially. |
| `graph-it-live.excludeNodeModules` | `true` | Whether to exclude `node_modules` imports from the graph. |

## Development

### Project Structure

```
Graph-It-Live/
├── src/
│   ├── analyzer/          # Dependency analysis (AST parsing)
│   ├── extension/         # VS Code extension host logic
│   ├── shared/            # Shared types
│   └── webview/           # React + ReactFlow UI
├── tests/                 # Vitest unit tests
└── ...
```

### Setup

1. **Clone**:
   ```bash
   git clone https://github.com/magic5644/Graph-It-Live.git
   cd Graph-It-Live
   ```
2. **Install**:
   ```bash
   npm install
   ```
3. **Run**:
   - Press `F5` in VS Code to start the Extension Development Host.
   - **Watch Mode** (recommended for dev):
     ```bash
     npm run watch
     ```

### Scripts

- `npm run build`: Build for production.
- `npm run watch`: Build and watch for changes.
- `npm test`: Run unit tests with Vitest.
- `npm run lint:fix`: Fix linting issues.
- `npm run package`: Create a `.vsix` package.

## Contributing

Contributions are welcome! Please follow these steps:
1. Fork the repository.
2. Create a feature branch (`git checkout -b feature/amazing-feature`).
3. Commit your changes.
4. Push to the branch and open a Pull Request.

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Author

**magic56** (magic5644)
