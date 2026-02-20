import fs from "node:fs/promises";
import { Language, Parser } from "web-tree-sitter";

/**
 * Singleton factory for the lifecycle of WASM tree-sitter parsers.
 * - Initializes core `tree-sitter.wasm` once
 * - Lazily loads language WASM binaries
 * - Caches one parser instance per language
 * - Guards concurrent init/parser creation with shared promises
 *
 * Real WASM execution is expected in VS Code extension host (Electron).
 * In unit tests, mock `web-tree-sitter` or `WasmParserFactory`.
 *
 * @see {@link https://github.com/tree-sitter/tree-sitter/tree/master/lib/binding_web | web-tree-sitter documentation}
 */
export class WasmParserFactory {
  private static instance: WasmParserFactory | null = null;
  private initPromise: Promise<void> | null = null;
  private readonly parsers: Map<string, Parser> = new Map();
  private readonly parserPromises: Map<string, Promise<Parser>> = new Map();
  private readonly languages: Map<string, Language> = new Map();
  private initialized = false;
  private readonly textEncoder = new TextEncoder();

  /**
   * Private constructor to enforce singleton pattern
   */
  private constructor() {}

  /**
   * Get singleton instance of WasmParserFactory
   * @returns The singleton instance
   */
  static getInstance(): WasmParserFactory {
    WasmParserFactory.instance ??= new WasmParserFactory();
    return WasmParserFactory.instance;
  }

  /**
   * Initialize web-tree-sitter with the core WASM file
   * This must be called before creating any parsers
   * Safe to call multiple times - subsequent calls wait for the same initialization
   * 
   * @param wasmPath - Absolute path to tree-sitter.wasm file
   * @throws Error if initialization fails or WASM file is missing/corrupted
   */
  async init(wasmPath: string): Promise<void> {
    // If already initialized, return immediately
    if (this.initialized) {
      return;
    }

    // If initialization is in progress, wait for it
    if (this.initPromise) {
      return this.initPromise;
    }

    // Start initialization
    this.initPromise = (async () => {
      try {
        await Parser.init({
          locateFile: () => wasmPath,
        });
        this.initialized = true;
      } catch (error) {
        // Clear the promise so retry is possible
        this.initPromise = null;
        
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new Error(
          `Failed to initialize web-tree-sitter from ${wasmPath}: ${errorMessage}. ` +
          `Ensure the WASM file exists and is not corrupted.`
        );
      }
    })();

    await this.initPromise;
  }

  /**
   * Create or get cached parser for a language
   * Automatically loads the language WASM if not already loaded
   * Safe to call concurrently - ensures only one parser is created per language
   * 
   * @param languageName - Language identifier (e.g., 'python', 'rust')
   * @param wasmPath - Absolute path to language WASM file (e.g., tree-sitter-python.wasm)
   * @returns Parser instance configured for the specified language
   * @throws Error if factory is not initialized or language loading fails
   */
  async getParser(languageName: string, wasmPath: string): Promise<Parser> {
    if (!this.initialized) {
      throw new Error(
        "WasmParserFactory must be initialized with init() before creating parsers"
      );
    }

    // Return cached parser if available
    if (this.parsers.has(languageName)) {
      return this.parsers.get(languageName)!;
    }

    // If parser creation is in progress, wait for it
    if (this.parserPromises.has(languageName)) {
      return this.parserPromises.get(languageName)!;
    }

    // Start parser creation
    const parserPromise = (async () => {
      try {
        // Load language if not already loaded
        if (!this.languages.has(languageName)) {
          await this.loadLanguage(languageName, wasmPath);
        }

        // Create new parser with the language
        const parser = new Parser();
        const language = this.languages.get(languageName)!;
        parser.setLanguage(language);

        // Cache the parser
        this.parsers.set(languageName, parser);

        return parser;
      } finally {
        // Clear the promise so subsequent calls use the cached parser
        this.parserPromises.delete(languageName);
      }
    })();

    // Cache the promise to handle concurrent requests
    this.parserPromises.set(languageName, parserPromise);

    return parserPromise;
  }

