import { GoogleGenAI } from '@google/genai';
import fs from 'fs';
import Groq from 'groq-sdk';

import { ENV } from '../../config/env';
import { StoredFileRecord } from '../../types/models';

// `pdf-parse/lib/pdf-parse.js` évite le mode debug de l'index du paquet (lecture d'un PDF de test).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require('pdf-parse/lib/pdf-parse.js');

/* -------------------------------------------------------------------------- */
/*                                   Types                                    */
/* -------------------------------------------------------------------------- */

export const TRANSCRIPT_LANGUAGES = ['fr', 'en', 'es', 'de', 'it', 'pt', 'ar'] as const;
export type TranscriptLanguage = (typeof TRANSCRIPT_LANGUAGES)[number];

export function isTranscriptLanguage(value: unknown): value is TranscriptLanguage {
  return typeof value === 'string' && (TRANSCRIPT_LANGUAGES as readonly string[]).includes(value);
}

export interface TranscriptParagraph {
  id: number;
  title?: string;
  text: string;
  startTimeSec: number;
  durationSec: number;
}

/** Origine du texte : extraction directe, OCR IA d'un scan, ou fiche de synthèse de secours. */
export type TranscriptExtraction = 'text' | 'ocr' | 'summary';

export interface TranscriptResult {
  fileId: string;
  cleanTitle: string;
  fileName: string;
  docType: string;
  folderName: string;
  /** Langue du texte renvoyé */
  language: TranscriptLanguage;
  /** Langue détectée du document d'origine (null si indéterminée) */
  sourceLanguage: TranscriptLanguage | null;
  translated: boolean;
  extraction: TranscriptExtraction;
  /** Message informatif à afficher (ex : traduction indisponible) */
  notice: string | null;
  totalDurationSec: number;
  paragraphsCount: number;
  paragraphs: TranscriptParagraph[];
}

interface RawParagraph {
  title?: string;
  text: string;
}

interface BaseTranscript {
  paragraphs: RawParagraph[];
  extraction: TranscriptExtraction;
  sourceLanguage: TranscriptLanguage | null;
}

/* -------------------------------------------------------------------------- */
/*                                 Constantes                                 */
/* -------------------------------------------------------------------------- */

const MAX_PAGES_TO_PARSE = 40;
const MAX_PARAGRAPHS = 80;
const TARGET_PARAGRAPH_WORDS = 70;
const MAX_PARAGRAPH_WORDS = 120;
/** ~155 mots/minute : débit moyen d'une voix de synthèse à vitesse 1.0 */
const WORDS_PER_SECOND = 2.6;
const MIN_WORDS_FOR_TEXT_PDF = 30;
const MAX_OCR_BYTES = 15 * 1024 * 1024;
const TRANSLATION_BATCH_SIZE = 8;
const CACHE_MAX_ENTRIES = 60;

const GEMINI_MODELS = ['gemini-3.1-flash-lite', 'gemini-3.8-flash'] as const;
const GROQ_MODEL = 'openai/gpt-oss-120b';

const LANGUAGE_NAMES: Record<TranscriptLanguage, string> = {
  fr: 'français',
  en: 'anglais',
  es: 'espagnol',
  de: 'allemand',
  it: 'italien',
  pt: 'portugais',
  ar: 'arabe',
};

/* -------------------------------------------------------------------------- */
/*                                   Cache                                    */
/* -------------------------------------------------------------------------- */

const baseCache = new Map<string, BaseTranscript>();
const translationCache = new Map<string, RawParagraph[]>();

function rememberInCache<T>(cache: Map<string, T>, key: string, value: T): void {
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  cache.set(key, value);
}

/** À appeler quand un fichier est supprimé pour libérer la mémoire. */
export function forgetTranscript(fileId: string): void {
  baseCache.delete(fileId);
  for (const key of translationCache.keys()) {
    if (key.startsWith(`${fileId}:`)) translationCache.delete(key);
  }
}

