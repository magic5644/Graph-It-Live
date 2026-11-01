/**
 * Multilingual keyword extraction for natural-language code queries (EN, FR, DE, ES,
 * ZH, RU), shared by QueryEngine (`query`) and GraphContextScorer (`context`).
 *
 * NO vscode import — pure Node.js analyzer layer.
 *
 * Pipeline: CJK glossary terms → Intl.Segmenter words → identifier split → accent
 * folding → glossary (non-English stems → English identifier stems) → stopwords and
 * short Latin/Cyrillic tokens removed. Unknown words pass through unchanged.
 */

import { splitIdentifier } from '@/analyzer/callgraph/CallGraphQuery';
import { CODE_GLOSSARY } from './glossary';
import { STOPWORDS_BY_LANGUAGE } from './stopwords';

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const MIN_KEYWORD_LENGTH = 3;
const MIN_PREFIX_STEM = 4;
const MIN_INFIX_STEM = 5;
const MIN_COMPOUND_LENGTH = 10;
// Code noise the natural-language lists do not cover.
const CODE_STOPWORDS = 'src dist index utils types test spec impl function class method interface export import default const return async await';

/** Lowercase and strip combining marks: `Références` → `references`. */
export function foldAccents(text: string): string {
  return text.normalize('NFD').replaceAll(/\p{M}/gu, '').toLowerCase();
}

const STOPWORDS = new Set(
  [...Object.values(STOPWORDS_BY_LANGUAGE), CODE_STOPWORDS].flatMap(list => list.split(' ')),
);
const STEM_TARGETS = buildStemTargets();
const WORD_STEMS = [...STEM_TARGETS.keys()].filter(stem => !CJK.test(stem));
// Longest first so 调用者 (caller) wins over 调用 (call).
const CJK_REPLACEMENTS = [...STEM_TARGETS.entries()]
  .filter(([stem]) => CJK.test(stem))
  .sort(([left], [right]) => right.length - left.length)
  .map(([stem, targets]): [string, string] => [stem, ` ${targets.join(' ')} `]);
const WORD_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'word' });

function buildStemTargets(): Map<string, string[]> {
  const stemTargets = new Map<string, string[]>();
  for (const [targets, stems] of CODE_GLOSSARY) {
    for (const stem of stems.split(' ')) {
      const key = foldAccents(stem);
      stemTargets.set(key, [...(stemTargets.get(key) ?? []), ...targets.split(' ')]);
    }
  }
  return stemTargets;
}

/** True for a natural-language or code stopword, in any of the six languages. */
export function isQueryStopword(word: string): boolean {
  return STOPWORDS.has(foldAccents(word));
}

/**
 * Every question term after segmentation, folding and glossary mapping, stopwords
 * included: intent checks (`call`, `test`) need them even when they are not searched.
 */
export function questionTerms(question: string): string[] {
  const text = CJK_REPLACEMENTS.reduce(
    (current, [stem, replacement]) => current.replaceAll(stem, replacement),
    question,
  );
  return [...WORD_SEGMENTER.segment(text)]
    .filter(segment => segment.isWordLike)
    .flatMap(segment => wordTokens(segment.segment))
    .flatMap(termsOf);
}

/** Unique search keywords of a question: English identifier stems where known. */
export function extractQueryKeywords(question: string): string[] {
  return [...new Set(questionTerms(question).filter(isSearchKeyword))];
}

function wordTokens(word: string): string[] {
  return CJK.test(word) ? [word] : splitIdentifier(word).map(foldAccents);
}

function termsOf(token: string): string[] {
  if (STOPWORDS.has(token)) return [token];
  const targets = glossaryTargets(token);
  return targets.length > 0 ? targets : [singular(token)];
}

function glossaryTargets(token: string): string[] {
  const prefixed = WORD_STEMS.filter(stem => stemPrefixes(token, stem));
  // Infix stems only extend a compound that starts with a known stem
  // (`abhangigkeitszyklen` → depend + cycle), never a plain word (`independent`).
  const matched = prefixed.length > 0 && token.length >= MIN_COMPOUND_LENGTH
    ? [...prefixed, ...WORD_STEMS.filter(stem => stem.length >= MIN_INFIX_STEM && token.includes(stem))]
    : prefixed;
  // `appelant` (caller) also prefixes `appel` (call): keep the most specific stem.
  const unique = [...new Set(matched)];
  return unique
    .filter(stem => !unique.some(other => other !== stem && other.includes(stem)))
    .flatMap(stem => STEM_TARGETS.get(stem) ?? []);
}

function stemPrefixes(token: string, stem: string): boolean {
  return token === stem || (stem.length >= MIN_PREFIX_STEM && token.startsWith(stem));
}

/** shortcut: strips one plural `s` only (no `es`/`ies`); a real stemmer if recall suffers. */
function singular(token: string): string {
  const keepS = token.length <= 4 || !token.endsWith('s') || ['ss', 'us', 'is'].some(end => token.endsWith(end));
  return keepS ? token : token.slice(0, -1);
}

function isSearchKeyword(term: string): boolean {
  return !STOPWORDS.has(term) && (term.length >= MIN_KEYWORD_LENGTH || CJK.test(term));
}
