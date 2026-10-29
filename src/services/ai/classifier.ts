import { GoogleGenAI } from '@google/genai';
import Groq from 'groq-sdk';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require('pdf-parse');

import { ENV } from '../../config/env';
import { ClassificationResult } from '../../types/models';

export function slugifyText(input: string): string {
  return (input || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '');
}

const DEFAULT_THEME_KEYWORDS: Record<string, string[]> = {
  Mathematiques: ['math', 'maths', 'algebre', 'analyse', 'matrice', 'probabilite', 'statistique', 'polynome'],
  Droit: ['droit', 'juridique', 'civil', 'commercial', 'contrat', 'legislation', 'travail'],
  Anglais: ['anglais', 'english', 'grammar', 'vocabulary'],
  Informatique: ['algo', 'algorithme', 'programmation', 'python', 'javascript', 'typescript', 'code', 'linux', 'architecture'],
  Reseaux_Telecoms: ['reseau', 'reseaux', 'cisco', 'osi', 'tcp', 'routage', 'telecom', 'fibre', 'modulation'],
  Electronique_Physique: ['electronique', 'physique', 'circuit', 'transistor', 'optique', 'mecanique', 'electricite'],
  Management_Communication: ['teeo', 'leadership', 'communication', 'management', 'entrepreneuriat', 'expression'],
  Factures_Recus: ['facture', 'invoice', 'recu', 'quittance', 'paiement', 'devis', 'bon de commande'],
  Administratif: ['attestation', 'certificat', 'passeport', 'identite', 'inscription', 'programme', 'maquette'],
};

const MAX_PDF_PAGES_TO_PARSE = 2;
const GEMINI_MULTIMODAL_MODELS = ['gemini-3.1-flash-lite', 'gemini-3.8-flash'] as const;
const geminiCooldownUntilMs = new Map<string, number>();

async function extractPdfText(buffer: Buffer): Promise<string> {
  try {
    const parser = typeof pdfParse === 'function' ? pdfParse : pdfParse.default;
    if (typeof parser === 'function') {
      // Lecture limitée aux 2 premières pages (couverture + sommaire/intro) pour accélérer 5x à 10x les gros PDF
      const result = await parser(buffer, { max: MAX_PDF_PAGES_TO_PARSE });
      return String(result.text || '').replace(/\s+/g, ' ').trim();
    }
  } catch (_) {
    // PDF scanné ou protégé : l'IA multimodale prendra le relais
  }
  return '';
}

function classifyByFastRules(
  text: string,
  fileName: string,
  caption: string,
  sourceName: string,
  existingFolders: string[],
): ClassificationResult {
  const combined = `${fileName} ${caption} ${sourceName} ${text.slice(0, 1200)}`.toLowerCase();

  // 1. Priorité aux dossiers déjà créés par l'utilisateur s'il y a correspondance directe
  for (const folder of existingFolders) {
    const cleanFolder = slugifyText(folder).replace(/_/g, ' ').toLowerCase();
    if (cleanFolder.length >= 3 && combined.includes(cleanFolder)) {
      return {
        ignore: false,
        folderName: slugifyText(folder),
        docType: detectDocType(combined),
        cleanTitle: buildCleanTitle(fileName, caption),
      };
    }
  }

  // 2. Correspondance par thèmes généraux
  let bestFolder = 'Autres_Documents';
  let bestScore = 0;

  for (const [folder, keywords] of Object.entries(DEFAULT_THEME_KEYWORDS)) {
    let score = 0;
    for (const kw of keywords) {
      if (fileName.toLowerCase().includes(kw)) score += 10;
      if (caption.toLowerCase().includes(kw)) score += 6;
      if (combined.includes(kw)) score += 2;
    }
    if (score > bestScore) {
      bestScore = score;
      bestFolder = folder;
    }
  }

  const docType = detectDocType(combined);
  if (docType === 'Livre') {
    bestFolder = 'Livres';
  }

  return {
    ignore: false,
    folderName: bestFolder,
    docType,
    cleanTitle: buildCleanTitle(fileName, caption),
  };
}

function detectDocType(combinedLower: string): ClassificationResult['docType'] {
  if (/\b(examen|partiel|devoir|controle|corrige|epreuve)\b/i.test(combinedLower)) return 'Examen';
  if (/\b(td|travaux diriges|exercices?)\b/i.test(combinedLower)) return 'TD';
  if (/\b(tp|travaux pratiques|lab)\b/i.test(combinedLower)) return 'TP';
  if (/\b(facture|invoice|recu|devis|quittance)\b/i.test(combinedLower)) return 'Facture';
  if (/\b(livre|textbook|manuel|ebook|isbn|tome)\b/i.test(combinedLower)) return 'Livre';
  if (/\b(cours|chapitre|syllabus)\b/i.test(combinedLower)) return 'Cours';
  if (/\b(attestation|certificat|contrat|administratif)\b/i.test(combinedLower)) return 'Administratif';
  return 'Document';
}

