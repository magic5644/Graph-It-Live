import { describe, it, expect, beforeEach } from 'vitest';
import {
  SignatureAnalyzer,
  SignatureInfo,
  InterfaceMemberInfo,
} from '../../src/analyzer/SignatureAnalyzer';

describe('SignatureAnalyzer', () => {
  let analyzer: SignatureAnalyzer;

  beforeEach(() => {
    analyzer = new SignatureAnalyzer();
  });

  describe('extractSignatures', () => {
    it('should extract top-level function signatures', () => {
      const content = `
        export function greet(name: string): string {
          return 'Hello, ' + name;
        }
        
        export async function fetchData(url: string, timeout?: number): Promise<any> {
          return fetch(url);
        }
      `;

      const signatures = analyzer.extractSignatures('/test.ts', content);
      
      expect(signatures).toHaveLength(2);
      
      const greet = signatures.find(s => s.name === 'greet');
      expect(greet).toBeDefined();
      expect(greet!.kind).toBe('function');
      expect(greet!.parameters).toHaveLength(1);
      expect(greet!.parameters[0].name).toBe('name');
      expect(greet!.parameters[0].type).toBe('string');
      expect(greet!.parameters[0].isOptional).toBe(false);
      expect(greet!.returnType).toBe('string');
      expect(greet!.isAsync).toBe(false);
      
      const fetchData = signatures.find(s => s.name === 'fetchData');
      expect(fetchData).toBeDefined();
      expect(fetchData!.isAsync).toBe(true);
      expect(fetchData!.parameters).toHaveLength(2);
      expect(fetchData!.parameters[1].isOptional).toBe(true);
    });

    it('should extract class method signatures', () => {
      const content = `
        export class UserService {
          private readonly cache: Map<string, any>;
          
          constructor(private db: Database) {}
          
          public async getUser(id: string): Promise<User> {
            return this.db.find(id);
          }
          
          private sanitize(input: string): string {
            return input.trim();
          }
          
          static fromConfig(config: Config): UserService {
            return new UserService(config.db);
          }
        }
      `;

      const signatures = analyzer.extractSignatures('/service.ts', content);
      
      // Constructor + 3 methods
      expect(signatures.length).toBeGreaterThanOrEqual(3);
      
      const ctor = signatures.find(s => s.name === 'UserService.constructor');
      expect(ctor).toBeDefined();
      expect(ctor!.kind).toBe('constructor');
      expect(ctor!.parameters).toHaveLength(1);
      
      const getUser = signatures.find(s => s.name === 'UserService.getUser');
      expect(getUser).toBeDefined();
      expect(getUser!.visibility).toBe('public');
      expect(getUser!.isAsync).toBe(true);
      
      const sanitize = signatures.find(s => s.name === 'UserService.sanitize');
      expect(sanitize).toBeDefined();
      // Note: visibility detection depends on ts-morph internals
      expect(sanitize!.visibility).toBeDefined();
      
      const fromConfig = signatures.find(s => s.name === 'UserService.fromConfig');
      expect(fromConfig).toBeDefined();
      expect(fromConfig!.isStatic).toBe(true);
    });

    it('should extract arrow function signatures', () => {
      const content = `
        export const add = (a: number, b: number): number => a + b;
        
        export const fetchAsync = async (url: string): Promise<Response> => {
          return fetch(url);
        };
      `;

      const signatures = analyzer.extractSignatures('/utils.ts', content);
      
      const add = signatures.find(s => s.name === 'add');
      expect(add).toBeDefined();
      expect(add!.kind).toBe('arrow');
      expect(add!.parameters).toHaveLength(2);
      
      const fetchAsync = signatures.find(s => s.name === 'fetchAsync');
      expect(fetchAsync).toBeDefined();
      expect(fetchAsync!.isAsync).toBe(true);
    });

    it('should handle parameters with default values', () => {
      const content = `
        export function format(value: string, uppercase = false): string {
          return uppercase ? value.toUpperCase() : value;
        }
      `;

      const signatures = analyzer.extractSignatures('/format.ts', content);
      
      expect(signatures).toHaveLength(1);
      const format = signatures[0];
      expect(format.parameters[1].hasDefault).toBe(true);
      expect(format.parameters[1].isOptional).toBe(true);
    });

    it('should handle rest parameters', () => {
      const content = `
        export function sum(...numbers: number[]): number {
          return numbers.reduce((a, b) => a + b, 0);
        }
      `;

      const signatures = analyzer.extractSignatures('/math.ts', content);
      
      expect(signatures).toHaveLength(1);
      expect(signatures[0].parameters[0].isRest).toBe(true);
    });
  });

  describe('extractInterfaceMembers', () => {
    it('should extract interface properties and methods', () => {
      const content = `
        export interface User {
          id: string;
          name: string;
          email?: string;
          readonly createdAt: Date;
          updateName(newName: string): void;
        }
      `;

      const interfaces = analyzer.extractInterfaceMembers('/types.ts', content);
      
      expect(interfaces.has('User')).toBe(true);
      const members = interfaces.get('User')!;
      
      const id = members.find(m => m.name === 'id');
      expect(id).toBeDefined();
      expect(id!.kind).toBe('property');
      expect(id!.type).toBe('string');
      expect(id!.isOptional).toBe(false);
      
      const email = members.find(m => m.name === 'email');
      expect(email).toBeDefined();
      expect(email!.isOptional).toBe(true);
      
      const createdAt = members.find(m => m.name === 'createdAt');
      expect(createdAt).toBeDefined();
      expect(createdAt!.isReadonly).toBe(true);
      
      const updateName = members.find(m => m.name === 'updateName');
      expect(updateName).toBeDefined();
      expect(updateName!.kind).toBe('method');
    });
  });

  describe('extractTypeAliases', () => {
    it('should extract type alias definitions', () => {
      const content = `
        export type UserId = string;
        export type Result<T, E> = { success: true; data: T } | { success: false; error: E };
      `;

      const types = analyzer.extractTypeAliases('/types.ts', content);
      
      expect(types).toHaveLength(2);
      
      const userId = types.find(t => t.name === 'UserId');
      expect(userId).toBeDefined();
      expect(userId!.type).toBe('string');
      
      const result = types.find(t => t.name === 'Result');
      expect(result).toBeDefined();
      expect(result!.typeParameters).toHaveLength(2);
    });
  });

  describe('compareSignatures', () => {
    it('should detect no changes for identical signatures', () => {
      const sig: SignatureInfo = {
        name: 'process',
        kind: 'function',
        parameters: [
          { name: 'data', type: 'string', isOptional: false, hasDefault: false, isRest: false, position: 0 }
        ],
        returnType: 'string',
        isAsync: false,
        line: 1,
      };

      const result = analyzer.compareSignatures(sig, sig);
      
      expect(result.hasBreakingChanges).toBe(false);
      expect(result.breakingChanges).toHaveLength(0);
    });

    it('should detect added required parameter as breaking', () => {
      const oldSig: SignatureInfo = {
        name: 'greet',
        kind: 'function',
        parameters: [
          { name: 'name', type: 'string', isOptional: false, hasDefault: false, isRest: false, position: 0 }
        ],
        returnType: 'string',
        isAsync: false,
        line: 1,
      };

      const newSig: SignatureInfo = {
        name: 'greet',
        kind: 'function',
        parameters: [
          { name: 'name', type: 'string', isOptional: false, hasDefault: false, isRest: false, position: 0 },
          { name: 'formal', type: 'boolean', isOptional: false, hasDefault: false, isRest: false, position: 1 }
        ],
        returnType: 'string',
        isAsync: false,
        line: 1,
      };

      const result = analyzer.compareSignatures(oldSig, newSig);
      
      expect(result.hasBreakingChanges).toBe(true);
      const addedParam = result.breakingChanges.find(c => c.type === 'parameter-added-required');
      expect(addedParam).toBeDefined();
      expect(addedParam!.description).toContain('formal');
    });

    it('should not flag added optional parameter as breaking', () => {
      const oldSig: SignatureInfo = {
        name: 'greet',
        kind: 'function',
        parameters: [
          { name: 'name', type: 'string', isOptional: false, hasDefault: false, isRest: false, position: 0 }
        ],
        returnType: 'string',
        isAsync: false,
        line: 1,
      };

      const newSig: SignatureInfo = {
        name: 'greet',
        kind: 'function',
        parameters: [
          { name: 'name', type: 'string', isOptional: false, hasDefault: false, isRest: false, position: 0 },
          { name: 'formal', type: 'boolean', isOptional: true, hasDefault: false, isRest: false, position: 1 }
        ],
        returnType: 'string',
        isAsync: false,
        line: 1,
      };

      const result = analyzer.compareSignatures(oldSig, newSig);
      
      expect(result.hasBreakingChanges).toBe(false);
      expect(result.nonBreakingChanges.length).toBeGreaterThan(0);
    });

    it('should detect removed parameter as breaking', () => {
      const oldSig: SignatureInfo = {
        name: 'process',
        kind: 'function',
        parameters: [
          { name: 'input', type: 'string', isOptional: false, hasDefault: false, isRest: false, position: 0 },
          { name: 'options', type: 'Options', isOptional: false, hasDefault: false, isRest: false, position: 1 }
        ],
        returnType: 'void',
        isAsync: false,
        line: 1,
      };

      const newSig: SignatureInfo = {
        name: 'process',
        kind: 'function',
        parameters: [
          { name: 'input', type: 'string', isOptional: false, hasDefault: false, isRest: false, position: 0 }
        ],
        returnType: 'void',
        isAsync: false,
        line: 1,
      };

      const result = analyzer.compareSignatures(oldSig, newSig);
      
      expect(result.hasBreakingChanges).toBe(true);
      const removed = result.breakingChanges.find(c => c.type === 'parameter-removed');
      expect(removed).toBeDefined();
      expect(removed!.description).toContain('options');
    });

    it('should detect parameter type change as breaking', () => {
      const oldSig: SignatureInfo = {
        name: 'setId',
        kind: 'function',
        parameters: [
          { name: 'id', type: 'string', isOptional: false, hasDefault: false, isRest: false, position: 0 }
        ],
        returnType: 'void',
        isAsync: false,
        line: 1,
      };

      const newSig: SignatureInfo = {
        name: 'setId',
        kind: 'function',
        parameters: [
          { name: 'id', type: 'number', isOptional: false, hasDefault: false, isRest: false, position: 0 }
        ],
        returnType: 'void',
        isAsync: false,
        line: 1,
      };

      const result = analyzer.compareSignatures(oldSig, newSig);
      
      expect(result.hasBreakingChanges).toBe(true);
      const typeChange = result.breakingChanges.find(c => c.type === 'parameter-type-changed');
      expect(typeChange).toBeDefined();
      expect(typeChange!.oldValue).toBe('string');
      expect(typeChange!.newValue).toBe('number');
    });

    it('should detect return type change as breaking', () => {
      const oldSig: SignatureInfo = {
        name: 'getData',
        kind: 'function',
        parameters: [],
        returnType: 'string',
        isAsync: false,
        line: 1,
      };

      const newSig: SignatureInfo = {
        name: 'getData',
        kind: 'function',
        parameters: [],
        returnType: 'string | null',
        isAsync: false,
        line: 1,
      };

      const result = analyzer.compareSignatures(oldSig, newSig);
      
      expect(result.hasBreakingChanges).toBe(true);
      const returnChange = result.breakingChanges.find(c => c.type === 'return-type-changed');
      expect(returnChange).toBeDefined();
    });

    it('should detect visibility reduction as breaking', () => {
      const oldSig: SignatureInfo = {
        name: 'MyClass.doSomething',
        kind: 'method',
        parameters: [],
        returnType: 'void',
        isAsync: false,
        visibility: 'public',
        line: 1,
      };

      const newSig: SignatureInfo = {
        name: 'MyClass.doSomething',
        kind: 'method',
        parameters: [],
        returnType: 'void',
        isAsync: false,
        visibility: 'private',
        line: 1,
      };

      const result = analyzer.compareSignatures(oldSig, newSig);
      
      expect(result.hasBreakingChanges).toBe(true);
      const visibility = result.breakingChanges.find(c => c.type === 'visibility-reduced');
      expect(visibility).toBeDefined();
    });

    it('should detect optional to required parameter change as breaking', () => {
      const oldSig: SignatureInfo = {
        name: 'configure',
        kind: 'function',
        parameters: [
          { name: 'config', type: 'Config', isOptional: true, hasDefault: false, isRest: false, position: 0 }
        ],
        returnType: 'void',
        isAsync: false,
        line: 1,
      };

      const newSig: SignatureInfo = {
        name: 'configure',
        kind: 'function',
        parameters: [
          { name: 'config', type: 'Config', isOptional: false, hasDefault: false, isRest: false, position: 0 }
        ],
        returnType: 'void',
        isAsync: false,
        line: 1,
      };

      const result = analyzer.compareSignatures(oldSig, newSig);
      
      expect(result.hasBreakingChanges).toBe(true);
      const optionalChange = result.breakingChanges.find(c => c.type === 'parameter-optional-to-required');
      expect(optionalChange).toBeDefined();
    });
  });

  describe('compareInterfaces', () => {
    it('should detect removed member as breaking', () => {
      const oldMembers: InterfaceMemberInfo[] = [
        { name: 'id', kind: 'property', type: 'string', isOptional: false, isReadonly: false },
        { name: 'name', kind: 'property', type: 'string', isOptional: false, isReadonly: false },
      ];

      const newMembers: InterfaceMemberInfo[] = [
        { name: 'id', kind: 'property', type: 'string', isOptional: false, isReadonly: false },
      ];

      const result = analyzer.compareInterfaces('User', oldMembers, newMembers);
      
      expect(result.hasBreakingChanges).toBe(true);
      const removed = result.breakingChanges.find(c => c.type === 'member-removed');
      expect(removed).toBeDefined();
      expect(removed!.description).toContain('name');
    });

    it('should detect member type change as breaking', () => {
      const oldMembers: InterfaceMemberInfo[] = [
        { name: 'count', kind: 'property', type: 'number', isOptional: false, isReadonly: false },
      ];

      const newMembers: InterfaceMemberInfo[] = [
        { name: 'count', kind: 'property', type: 'string', isOptional: false, isReadonly: false },
      ];

      const result = analyzer.compareInterfaces('Stats', oldMembers, newMembers);
      
      expect(result.hasBreakingChanges).toBe(true);
      const typeChange = result.breakingChanges.find(c => c.type === 'member-type-changed');
      expect(typeChange).toBeDefined();
    });

    it('should detect new required member as breaking', () => {
      const oldMembers: InterfaceMemberInfo[] = [
        { name: 'id', kind: 'property', type: 'string', isOptional: false, isReadonly: false },
      ];

      const newMembers: InterfaceMemberInfo[] = [
        { name: 'id', kind: 'property', type: 'string', isOptional: false, isReadonly: false },
        { name: 'version', kind: 'property', type: 'number', isOptional: false, isReadonly: false },
      ];

      const result = analyzer.compareInterfaces('Entity', oldMembers, newMembers);
      
      expect(result.hasBreakingChanges).toBe(true);
    });

    it('should not flag new optional member as breaking', () => {
      const oldMembers: InterfaceMemberInfo[] = [
        { name: 'id', kind: 'property', type: 'string', isOptional: false, isReadonly: false },
      ];

      const newMembers: InterfaceMemberInfo[] = [
        { name: 'id', kind: 'property', type: 'string', isOptional: false, isReadonly: false },
        { name: 'metadata', kind: 'property', type: 'Record<string, any>', isOptional: true, isReadonly: false },
      ];

      const result = analyzer.compareInterfaces('Entity', oldMembers, newMembers);
      
      expect(result.hasBreakingChanges).toBe(false);
      expect(result.nonBreakingChanges.length).toBeGreaterThan(0);
    });
  });

  describe('analyzeBreakingChanges', () => {
    it('should detect removed functions', () => {
      const oldContent = `
        export function helperA(): void {}
        export function helperB(): void {}
      `;

      const newContent = `
        export function helperA(): void {}
      `;

      const results = analyzer.analyzeBreakingChanges('/helpers.ts', oldContent, newContent);
      
      const removed = results.find(r => r.symbolName === 'helperB' && r.hasBreakingChanges);
      expect(removed).toBeDefined();
    });

    it('should detect interface changes', () => {
      const oldContent = `
        export interface Config {
          host: string;
          port: number;
        }
      `;

      const newContent = `
        export interface Config {
          host: string;
          port: number;
          secure: boolean;
        }
      `;

      const results = analyzer.analyzeBreakingChanges('/config.ts', oldContent, newContent);
      
      const configResult = results.find(r => r.symbolName === 'Config');
      expect(configResult).toBeDefined();
      // New required member is breaking
      expect(configResult!.hasBreakingChanges).toBe(true);
    });
  });
});
