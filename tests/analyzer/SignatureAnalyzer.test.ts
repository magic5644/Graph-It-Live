import * as path from 'node:path';
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
      expect(greet!.isExported).toBe(true);
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

    it.each([
      ['optional', { isOptional: true, hasDefault: false, isRest: false }, 2],
      ['defaulted', { isOptional: false, hasDefault: true, isRest: false }, 2],
      ['rest', { isOptional: false, hasDefault: false, isRest: true }, 2],
      ['required', { isOptional: false, hasDefault: false, isRest: false }, undefined],
    ])('tells which calls break when a %s parameter is removed', (_label, flags, expected) => {
      const input = { name: 'input', type: 'string', isOptional: false, hasDefault: false, isRest: false, position: 0 };
      const sig = (parameters: SignatureInfo['parameters']): SignatureInfo => ({
        name: 'process', kind: 'function', parameters, returnType: 'void', isAsync: false, line: 1,
      });

      const result = analyzer.compareSignatures(
        sig([input, { name: 'extra', type: 'string', position: 1, ...flags }]),
        sig([input]),
      );

      const removed = result.breakingChanges.find(c => c.type === 'parameter-removed');
      expect(removed?.breaksCallsWithArgs).toBe(expected);
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
    it('compares declared signatures without resolving unavailable imported types', () => {
      const oldContent = `
        import type { MissingType } from './missing';
        export function configure(value: MissingType): MissingType { return value; }
      `;
      const newContent = `
        import type { MissingType } from './missing';
        export function configure(value: MissingType, strict: boolean): MissingType { return value; }
      `;

      const results = analyzer.analyzeBreakingChanges('/unresolved.ts', oldContent, newContent);

      expect(results).toEqual(expect.arrayContaining([
        expect.objectContaining({
          symbolName: 'configure',
          breakingChanges: expect.arrayContaining([
            expect.objectContaining({ type: 'parameter-added-required' }),
          ]),
        }),
      ]));
    });

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

    it('ignores removed private methods from an exported class API', () => {
      const oldContent = `
        export class Service {
          public execute(): void {}
          private internalOnly(): void {}
        }
      `;
      const newContent = `
        export class Service {
          public execute(): void {}
        }
      `;

      expect(analyzer.analyzeBreakingChanges('/service.ts', oldContent, newContent)).toEqual([]);
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

    it('detects a new required Vue defineProps member', () => {
      const oldContent = '<script setup lang="ts">const props = defineProps<{ label: string }>();</script><template />';
      const newContent = '<script setup lang="ts">const props = defineProps<{ label: string; count: number }>();</script><template />';

      const result = analyzer.analyzeBreakingChanges('/components/Counter.vue', oldContent, newContent)
        .find(item => item.symbolName === 'Counter.props');

      expect(result?.breakingChanges).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'member-optional-to-required',
          symbolName: 'Counter.props.count',
        }),
      ]));
    });

    it('extracts Vue scripts when the closing tag contains tolerated trailing text', () => {
      const oldContent = '<script lang="ts">defineProps<{ label: string }>();</script\t\n data="ignored">\n<template />';
      const newContent = '<script lang="ts">defineProps<{ label: string; count: number }>();</script\t\n data="ignored">\n<template />';

      const result = analyzer.analyzeBreakingChanges('/components/Counter.vue', oldContent, newContent)
        .find(item => item.symbolName === 'Counter.props');

      expect(result?.breakingChanges).toEqual(expect.arrayContaining([
        expect.objectContaining({ symbolName: 'Counter.props.count' }),
      ]));
    });

    it('detects required changes in runtime Vue props', () => {
      const oldContent = '<script setup>defineProps({ label: { type: String, required: true } });</script><template />';
      const newContent = '<script setup>defineProps({ label: { type: String, required: true }, count: { type: Number, required: true } });</script><template />';

      const result = analyzer.analyzeBreakingChanges('/components/Counter.vue', oldContent, newContent)
        .find(item => item.symbolName === 'Counter.props');

      expect(result?.breakingChanges).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'member-optional-to-required',
          symbolName: 'Counter.props.count',
        }),
      ]));
    });

    it('detects breaking changes in class-based Vue decorators', () => {
      const oldContent = '<script lang="ts">import { Prop, Model } from "vue-facing-decorator"; export class CreateDeposit extends Vue { @Prop() invoice: InvoiceDTO; @Model({ required: true }) depositIsValid: boolean; }</script><template />';
      const newContent = '<script lang="ts">import { Prop, Model } from "vue-facing-decorator"; export class CreateDeposit extends Vue { @Prop() invoiceData: InvoiceDTO; @Model({ required: true }) depositIsValid: boolean; }</script><template />';

      const result = analyzer.analyzeBreakingChanges('/components/CreateDeposit.vue', oldContent, newContent)
        .find(item => item.symbolName === 'CreateDeposit.props');

      expect(result?.breakingChanges).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: 'member-renamed',
          symbolName: 'CreateDeposit.props.invoiceData',
        }),
      ]));
    });
  });

  describe('object-literal parameter types', () => {
    const scan = (oldType: string, newType: string) => analyzer.analyzeBreakingChanges(
      '/options.ts',
      `export function scan(options: ${oldType}): void {}\n`,
      `export function scan(options: ${newType}): void {}\n`,
    ).find(result => result.symbolName === 'scan');

    it('treats an added optional property as compatible', () => {
      const result = scan('{ maxFiles?: number; strict: boolean }', '{ maxFiles?: number; strict: boolean; signal?: AbortSignal }');

      expect(result?.breakingChanges ?? []).toEqual([]);
      expect(result?.nonBreakingChanges).toContain("Parameter 'options' gained optional properties");
    });

    it.each([
      ['an added required property', '{ maxFiles?: number }', '{ maxFiles?: number; signal: AbortSignal }'],
      ['a removed property', '{ maxFiles?: number; strict?: boolean }', '{ maxFiles?: number }'],
      ['a retyped property', '{ maxFiles?: number }', '{ maxFiles?: string }'],
      ['a property made required', '{ maxFiles?: number }', '{ maxFiles: number }'],
      ['a method member', '{ run(): void }', '{ run(): void; stop?: number }'],
      ['a non-literal type', 'Options', 'Options & { signal?: AbortSignal }'],
    ])('keeps %s as a parameter type change', (_case, oldType, newType) => {
      expect(scan(oldType, newType)?.breakingChanges).toEqual([
        expect.objectContaining({ type: 'parameter-type-changed' }),
      ]);
    });
  });

  describe('analyzeBreakingChanges with symbolName (#260)', () => {
    const oldContent = 'export function createUser(name: string): string { return name; }\n';
    const newContent = 'export function createUser(name: string, role: string): string { return name + role; }\n';

    it('keeps a valid comparison unchanged', () => {
      const results = analyzer.analyzeBreakingChanges('/src/api.ts', oldContent, newContent, 'createUser');

      expect(results).toHaveLength(1);
      expect(results[0].breakingChanges).toEqual([
        expect.objectContaining({ type: 'parameter-added-required', severity: 'error' }),
      ]);
    });

    it('rejects a placeholder oldContent instead of reporting no breaking change', () => {
      expect(() => analyzer.analyzeBreakingChanges('/src/api.ts', 'PLACEHOLDER', newContent, 'createUser'))
        .toThrow("Symbol 'createUser' is not declared in oldContent; cannot compare. Pass the full previous file content.");
    });

    it('rejects a misspelled symbolName with a suggestion', () => {
      expect(() => analyzer.analyzeBreakingChanges('/src/api.ts', oldContent, newContent, 'createUsr'))
        .toThrow("Symbol 'createUsr' not found in oldContent or newContent. Did you mean: createUser?");
    });

    it('rejects an unknown symbolName without suggestions when nothing is close', () => {
      expect(() => analyzer.analyzeBreakingChanges('/src/api.ts', oldContent, newContent, 'zzz'))
        .toThrow("Symbol 'zzz' not found in oldContent or newContent. No symbol with a similar name is declared in this file.");
    });

    it('reports a symbol removed from newContent as member-removed', () => {
      const results = analyzer.analyzeBreakingChanges('/src/api.ts', oldContent, '', 'createUser');

      expect(results[0].breakingChanges).toEqual([expect.objectContaining({ type: 'member-removed' })]);
    });

    it('reports a new export as a non-breaking addition when oldContent is a real baseline', () => {
      const added = `${oldContent}export function deleteUser(id: string): void {}\n`;

      const results = analyzer.analyzeBreakingChanges('/src/api.ts', oldContent, added, 'deleteUser');

      expect(results).toEqual([{
        symbolName: 'deleteUser',
        hasBreakingChanges: false,
        breakingChanges: [],
        nonBreakingChanges: ["'deleteUser' is new: it is not declared in oldContent, so no existing caller can break"],
      }]);
    });

    it('treats a blank oldContent as a new file, not a placeholder', () => {
      const results = analyzer.analyzeBreakingChanges('/src/api.ts', '  \n', newContent, 'createUser');

      expect(results[0].hasBreakingChanges).toBe(false);
      expect(results[0].nonBreakingChanges).toHaveLength(1);
    });

    it('returns no change for an unchanged signature', () => {
      expect(analyzer.analyzeBreakingChanges('/src/api.ts', oldContent, oldContent, 'createUser')).toEqual([]);
    });

    it('matches a class by name and a method by member name', () => {
      const oldClass = 'export class Repo { save(id: string): void {} }';
      const newClass = 'export class Repo { save(id: string, force: boolean): void {} }';

      for (const symbolName of ['Repo', 'save', 'Repo.save']) {
        const results = analyzer.analyzeBreakingChanges('/src/repo.ts', oldClass, newClass, symbolName);
        expect(results.map((r) => r.symbolName)).toEqual(['Repo.save']);
      }
    });

    it('finds interfaces, type aliases and Vue props by name', () => {
      const types = 'export interface Options { a: string }\nexport type Id = string;\n';
      expect(analyzer.analyzeBreakingChanges('/src/types.ts', types, types, 'Options')).toEqual([]);
      expect(analyzer.analyzeBreakingChanges('/src/types.ts', types, types, 'Id')).toEqual([]);

      const vue = '<script setup lang="ts">defineProps<{ label: string }>();</script><template />';
      expect(analyzer.analyzeBreakingChanges('/components/Counter.vue', vue, vue, 'Counter.props')).toEqual([]);
    });

    it('accepts declared symbols that have nothing to compare: classes without methods, enums, constants', () => {
      const old = 'export class Config { port = 1 }\nexport enum Mode { A }\nexport const LIMIT = 3;\n';

      for (const symbolName of ['Config', 'Mode', 'LIMIT']) {
        expect(analyzer.analyzeBreakingChanges('/src/config.ts', old, old, symbolName)).toEqual([]);
      }
      const added = `${old}export const MAX = 4;\n`;
      expect(analyzer.analyzeBreakingChanges('/src/config.ts', old, added, 'MAX')[0].hasBreakingChanges).toBe(false);
    });

    it('accepts Windows paths for the analyzed file', () => {
      expect(() => analyzer.analyzeBreakingChanges(String.raw`C:\repo\src\api.ts`, 'PLACEHOLDER', newContent, 'createUser'))
        .toThrow('is not declared in oldContent');
      // The props name must be the one the comparison reports, whatever the separator handling.
      const vuePath = String.raw`C:\repo\components\Counter.vue`;
      const oldVue = '<script setup lang="ts">defineProps<{ label: string }>();</script><template />';
      const newVue = '<script setup lang="ts">defineProps<{ label: number }>();</script><template />';
      const [all] = analyzer.analyzeBreakingChanges(vuePath, oldVue, newVue);
      expect(analyzer.analyzeBreakingChanges(vuePath, oldVue, newVue, all.symbolName)).toEqual([all]);
    });
  });

  /** Regression (#363): a declaration moved behind a re-export was reported as removed. */
  describe('resolveReexportedRemovals', () => {
    const root = path.join(path.sep, 'workspace', 'src');
    const filePath = path.join(root, 'helpers.ts');
    const OLD_HELPERS = [
      'export function moved(a: string): string { return a; }',
      'export interface Shape { size: number }',
      'export type Id = string;',
      'export class Store { get(key: string): string { return key; } }',
    ].join('\n');
    const MOVED = [
      'export function moved(a: string): string { return a; }',
      'export interface Shape { size: number }',
      'export type Id = string;',
      'export class Store { get(key: string): string { return key; } }',
    ].join('\n');

    const loaderFor = (modules: Record<string, string>) => {
      const requested: string[] = [];
      const load = (fromFile: string, specifier: string) => {
        requested.push(fromFile);
        const target = path.join(path.dirname(fromFile), `${specifier}.ts`);
        const content = modules[target];
        return Promise.resolve(content === undefined ? null : { filePath: target, content });
      };
      return { load, requested };
    };

    const resolve = (newContent: string, modules: Record<string, string>, oldContent = OLD_HELPERS) => {
      const { load } = loaderFor(modules);
      const results = analyzer.analyzeBreakingChanges(filePath, oldContent, newContent);
      return analyzer.resolveReexportedRemovals(filePath, oldContent, newContent, results, load);
    };

    const elsewhere = { [path.join(root, 'elsewhere.ts')]: MOVED };

    it.each([
      ['export { ... } from', 'export { moved, Store } from "./elsewhere";\nexport type { Shape, Id } from "./elsewhere";'],
      ['import then export', 'import { moved, Store, type Shape, type Id } from "./elsewhere";\nexport { moved, Store, type Shape, type Id };'],
      ['export *', 'export * from "./elsewhere";'],
    ])('drops removals re-exported with %s', async (_form, newContent) => {
      const before = analyzer.analyzeBreakingChanges(filePath, OLD_HELPERS, newContent);
      expect(before.map((r) => r.symbolName).sort()).toEqual(['Id', 'Shape', 'Store.get', 'moved']);

      expect(await resolve(newContent, elsewhere)).toEqual({ results: [], limitations: [] });
    });

    it('follows a barrel chain and skips an export * that does not declare the name', async () => {
      const modules = {
        [path.join(root, 'empty.ts')]: 'export const unrelated = 1;',
        [path.join(root, 'barrel.ts')]: 'export * from "./empty";\nexport * from "./elsewhere";',
        ...elsewhere,
      };
      expect(await resolve('export * from "./barrel";', modules)).toEqual({ results: [], limitations: [] });
    });

    it('stops on a re-export cycle and keeps the removal', async () => {
      const modules = {
        [path.join(root, 'a.ts')]: 'export * from "./b";',
        [path.join(root, 'b.ts')]: 'export * from "./a";',
      };
      const { results } = await resolve('export * from "./a";', modules);
      expect(results.map((r) => r.symbolName).sort()).toEqual(['Id', 'Shape', 'Store.get', 'moved']);
    });

    it('still reports a name only exported under an alias', async () => {
      const { results } = await resolve('export { moved as renamed } from "./elsewhere";', elsewhere, 'export function moved(a: string): string { return a; }');
      expect(results).toHaveLength(1);
      expect(results[0].breakingChanges[0]).toMatchObject({ type: 'member-removed', symbolName: 'moved' });
    });

    it('compares a re-export alias with the declaration it points to', async () => {
      const modules = { [path.join(root, 'elsewhere.ts')]: 'export function original(a: string): string { return a; }' };
      const oldContent = 'export function moved(a: string): string { return a; }';
      expect(await resolve('export { original as moved } from "./elsewhere";', modules, oldContent)).toEqual({ results: [], limitations: [] });
    });

    it('reports a signature change when the moved declaration changed', async () => {
      const modules = {
        [path.join(root, 'elsewhere.ts')]: [
          'export function moved(a: string, b: number): string { return a; }',
          'export interface Shape { size: string }',
          'export type Id = number;',
          'export class Store { get(key: number): string { return String(key); } }',
        ].join('\n'),
      };
      const { results } = await resolve('export * from "./elsewhere";', modules);
      const types = Object.fromEntries(results.map((r) => [r.symbolName, r.breakingChanges[0].type]));
      expect(types).toEqual({
        moved: 'parameter-added-required',
        Shape: 'member-type-changed',
        Id: 'type-alias-changed',
        'Store.get': 'parameter-type-changed',
      });
    });

    it('keeps the removal when the target no longer declares the member', async () => {
      const modules = { [path.join(root, 'elsewhere.ts')]: 'export class Store {}\nexport const moved = 1;\nexport interface Other {}' };
      const { results } = await resolve('export * from "./elsewhere";', modules);
      expect(results.map((r) => r.symbolName).sort()).toEqual(['Id', 'Shape', 'Store.get', 'moved']);
    });

    it('keeps the removal and lists a limitation when the target cannot be resolved', async () => {
      const oldContent = 'export function moved(a: string): string { return a; }';
      const { results, limitations } = await resolve('export { moved } from "./missing";', {}, oldContent);
      expect(results[0].breakingChanges[0]).toMatchObject({ type: 'member-removed', symbolName: 'moved' });
      expect(limitations).toEqual(["Re-export of 'moved' from './missing' could not be resolved; its removal is unverified."]);
    });

    it('reports an unresolvable export * once for every removal behind it', async () => {
      const { results, limitations } = await resolve('export * from "./missing";', {});
      expect(results).toHaveLength(4);
      expect(limitations).toEqual(["Re-exports from './missing' could not be resolved; removals behind them are unverified."]);
    });

    it('keeps the removal when export * as ns only exports a namespace', async () => {
      const oldContent = 'export function moved(a: string): string { return a; }';
      const { results } = await resolve('export * as moved from "./elsewhere";', elsewhere, oldContent);
      expect(results[0].breakingChanges[0]).toMatchObject({ type: 'member-removed', symbolName: 'moved' });
    });

    it('keeps the removal with a limitation when the loader rejects', async () => {
      const oldContent = 'export function moved(a: string): string { return a; }';
      const newContent = 'export { moved } from "./elsewhere";';
      const results = analyzer.analyzeBreakingChanges(filePath, oldContent, newContent);
      const resolved = await analyzer.resolveReexportedRemovals(filePath, oldContent, newContent, results, () => Promise.reject(new Error('git failed')));
      expect(resolved.results).toEqual(results);
      expect(resolved.limitations).toHaveLength(1);
    });

    it('detects a cycle when the loader spells one Windows path two ways', async () => {
      const winFile = String.raw`C:\ws\src\helpers.ts`;
      const oldContent = 'export function moved(a: string): string { return a; }';
      const newContent = 'export * from "./a";';
      const spellings = [String.raw`C:\ws\src\a.ts`, 'c:/ws/src/a.ts'];
      let calls = 0;
      const load = () => {
        const filePath = spellings[calls % 2];
        calls++;
        return Promise.resolve(calls > 4 ? null : { filePath, content: 'export * from "./a";' });
      };
      const results = analyzer.analyzeBreakingChanges(winFile, oldContent, newContent);
      const resolved = await analyzer.resolveReexportedRemovals(winFile, oldContent, newContent, results, load);
      expect(calls).toBe(2);
      expect(resolved.results).toEqual(results);
    });

    it('leaves non-removal results and unexported locals untouched', async () => {
      const oldContent = 'export function kept(a: string): string { return a; }';
      const newContent = 'export function kept(a: number): string { return String(a); }';
      const { load, requested } = loaderFor({});
      const results = analyzer.analyzeBreakingChanges(filePath, oldContent, newContent);
      const resolved = await analyzer.resolveReexportedRemovals(filePath, oldContent, newContent, results, load);
      expect(resolved.results).toEqual(results);
      expect(requested).toEqual([]);
    });
  });

  describe('dropped exports (#517)', () => {
    const filePath = path.join(path.parse(process.cwd()).root, 'ws', 'src', 'lib.ts');
    const removed = (oldContent: string, newContent: string) =>
      analyzer.analyzeBreakingChanges(filePath, oldContent, newContent)
        .filter((result) => result.hasBreakingChanges)
        .map((result) => result.symbolName);

    it.each([
      ['function', 'export function lib(a: number): number { return a; }', 'function lib(a: number): number { return a; }', 'lib'],
      ['const', 'export const cst = 1;', 'const cst = 1;', 'cst'],
      ['arrow function', 'export const run = (a: number) => a;', 'const run = (a: number) => a;', 'run'],
      ['class', 'export class Box {}', 'class Box {}', 'Box'],
      ['interface', 'export interface Opts { a: string }', 'interface Opts { a: string }', 'Opts'],
      ['type', 'export type Id = string;', 'type Id = string;', 'Id'],
      ['enum', 'export enum Mode { A }', 'enum Mode { A }', 'Mode'],
      ['export list entry', 'function listed() {}\nexport { listed };', 'function listed() {}', 'listed'],
      ['alias removed', 'const a = 1;\nexport { a as b };', 'const a = 1;', 'b'],
      ['alias renamed', 'const a = 1;\nexport { a as b };', 'const a = 1;\nexport { a as c };', 'b'],
      ['default turned named', 'export default function dflt() {}', 'export function dflt() {}', 'default'],
      ['named turned default', 'export function dflt() {}', 'export default function dflt() {}', 'dflt'],
      ['export =', 'const x = 1;\nexport = x;', 'const x = 1;', 'export='],
      ['export * removed from a barrel', "export * from './a';", "export * from './b';", "* from './a'"],
      ['re-export removed from a barrel', "export { a } from './a';\nexport { b } from './b';", "export { b } from './b';", 'a'],
    ])('reports %s', (_label, oldContent, newContent, name) => {
      expect(removed(oldContent, newContent)).toContain(name);
    });

    it('reports a symbol removed entirely once', () => {
      expect(removed('export function gone() {}', '')).toEqual(['gone']);
    });

    it.each([
      ['kept export', 'export function a() {}', 'export function a() {}'],
      ['export list kept', 'const a = 1;\nexport { a };', 'const a = 1;\nexport { a };'],
      ['export moved to an export list', 'export const a = 1;', 'const a = 1;\nexport { a };'],
      ['re-exported through export *', "export * from './a';", "export * from './a';"],
      ['named re-export replaced by export * from the same module', "export { lib } from './lib';", "export * from './lib';"],
      ['non-exported helper removed', 'function helper() {}', ''],
      ['non-exported helper renamed', 'function helper() {}', 'function other() {}'],
    ])('does not report %s', (_label, oldContent, newContent) => {
      expect(removed(oldContent, newContent)).toEqual([]);
    });

    it.each([
      ['a destructured export', 'export const { p, q: r } = obj;', 'const { p, q: r } = obj;', ['p', 'r']],
      ['an emptied file (left to the deletion path)', 'export { a as b };\nexport default 2;', '', []],
      ['a new file', '', 'export const a = 1;', []],
    ])('reports %s', (_label, oldContent, newContent, names) => {
      expect(removed(oldContent, newContent)).toEqual(names);
    });

    it('keeps reporting a declaration that moved behind a re-export; review-pr resolves it with resolveReexportedRemovals', () => {
      expect(removed('export function f() {}', "export { f } from './impl';")).toEqual(['f']);
    });

    it('does not throw on malformed content', () => {
      expect(() => removed('export const a = 1;', 'export {')).not.toThrow();
    });

    it('accepts an alias or default name as symbolName', () => {
      const results = analyzer.analyzeBreakingChanges(filePath, 'const a = 1;\nexport { a as b };\nexport default 2;', 'const a = 1;', 'b');
      expect(results.map((result) => result.symbolName)).toEqual(['b']);
      expect(analyzer.analyzeBreakingChanges(filePath, 'export default 2;', 'const z = 1;', 'default')).toHaveLength(1);
    });
  });
});