function buildCleanTitle(fileName: string, caption: string): string {
  const strippedName = (fileName || '').replace(/\.[a-z0-9]{2,5}$/i, '');
  const isGenericWaCode = /^(doc|img|vid|aud|ptt|wa|scan|document)[-_\s0-9a-z]*$/i.test(
    strippedName,
  );
  const preferred = isGenericWaCode && caption.trim() ? caption.trim() : strippedName || caption;
  return slugifyText(preferred.slice(0, 48)) || 'Document';
}

function parseJsonResponse(raw: string): Record<string, unknown> | null {
  if (!raw) return null;
  const cleaned = raw
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/```(?:json)?\s*([\s\S]*?)\s*```/i, '$1')
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch (_) {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1));
      } catch (_) {}
    }
  }
  return null;
}

function buildDynamicPrompt(params: {
  fileName: string;
  caption: string;
  sourceName: string;
  extractedText: string;
  existingFolders: string[];
}): string {
  const foldersHint =
    params.existingFolders.length > 0
      ? `Dossiers déjà utilisés par l'utilisateur (réutilise l'un d'eux si pertinent, sinon crée un nom de dossier court et clair en français sans espace) : ${params.existingFolders.join(', ')}`
      : `Choisis un nom de dossier thématique court, propre et intuitif en français (ex: Mathematiques, Droit, Informatique, Reseaux, Factures, Administratif, Projets, Livres, Cours_Generaux).`;

  return `Tu es l'assistant IA de l'application mobile Wapier qui classe automatiquement les fichiers PDF WhatsApp de l'utilisateur.
${foldersHint}

Règles :
1. Ignore ("ignore": true) UNIQUEMENT les prospectus ou publicités PDF commerciales sans aucune valeur documentaire.
2. Ne rejette JAMAIS un cours, TD, TP, examen, facture, reçu, livre ou document PDF de travail.
3. Donne un titre court, lisible et propre sans extension ("cleanTitle").

Données du fichier PDF :
- Discussion d'origine : "${params.sourceName}"
- Nom original : "${params.fileName}"
- Légende WhatsApp : "${params.caption}"
${params.extractedText ? `- Extrait du contenu :\n${params.extractedText.slice(0, 2800)}` : ''}

Réponds STRICTEMENT avec ce JSON :
{
  "ignore": false,
  "folderName": "Nom_Du_Dossier",
  "docType": "Cours|TD|TP|Examen|Facture|Administratif|Livre|Document",
  "cleanTitle": "Titre_Propre_Du_Fichier"
}`;
}

function hasDescriptiveMetadata(fileName: string, caption: string): boolean {
  const strippedName = (fileName || '').replace(/\.[a-z0-9]{2,5}$/i, '').trim();
  const isGenericWaCode = /^(doc|img|vid|aud|ptt|wa|scan|document)[-_\s0-9a-z]*$/i.test(
    strippedName,
  );
  if (!isGenericWaCode && strippedName.length >= 6) {
    return true;
  }
  return caption.trim().length >= 12;
}

async function tryGroqClassification(
  prompt: string,
  originalFileName: string,
  caption: string,
): Promise<ClassificationResult | null> {
  if (!ENV.GROQ_API_KEY) return null;
  try {
    const groq = new Groq({ apiKey: ENV.GROQ_API_KEY });
    const completion = await groq.chat.completions.create({
      model: 'openai/gpt-oss-120b',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
    });

    const parsed = parseJsonResponse(completion.choices[0]?.message?.content || '');
    if (parsed && typeof parsed.folderName === 'string') {
      return normalizeAiResult(parsed, originalFileName, caption);
    }
  } catch (err) {
    console.warn('[AI/Groq] Repli vers fournisseur suivant :', (err as Error).message);
  }
  return null;
}