/* -------------------------------------------------------------------------- */
/*                         Nettoyage & découpage du texte                     */
/* -------------------------------------------------------------------------- */

const HEADING_PATTERN =
  /^(chapitre|chapter|partie|part|section|introduction|conclusion|r[ée]sum[ée]|objectifs?|d[ée]finitions?|exercices?|annexe)\b/i;
const NUMBERED_HEADING_PATTERN = /^((\d+(\.\d+)*)|[IVXLC]+|[A-Z])[.)]\s+\S/;

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

function isLikelyHeading(line: string): boolean {
  if (line.length < 3 || line.length > 80) return false;
  if (/[.,;:!?]$/.test(line)) return false;
  if (HEADING_PATTERN.test(line) || NUMBERED_HEADING_PATTERN.test(line)) return true;
  const letters = line.replace(/[^A-Za-zÀ-ÿ]/g, '');
  return letters.length >= 4 && letters === letters.toUpperCase() && countWords(line) <= 10;
}

function isNoiseLine(line: string): boolean {
  // Numéros de page, « Page 3 / 12 », séparateurs graphiques
  return /^(page\s*)?\d{1,4}(\s*(\/|sur|of)\s*\d{1,4})?$/i.test(line) || /^[\s\-_=*•.·]+$/.test(line);
}