  /**
   * Load a language WASM file
   * 
   * @param languageName - Language identifier for caching
   * @param wasmPath - Absolute path to language WASM file
   * @throws Error if language loading fails or WASM file is missing/corrupted
   */
  private async loadLanguage(
    languageName: string,
    wasmPath: string
  ): Promise<void> {
    try {
      let language: Language;

      try {
        // Prefer loading bytes from disk so we can patch legacy dylink metadata when needed.
        const wasmBinary = await fs.readFile(wasmPath);
        const normalizedBinary = this.normalizeLegacyDylinkSection(new Uint8Array(wasmBinary));
        language = await Language.load(normalizedBinary);
      } catch (readOrNormalizeError) {
        // Test suites often mock Language.load and pass synthetic paths that don't exist on disk.
        // In that case, fall back to path-based loading so mocked behavior stays compatible.
        const errorMessage = readOrNormalizeError instanceof Error
          ? readOrNormalizeError.message
          : String(readOrNormalizeError);

        if (errorMessage.includes("ENOENT") || errorMessage.includes("not found")) {
          language = await Language.load(wasmPath);
        } else {
          throw readOrNormalizeError;
        }
      }

      this.languages.set(languageName, language);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      
      // Provide helpful error messages based on common failure modes
      if (errorMessage.includes("ENOENT") || errorMessage.includes("not found")) {
        throw new Error(
          `Language WASM file not found: ${wasmPath}. ` +
          `Ensure the extension is properly installed and WASM files are in the dist directory.`
        );
      } else if (errorMessage.includes("magic") || errorMessage.includes("invalid")) {
        throw new Error(
          `Failed to load language WASM from ${wasmPath}: ${errorMessage}. ` +
          `The WASM file may be corrupted. Try reinstalling the extension.`
        );
      } else {
        throw new Error(
          `Failed to load language WASM from ${wasmPath}: ${errorMessage}`
        );
      }
    }
  }

