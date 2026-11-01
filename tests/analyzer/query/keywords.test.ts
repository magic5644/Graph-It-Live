import { describe, expect, it } from 'vitest';
import { CODE_GLOSSARY } from '@/analyzer/query/glossary';
import {
  extractQueryKeywords,
  foldAccents,
  isQueryStopword,
  questionTerms,
} from '@/analyzer/query/keywords';
import { STOPWORDS_BY_LANGUAGE } from '@/analyzer/query/stopwords';

const CJK = /\p{Script=Han}/u;

const REFERENCE_QUESTIONS: Record<string, string> = {
  en: 'where are python references computed?',
  fr: 'où est fait le calcul des références python ?',
  de: 'wo werden die Python-Referenzen berechnet?',
  es: '¿dónde se calculan las referencias de python?',
  zh: '在哪里计算Python引用的地方',
  ru: 'где вычисляются ссылки python?',
};

const CYCLE_QUESTIONS: Record<string, string> = {
  en: 'how are dependency cycles detected',
  fr: 'comment sont détectés les cycles de dépendances',
  de: 'wie werden Abhängigkeitszyklen erkannt',
  es: 'cómo se detectan los ciclos de dependencias',
  zh: '如何检测依赖循环',
  ru: 'как обнаруживаются циклы зависимостей',
};

describe('extractQueryKeywords', () => {
  it.each(Object.entries(REFERENCE_QUESTIONS))('maps the %s reference question to English stems', (_lang, question) => {
    const keywords = extractQueryKeywords(question);

    expect(keywords).toEqual(expect.arrayContaining(['reference', 'compute', 'python']));
    expect(keywords.filter(keyword => isQueryStopword(keyword))).toEqual([]);
    expect(keywords.filter(keyword => !CJK.test(keyword) && keyword.length < 3)).toEqual([]);
  });

  it.each(Object.entries(CYCLE_QUESTIONS))('maps the %s cycle question to the same stems', (_lang, question) => {
    expect([...extractQueryKeywords(question)].sort((a, b) => a.localeCompare(b))).toEqual(['cycle', 'depend', 'detect']);
  });

  it('segments Chinese without spaces and prefers the longest glossary term', () => {
    expect(extractQueryKeywords('谁调用了这个函数')).toEqual(['call']);
    expect(extractQueryKeywords('函数的调用者')).toEqual(['caller', 'call']);
  });

  it('keeps Cyrillic words and folds them consistently', () => {
    expect(extractQueryKeywords('поиск настройки кэша')).toEqual(['search', 'find', 'config', 'setting', 'cache']);
    expect(extractQueryKeywords('слой архитектуры')).toEqual(['layer', 'architecture']);
  });

  it('matches regardless of accents and case', () => {
    expect(extractQueryKeywords('RÉFÉRENCES')).toEqual(['reference']);
    expect(extractQueryKeywords('références')).toEqual(extractQueryKeywords('references'));
  });

  it('splits German compounds on known stems', () => {
    expect(extractQueryKeywords('Abhängigkeitszyklen')).toEqual(['depend', 'cycle']);
  });

  it('returns nothing for an empty or stopword-only question', () => {
    expect(extractQueryKeywords('')).toEqual([]);
    expect(extractQueryKeywords('   ?! ')).toEqual([]);
    expect(extractQueryKeywords('the and of le la der die el los и в 的 了')).toEqual([]);
  });

  it('handles mixed scripts and languages in one question', () => {
    expect(extractQueryKeywords('calcul des 引用 ссылки python')).toEqual(['compute', 'calc', 'reference', 'python']);
  });

  it('splits identifiers and drops short Latin tokens', () => {
    expect(extractQueryKeywords('who calls getUserById')).toEqual(['call', 'get', 'user']);
    expect(extractQueryKeywords('normalize_path')).toEqual(['normalize', 'path']);
  });

  it('passes unknown words through, with a light plural strip', () => {
    expect(extractQueryKeywords('frobnicate widgets status')).toEqual(['frobnicate', 'widget', 'status']);
  });

  it('does not map words that only share a short prefix with a stem', () => {
    // `invoca` (call) needs 6 letters: `invoice` shares only 5.
    expect(extractQueryKeywords('invoice service')).toEqual(['invoice', 'service']);
    // 3-letter stems (`тип`) match whole words only.
    expect(extractQueryKeywords('тип')).toEqual(['type']);
    expect(extractQueryKeywords('типография')).toEqual(['типография']);
  });

  it('keeps only the most specific of overlapping stems', () => {
    expect(extractQueryKeywords('appelant')).toEqual(['caller', 'call']);
    expect(extractQueryKeywords('appels')).toEqual(['call']);
  });

  it('matches infix stems only inside long compounds that start with a known stem', () => {
    expect(extractQueryKeywords('Dateizyklen')).toEqual(['file', 'cycle']);
    // Under 10 characters only the prefix counts.
    expect(extractQueryKeywords('Dateizykl')).toEqual(['file']);
    expect(extractQueryKeywords('independent modules invalidate')).toEqual(['independent', 'module', 'invalidate']);
  });

  it('drops code stopwords even when they come from a translation', () => {
    expect(extractQueryKeywords('les fonctions et classes')).toEqual([]);
    expect(extractQueryKeywords('pruebas')).toEqual([]);
  });

  it('keeps every Python, Go, Rust, Java and C# identifier style searchable', () => {
    expect(extractQueryKeywords('compute_references')).toEqual(['compute', 'calc', 'reference']);
    expect(extractQueryKeywords('ComputeReferences')).toEqual(['compute', 'calc', 'reference']);
    expect(extractQueryKeywords('resolve-module-path')).toEqual(['resolve', 'module', 'path']);
  });
});

describe('questionTerms', () => {
  it('keeps stopwords and translated code terms for intent checks', () => {
    expect(questionTerms('les tests')).toEqual(['les', 'test']);
    expect(questionTerms('pruebas')).toEqual(['test']);
    expect(questionTerms('qui appelle')).toEqual(['qui', 'call']);
  });
});

describe('foldAccents / isQueryStopword', () => {
  it('folds accents and lowercases', () => {
    expect(foldAccents('Références Größe Ёлка')).toBe('references große елка');
  });

  it('recognizes stopwords of every language, accent-insensitively', () => {
    for (const word of ['the', 'Après', 'werden', 'Dónde', '的', 'где', 'function']) {
      expect(isQueryStopword(word)).toBe(true);
    }
    for (const word of ['reference', 'get', 'find', 'value']) {
      expect(isQueryStopword(word)).toBe(false);
    }
  });
});

describe('vendored data', () => {
  it('ships the six stopword lists', () => {
    expect(Object.keys(STOPWORDS_BY_LANGUAGE).sort((a, b) => a.localeCompare(b))).toEqual(['de', 'en', 'es', 'fr', 'ru', 'zh']);
  });

  it('never lists a glossary stem as a stopword (it would never match)', () => {
    const stems = CODE_GLOSSARY.flatMap(([, list]) => list.split(' '));
    expect(stems.filter(stem => isQueryStopword(stem))).toEqual([]);
  });
});