function splitSentences(text: string): string[] {
  const parts = text.match(/[^.!?…]+(?:[.!?…]+["»”)\]]*|$)/g) || [text];
  return parts.map((s) => s.trim()).filter(Boolean);
}

/** Découpe un bloc trop long en paragraphes de taille confortable à l'écoute. */
function chunkBlock(text: string): string[] {
  if (countWords(text) <= MAX_PARAGRAPH_WORDS) return [text];

  const chunks: string[] = [];
  let current: string[] = [];
  let currentWords = 0;

  for (const sentence of splitSentences(text)) {
    const words = countWords(sentence);
    if (currentWords > 0 && currentWords + words > MAX_PARAGRAPH_WORDS) {
      chunks.push(current.join(' '));
      current = [];
      currentWords = 0;
    }
    current.push(sentence);
    currentWords += words;
    if (currentWords >= TARGET_PARAGRAPH_WORDS) {
      chunks.push(current.join(' '));
      current = [];
      currentWords = 0;
    }
  }
  if (current.length > 0) chunks.push(current.join(' '));
  return chunks;
}

/** Transforme le texte brut d'un PDF en paragraphes propres avec titres détectés. */
export function structureRawText(rawText: string): RawParagraph[] {
  const lines = rawText
    .replace(/\r/g, '')
    .replace(/-\n(?=[a-zà-ÿ])/g, '') // mots coupés en fin de ligne
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim());

  const blocks: RawParagraph[] = [];
  let pendingTitle: string | undefined;
  let buffer: string[] = [];

  const flush = () => {
    const text = buffer.join(' ').trim();
    buffer = [];
    if (countWords(text) < 4) return;
    chunkBlock(text).forEach((chunk, idx) => {
      blocks.push({ title: idx === 0 ? pendingTitle : undefined, text: chunk });
    });
    pendingTitle = undefined;
  };

  for (const line of lines) {
    if (!line) {
      // Ligne vide : fin de paragraphe seulement si le bloc courant se termine par une phrase
      if (buffer.length > 0 && /[.!?…:»"]$/.test(buffer[buffer.length - 1])) flush();
      continue;
    }
    if (isNoiseLine(line)) continue;
    if (isLikelyHeading(line)) {
      flush();
      // Titres consécutifs (ex : « Chapitre 1 » puis « 1. Définitions ») : on garde le plus précis
      const heading = line.length > 60 ? `${line.slice(0, 57)}…` : line;
      pendingTitle = heading;
      continue;
    }
    buffer.push(line);
    // Évite les blocs géants tout en coupant uniquement en fin de phrase
    if (/[.!?…]$/.test(line) && countWords(buffer.join(' ')) >= MAX_PARAGRAPH_WORDS * 2) flush();
  }
  flush();

  return blocks.slice(0, MAX_PARAGRAPHS);
}

/** Détection légère FR / EN par mots-outils (suffisant pour éviter une traduction inutile). */
function detectLanguage(paragraphs: RawParagraph[]): TranscriptLanguage | null {
  const sample = ` ${paragraphs.slice(0, 6).map((p) => p.text).join(' ').toLowerCase()} `;
  const score = (words: string[]) =>
    words.reduce((acc, w) => acc + (sample.split(` ${w} `).length - 1), 0);
  const fr = score(['le', 'la', 'les', 'des', 'est', 'et', 'une', 'du', 'pour', 'dans', 'que']);
  const en = score(['the', 'and', 'is', 'of', 'to', 'in', 'that', 'for', 'with', 'are']);
  if (fr === 0 && en === 0) return null;
  if (fr >= en * 1.5) return 'fr';
  if (en >= fr * 1.5) return 'en';
  return null;
}

function withTimings(paragraphs: RawParagraph[]): {
  paragraphs: TranscriptParagraph[];
  totalDurationSec: number;
} {
  let cursor = 0;
  const timed = paragraphs.map((p, index) => {
    const durationSec = Math.max(3, Math.round(countWords(p.text) / WORDS_PER_SECOND));
    const item: TranscriptParagraph = {
      id: index + 1,
      ...(p.title ? { title: p.title } : {}),
      text: p.text,
      startTimeSec: cursor,
      durationSec,
    };
    cursor += durationSec;
    return item;
  });
  return { paragraphs: timed, totalDurationSec: cursor };
}

/* -------------------------------------------------------------------------- */
/*                               Appels IA                                    */
/* -------------------------------------------------------------------------- */

function parseJson(raw: string): Record<string, unknown> | null {
  const cleaned = (raw || '')
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```(?:json)?\s*([\s\S]*?)\s*```/i, '$1')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function askGemini(
  prompt: string,
  pdfBuffer?: Buffer,
): Promise<Record<string, unknown> | null> {
  if (!ENV.GEMINI_API_KEY) return null;
  const ai = new GoogleGenAI({ apiKey: ENV.GEMINI_API_KEY });
  const contents: Array<Record<string, unknown>> = [{ text: prompt }];
  if (pdfBuffer) {
    contents.push({
      inlineData: { mimeType: 'application/pdf', data: pdfBuffer.toString('base64') },
    });
  }

  for (const model of GEMINI_MODELS) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents,
        config: { responseMimeType: 'application/json' },
      });
      const parsed = parseJson(response.text || '');
      if (parsed) return parsed;
    } catch (err) {
      console.warn(`[Transcript/Gemini/${model}]`, (err as Error).message.slice(0, 140));
    }
  }
  return null;
}

async function askGroq(prompt: string): Promise<Record<string, unknown> | null> {
  if (!ENV.GROQ_API_KEY) return null;
  try {
    const groq = new Groq({ apiKey: ENV.GROQ_API_KEY });
    const completion = await groq.chat.completions.create({
      model: GROQ_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'You are a professional translator. You must output strictly valid JSON with root object containing key "items": {"items":[{"title":"...","text":"..."}]}.',
        },
        { role: 'user', content: prompt },
      ],
      response_format: { type: 'json_object' },
      max_tokens: 4096,
      temperature: 0.1,
    });
    return parseJson(completion.choices[0]?.message?.content || '');
  } catch (err) {
    console.warn('[Transcript/Groq]', (err as Error).message.slice(0, 140));
    return null;
  }
}