  /**
   * Convert legacy `dylink` custom section format to modern `dylink.0`.
   *
   * Some prebuilt tree-sitter language binaries still ship with the legacy
   * Emscripten `dylink` section, while web-tree-sitter@0.26+ expects `dylink.0`.
   * This compatibility shim rewrites the first custom section when needed.
   */
  private normalizeLegacyDylinkSection(binary: Uint8Array): Uint8Array {
    try {
      // WebAssembly magic number + version header (8 bytes)
      if (
        binary.length < 12 ||
        binary[0] !== 0x00 ||
        binary[1] !== 0x61 ||
        binary[2] !== 0x73 ||
        binary[3] !== 0x6d
      ) {
        return binary;
      }

      // First section must be custom (id = 0) for legacy dylink format.
      const firstSectionIdOffset = 8;
      if (binary[firstSectionIdOffset] !== 0x00) {
        return binary;
      }

      const sectionSizeLeb = this.readUnsignedLeb128(binary, firstSectionIdOffset + 1);
      const sectionPayloadStart = sectionSizeLeb.nextOffset;
      const sectionPayloadEnd = sectionPayloadStart + sectionSizeLeb.value;
      if (sectionPayloadEnd > binary.length) {
        return binary;
      }

      const sectionNameLenLeb = this.readUnsignedLeb128(binary, sectionPayloadStart);
      const sectionNameStart = sectionNameLenLeb.nextOffset;
      const sectionNameEnd = sectionNameStart + sectionNameLenLeb.value;
      if (sectionNameEnd > sectionPayloadEnd) {
        return binary;
      }

      const sectionName = Buffer.from(binary.subarray(sectionNameStart, sectionNameEnd)).toString(
        "utf8"
      );

      // Already modern or unrelated section.
      if (sectionName !== "dylink") {
        return binary;
      }

      let cursor = sectionNameEnd;
      const memorySize = this.readUnsignedLeb128(binary, cursor);
      cursor = memorySize.nextOffset;
      const memoryAlign = this.readUnsignedLeb128(binary, cursor);
      cursor = memoryAlign.nextOffset;
      const tableSize = this.readUnsignedLeb128(binary, cursor);
      cursor = tableSize.nextOffset;
      const tableAlign = this.readUnsignedLeb128(binary, cursor);
      cursor = tableAlign.nextOffset;
      const neededDynlibsCount = this.readUnsignedLeb128(binary, cursor);
      cursor = neededDynlibsCount.nextOffset;

      const neededDynlibs: Uint8Array[] = [];
      for (let i = 0; i < neededDynlibsCount.value; i++) {
        const libNameLen = this.readUnsignedLeb128(binary, cursor);
        cursor = libNameLen.nextOffset;
        const libNameEnd = cursor + libNameLen.value;
        if (libNameEnd > sectionPayloadEnd) {
          return binary;
        }
        neededDynlibs.push(binary.subarray(cursor, libNameEnd));
        cursor = libNameEnd;
      }

      const memoryInfoSubsectionData = this.concatUint8Arrays(
        this.encodeUnsignedLeb128(memorySize.value),
        this.encodeUnsignedLeb128(memoryAlign.value),
        this.encodeUnsignedLeb128(tableSize.value),
        this.encodeUnsignedLeb128(tableAlign.value)
      );

      const neededSubsectionData = this.concatUint8Arrays(
        this.encodeUnsignedLeb128(neededDynlibs.length),
        ...neededDynlibs.flatMap((lib) => [this.encodeUnsignedLeb128(lib.length), lib])
      );

      // Subsection types from the wasm dynamic linking tool convention.
      const DYNAMIC_LINKING_MEM_INFO_SUBSECTION = 1;
      const DYNAMIC_LINKING_NEEDED_SUBSECTION = 2;

      const memInfoSubsection = this.concatUint8Arrays(
        Uint8Array.of(DYNAMIC_LINKING_MEM_INFO_SUBSECTION),
        this.encodeUnsignedLeb128(memoryInfoSubsectionData.length),
        memoryInfoSubsectionData
      );

      const neededSubsection = this.concatUint8Arrays(
        Uint8Array.of(DYNAMIC_LINKING_NEEDED_SUBSECTION),
        this.encodeUnsignedLeb128(neededSubsectionData.length),
        neededSubsectionData
      );

      const modernSectionName = this.textEncoder.encode("dylink.0");
      const modernSectionPayload = this.concatUint8Arrays(
        this.encodeUnsignedLeb128(modernSectionName.length),
        modernSectionName,
        memInfoSubsection,
        neededSubsection
      );

      const rewrittenCustomSection = this.concatUint8Arrays(
        Uint8Array.of(0x00),
        this.encodeUnsignedLeb128(modernSectionPayload.length),
        modernSectionPayload
      );

      return this.concatUint8Arrays(
        binary.subarray(0, 8),
        rewrittenCustomSection,
        binary.subarray(sectionPayloadEnd)
      );
    } catch {
      // If rewrite fails for any reason, let standard loading attempt the original binary.
      return binary;
    }
  }

  private readUnsignedLeb128(
    data: Uint8Array,
    startOffset: number
  ): { value: number; nextOffset: number } {
    let value = 0;
    let shift = 0;
    let offset = startOffset;

    while (offset < data.length) {
      const byte = data[offset];
      value |= (byte & 0x7f) << shift;
      offset++;
      if ((byte & 0x80) === 0) {
        return { value, nextOffset: offset };
      }
      shift += 7;
      if (shift > 35) {
        throw new Error("Invalid LEB128 value");
      }
    }

    throw new Error("Unexpected EOF while reading LEB128");
  }

  private encodeUnsignedLeb128(value: number): Uint8Array {
    const bytes: number[] = [];
    let remaining = value >>> 0;

    do {
      let byte = remaining & 0x7f;
      remaining >>>= 7;
      if (remaining !== 0) {
        byte |= 0x80;
      }
      bytes.push(byte);
    } while (remaining !== 0);

    return Uint8Array.from(bytes);
  }

  private concatUint8Arrays(...arrays: Uint8Array[]): Uint8Array {
    const total = arrays.reduce((sum, array) => sum + array.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;

    for (const array of arrays) {
      merged.set(array, offset);
      offset += array.length;
    }

    return merged;
  }

  /**
   * Check if the factory has been initialized
   * @returns true if init() has completed successfully
   */
  isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Reset the factory state (primarily for testing)
   * Clears all cached parsers and languages
   */
  reset(): void {
    this.parsers.clear();
    this.parserPromises.clear();
    this.languages.clear();
    this.initialized = false;
    this.initPromise = null;
  }
}