async function tryGeminiClassification(
  prompt: string,
  buffer: Buffer,
  attachPdfMultimodal: boolean,
  originalFileName: string,
  caption: string,
): Promise<ClassificationResult | null> {
  if (!ENV.GEMINI_API_KEY) return null;
  const ai = new GoogleGenAI({ apiKey: ENV.GEMINI_API_KEY });

  for (const modelName of GEMINI_MULTIMODAL_MODELS) {
    const cooldownUntil = geminiCooldownUntilMs.get(modelName) || 0;
    if (Date.now() < cooldownUntil) {
      continue;
    }

    try {
      const contents: Array<Record<string, unknown>> = [{ text: prompt }];

      if (attachPdfMultimodal && buffer.length <= 12 * 1024 * 1024) {
        contents.push({
          inlineData: {
            mimeType: 'application/pdf',
            data: buffer.toString('base64'),
          },
        });
      }

      const response = await ai.models.generateContent({
        model: modelName,
        contents,
        config: { responseMimeType: 'application/json' },
      });

      const parsed = parseJsonResponse(response.text || '');
      if (parsed && typeof parsed.folderName === 'string') {
        return normalizeAiResult(parsed, originalFileName, caption);
      }
    } catch (err) {
      const msg = (err as Error).message || '';
      if (msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED')) {
        // Coupe-circuit automatique de 15 minutes sur ce modèle si le quota gratuit est atteint (0 ms perdu ensuite)
        geminiCooldownUntilMs.set(modelName, Date.now() + 15 * 60 * 1000);
      }
      console.warn(`[AI/Gemini/${modelName}] Repli :`, msg.slice(0, 140));
    }
  }

  return null;
}

export async function classifyWhatsAppDocument(params: {
  buffer: Buffer;
  mimeType: string;
  isPdf: boolean;
  originalFileName: string;
  caption: string;
  sourceName: string;
  existingFolders: string[];
}): Promise<ClassificationResult> {
  if (!params.isPdf) {
    return {
      ignore: true,
      reason: 'Format non-PDF ignoré (PDF uniquement).',
      folderName: 'Ignore',
      docType: 'Document',
      cleanTitle: 'Non_PDF',
    };
  }

  const extractedText = await extractPdfText(params.buffer);
  const canClassifyWithoutMultimodalUpload =
    extractedText.length >= 30 || hasDescriptiveMetadata(params.originalFileName, params.caption);

  const prompt = buildDynamicPrompt({
    fileName: params.originalFileName,
    caption: params.caption,
    sourceName: params.sourceName,
    extractedText,
    existingFolders: params.existingFolders,
  });

  // Routage ultra-rapide :
  // 1) Si le PDF contient du texte sélectionnable OU si son nom/légende est explicite -> Groq LPU en priorité (~180 ms, 0 Mo binaire envoyé)
  // 2) Uniquement si le PDF est un scan muet avec nom générique (DOC-WA0001.pdf sans légende) -> Gemini Multimodal avec coupe-circuit 429
  if (canClassifyWithoutMultimodalUpload) {
    const groqRes = await tryGroqClassification(prompt, params.originalFileName, params.caption);
    if (groqRes) return groqRes;

    const geminiTextRes = await tryGeminiClassification(
      prompt,
      params.buffer,
      false,
      params.originalFileName,
      params.caption,
    );
    if (geminiTextRes) return geminiTextRes;
  } else {
    const geminiScanRes = await tryGeminiClassification(
      prompt,
      params.buffer,
      true,
      params.originalFileName,
      params.caption,
    );
    if (geminiScanRes) return geminiScanRes;

    const groqFallbackRes = await tryGroqClassification(
      prompt,
      params.originalFileName,
      params.caption,
    );
    if (groqFallbackRes) return groqFallbackRes;
  }

  // Repli local instantané (< 1 ms si hors-ligne ou quotas atteints)
  return classifyByFastRules(
    extractedText,
    params.originalFileName,
    params.caption,
    params.sourceName,
    params.existingFolders,
  );
}

function normalizeAiResult(
  parsed: Record<string, unknown>,
  originalFileName: string,
  caption: string,
): ClassificationResult {
  const folderName = slugifyText(String(parsed.folderName || 'Autres_Documents')).slice(0, 35) || 'Autres_Documents';
  const cleanTitle =
    slugifyText(String(parsed.cleanTitle || '')).slice(0, 50) || buildCleanTitle(originalFileName, caption);
  const rawType = String(parsed.docType || 'Document');
  const allowedTypes: ClassificationResult['docType'][] = [
    'Cours',
    'TD',
    'TP',
    'Examen',
    'Facture',
    'Administratif',
    'Livre',
    'Document',
  ];
  const docType = allowedTypes.includes(rawType as ClassificationResult['docType'])
    ? (rawType as ClassificationResult['docType'])
    : 'Document';

  return {
    ignore: Boolean(parsed.ignore),
    folderName: docType === 'Livre' ? 'Livres' : folderName,
    docType,
    cleanTitle,
  };
}
