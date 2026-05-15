import * as fs from "node:fs";
import { Project, SyntaxKind } from "ts-morph";
import type { Node, MethodDeclaration, FunctionDeclaration } from "ts-morph";

export interface IntraFileCall {
  calleeName: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
  order: number;
}

export class IntraFileCallAnalyzer {
  async extractCallsFromMethod(
    filePath: string,
    methodName: string,
  ): Promise<IntraFileCall[]> {
    if (!fs.existsSync(filePath)) {
      return [];
    }

    try {
      const sourceCode = fs.readFileSync(filePath, "utf-8");
      const project = new Project({
        useInMemoryFileSystem: true,
        compilerOptions: { target: 7, module: 99 }, // ES2020 = 7, ESNext = 99
      });

      const sourceFile = project.createSourceFile("temp.ts", sourceCode);
      const calls: IntraFileCall[] = [];

      // Find the target method
      let targetMethod: MethodDeclaration | FunctionDeclaration | undefined;

      // Check top-level functions
      for (const func of sourceFile.getFunctions()) {
        if (func.getName() === methodName) {
          targetMethod = func;
          break;
        }
      }

      // Check methods in classes
      if (!targetMethod) {
        for (const cls of sourceFile.getClasses()) {
          const method = cls.getMethods().find((m) => m.getName() === methodName);
          if (method) {
            targetMethod = method;
            break;
          }
        }
      }

      if (targetMethod) {
        extractCallsFromBody(targetMethod, calls);
      }

      return calls;
    } catch {
      return [];
    }
  }
}

function extractCallsFromBody(
  methodNode: MethodDeclaration | FunctionDeclaration,
  calls: IntraFileCall[],
): void {
  let order = 0;
  const body = methodNode.getBody?.();

  if (!body) {
    return;
  }

  const visitNode = (node: Node): void => {
    const kind = node.getKind();

    // Extract call expressions
    if (kind === SyntaxKind.CallExpression) {
      try {
        const callNode = node as any; // Safe cast for CallExpression
        const callee = callNode.getExpression?.();
        let calleeName = "";

        if (callee) {
          const calleeKind = callee.getKind();

          if (calleeKind === SyntaxKind.PropertyAccessExpression) {
            // obj.method() or this.method()
            const lastChild = callee.getLastChild();
            calleeName = lastChild?.getText() || callee.getText();
          } else if (calleeKind === SyntaxKind.Identifier) {
            // method() or function()
            calleeName = callee.getText();
          } else {
            calleeName = callee.getText();
          }
        }

        if (calleeName) {
          const pos = node.getStart() || 0;
          const sourceFile = node.getSourceFile();
          const lineAndColumn = sourceFile?.getLineAndColumnAtPos(pos) || {
            line: 0,
            column: 0,
          };
          const endPos = node.getEnd() || pos;
          const endLineAndColumn = sourceFile?.getLineAndColumnAtPos(endPos) || {
            line: 0,
            column: 0,
          };

          calls.push({
            calleeName,
            line: lineAndColumn.line || 0,
            column: lineAndColumn.column || 0,
            endLine: endLineAndColumn.line || 0,
            endColumn: endLineAndColumn.column || 0,
            order: order++,
          });
        }
      } catch {
        // Ignore errors during call extraction
      }
    }

    // Recurse into children
    node.forEachChild((child) => visitNode(child));
  };

  visitNode(body);
}