async function askOpenRouter(prompt: string): Promise<Record<string, unknown> | null> {
  if (!ENV.OPENROUTER_API_KEY) return null;
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ENV.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
      }),
    });
    const data = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const content = data?.choices?.[0]?.message?.content || '';
    return parseJson(content);
  } catch (err) {
    console.warn('[Transcript/OpenRouter]', (err as Error).message.slice(0, 140));
    return null;
  }
}

function readParagraphArray(value: unknown): RawParagraph[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): RawParagraph | null => {
      if (typeof item === 'string') return { text: item.trim() };
      if (item && typeof item === 'object' && typeof (item as RawParagraph).text === 'string') {
        const { title, text } = item as RawParagraph;
        return { title: typeof title === 'string' && title.trim() ? title.trim() : undefined, text: text.trim() };
      }
      return null;
    })
    .filter((p): p is RawParagraph => Boolean(p && p.text));
}

/** OCR d'un PDF scanné via Gemini multimodal. */
async function transcribeScannedPdf(buffer: Buffer): Promise<RawParagraph[]> {
  if (buffer.length > MAX_OCR_BYTES) return [];
  const prompt = `Tu es un moteur OCR. Transcris fidèlement le texte lisible de ce document PDF, dans sa langue d'origine, sans le résumer ni le traduire.
Regroupe le texte en paragraphes cohérents (40 à 120 mots). Si un titre précède un paragraphe, place-le dans "title".
Ignore les numéros de page, en-têtes et pieds de page répétitifs.
Réponds STRICTEMENT avec ce JSON : {"paragraphs":[{"title":"Titre optionnel","text":"Texte du paragraphe"}]}`;
  const parsed = await askGemini(prompt, buffer);
  return readParagraphArray(parsed?.paragraphs).slice(0, MAX_PARAGRAPHS);
}

async function translateBatch(
  batch: RawParagraph[],
  target: TranscriptLanguage,
): Promise<RawParagraph[] | null> {
  const payload = JSON.stringify(batch.map((p) => ({ title: p.title || '', text: p.text })));
  const prompt = `You are an expert academic translator. Translate each item in the following JSON array into ${LANGUAGE_NAMES[target]}.
Preserve the exact same order and count of items. Keep formulas, code, numbers, acronyms, and proper names intact.
Return STRICTLY valid JSON with key "items":
{"items":[{"title":"...","text":"..."}]}

Input array:
${payload}`;

  const parsed =
    (await askGroq(prompt)) || (await askOpenRouter(prompt)) || (await askGemini(prompt));
  let items = readParagraphArray(parsed?.items);
  if (items.length === 0) return null;
  if (items.length < batch.length) {
    for (let i = items.length; i < batch.length; i++) {
      items.push(batch[i]);
    }
  } else if (items.length > batch.length) {
    items = items.slice(0, batch.length);
  }
  return items;
}

async function translateParagraphs(
  paragraphs: RawParagraph[],
  target: TranscriptLanguage,
): Promise<RawParagraph[] | null> {
  const batches: RawParagraph[][] = [];
  for (let i = 0; i < paragraphs.length; i += TRANSLATION_BATCH_SIZE) {
    batches.push(paragraphs.slice(i, i + TRANSLATION_BATCH_SIZE));
  }
  const results: RawParagraph[][] = [];
  for (const b of batches) {
    const res = await translateBatch(b, target);
    if (!res) return null;
    results.push(res);
  }
  return results.flat();
}

/* -------------------------------------------------------------------------- */
/*                              Extraction de base                            */
/* -------------------------------------------------------------------------- */

function buildSummaryFallback(record: StoredFileRecord): RawParagraph[] {
  const folder = record.folderName.replace(/_/g, ' ');
  const title = record.cleanTitle.replace(/_/g, ' ');
  return [
    {
      title: 'À propos du document',
      text: `Vous écoutez la fiche du document « ${title} », de type ${record.docType}, classé dans le dossier ${folder}.`,
    },
    {
      title: 'Texte non lisible',
      text: `Ce PDF semble être un scan ou une image : son texte n'a pas pu être extrait automatiquement. Ouvrez le document original pour consulter son contenu complet.`,
    },
    {
      title: 'Origine',
      text: `Ce fichier provient de votre discussion WhatsApp « ${record.sourceName} ».`,
    },
  ];
}

async function extractBaseTranscript(record: StoredFileRecord): Promise<BaseTranscript> {
  const cached = baseCache.get(record.id);
  if (cached) return cached;

  let buffer: Buffer | null = null;
  if (record.tempPath && fs.existsSync(record.tempPath)) {
    buffer = fs.readFileSync(record.tempPath);
  }

  let paragraphs: RawParagraph[] = [];
  let extraction: TranscriptExtraction = 'text';

  if (buffer) {
    try {
      const parsed = await pdfParse(buffer, { max: MAX_PAGES_TO_PARSE });
      paragraphs = structureRawText(String(parsed.text || ''));
    } catch {
      paragraphs = [];
    }

    const totalWords = paragraphs.reduce((acc, p) => acc + countWords(p.text), 0);
    if (totalWords < MIN_WORDS_FOR_TEXT_PDF) {
      const ocr = await transcribeScannedPdf(buffer);
      if (ocr.length > 0) {
        paragraphs = ocr;
        extraction = 'ocr';
      }
    }
  }

  if (paragraphs.length === 0) {
    paragraphs = buildSummaryFallback(record);
    extraction = 'summary';
  }

  const base: BaseTranscript = {
    paragraphs,
    extraction,
    sourceLanguage: extraction === 'summary' ? 'fr' : detectLanguage(paragraphs),
  };
  // Les fiches de secours ne sont pas mises en cache : le fichier peut redevenir disponible.
  if (extraction !== 'summary') rememberInCache(baseCache, record.id, base);
  return base;
}

/* -------------------------------------------------------------------------- */
/*                                 API publique                               */
/* -------------------------------------------------------------------------- */

/**
 * Construit la transcription d'un PDF prête pour le lecteur audio :
 * extraction (texte ou OCR), découpage en paragraphes minutés, puis traduction optionnelle.
 */
export async function buildTranscript(
  record: StoredFileRecord,
  requestedLanguage: TranscriptLanguage | null,
): Promise<TranscriptResult> {
  const base = await extractBaseTranscript(record);

  let paragraphs = base.paragraphs;
  let language: TranscriptLanguage = base.sourceLanguage || 'fr';
  let translated = false;
  let notice: string | null = null;

  const needsTranslation =
    requestedLanguage !== null && requestedLanguage !== base.sourceLanguage;

  if (needsTranslation && requestedLanguage) {
    const cacheKey = `${record.id}:${requestedLanguage}`;
    const cachedTranslation = translationCache.get(cacheKey);
    const translation = cachedTranslation || (await translateParagraphs(paragraphs, requestedLanguage));

    if (translation) {
      if (!cachedTranslation && base.extraction !== 'summary') {
        rememberInCache(translationCache, cacheKey, translation);
      }
      paragraphs = translation;
      language = requestedLanguage;
      translated = true;
    } else {
      notice = `Traduction en ${LANGUAGE_NAMES[requestedLanguage]} indisponible pour le moment : lecture dans la langue d'origine.`;
    }
  }

  if (base.extraction === 'ocr' && !notice) {
    notice = 'Document scanné : texte reconnu automatiquement par IA.';
  }

  const timed = withTimings(paragraphs);

  return {
    fileId: record.id,
    cleanTitle: record.cleanTitle,
    fileName: record.fileName,
    docType: record.docType,
    folderName: record.folderName,
    language,
    sourceLanguage: base.sourceLanguage,
    translated,
    extraction: base.extraction,
    notice,
    totalDurationSec: timed.totalDurationSec,
    paragraphsCount: timed.paragraphs.length,
    paragraphs: timed.paragraphs,
  };
}
