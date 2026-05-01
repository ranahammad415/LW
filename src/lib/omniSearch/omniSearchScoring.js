/**
 * Content scoring utilities for OmniSearch.
 * Pure functions — no external dependencies.
 */

// ─── Stop words to exclude from term frequency analysis ─────────────────────
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of',
  'with', 'by', 'from', 'is', 'it', 'that', 'this', 'was', 'are', 'be', 'has',
  'have', 'had', 'not', 'they', 'we', 'you', 'he', 'she', 'their', 'our',
  'your', 'its', 'will', 'can', 'would', 'could', 'should', 'do', 'does',
  'did', 'been', 'being', 'if', 'then', 'than', 'so', 'as', 'just', 'about',
  'up', 'out', 'no', 'what', 'which', 'who', 'when', 'where', 'how', 'all',
  'each', 'every', 'both', 'more', 'most', 'other', 'some', 'such', 'only',
  'own', 'same', 'also', 'very', 'may', 'still', 'get', 'got', 'one', 'two',
]);

// ─── Helper functions ───────────────────────────────────────────────────────

function tokenize(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s-]/g, '').split(/\s+/).filter(w => w.length > 1);
}

function getSentences(text) {
  return text.split(/[.!?]+/).map(s => s.trim()).filter(s => s.length > 0);
}

function countSyllables(word) {
  word = word.toLowerCase();
  if (word.length <= 3) return 1;
  word = word.replace(/(?:[^laeiouy]es|ed|[^laeiouy]e)$/, '');
  word = word.replace(/^y/, '');
  const matches = word.match(/[aeiouy]{1,2}/g);
  return matches ? matches.length : 1;
}

function extractTitle(content) {
  // Look for H1 or first line
  const h1Match = content.match(/^#\s+(.+)$/m) || content.match(/<h1[^>]*>([^<]+)<\/h1>/i);
  return h1Match ? h1Match[1].trim() : content.split('\n')[0].trim();
}

function extractHeadings(content) {
  const headings = [];
  const mdRegex = /^(#{1,6})\s+(.+)$/gm;
  let match;
  while ((match = mdRegex.exec(content)) !== null) {
    headings.push({ level: match[1].length, text: match[2].trim() });
  }
  // Also check HTML headings
  const htmlRegex = /<h([1-6])[^>]*>([^<]+)<\/h[1-6]>/gi;
  while ((match = htmlRegex.exec(content)) !== null) {
    headings.push({ level: parseInt(match[1]), text: match[2].trim() });
  }
  return headings;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Calculates content optimization score based on keyword usage and content quality.
 */
export function calculateContentScore(content, targetKeyword, recommendedTerms = []) {
  const text = content.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const words = tokenize(text);
  const totalWords = words.length;
  const title = extractTitle(content);
  const headings = extractHeadings(content);
  const keywordLower = targetKeyword.toLowerCase();
  const keywordWords = tokenize(targetKeyword);

  // 1. Title score (0-100): keyword in title
  const titleLower = title.toLowerCase();
  const titleScore = titleLower.includes(keywordLower) ? 100 :
    keywordWords.some(w => titleLower.includes(w)) ? 60 : 0;

  // 2. Keyword density score (0-100): ideal 1-3%
  const keywordCount = words.join(' ').split(keywordLower).length - 1;
  const density = totalWords > 0 ? (keywordCount / totalWords) * 100 : 0;
  let densityScore;
  if (density >= 1 && density <= 3) densityScore = 100;
  else if (density > 0 && density < 1) densityScore = Math.round(density * 70);
  else if (density > 3 && density <= 5) densityScore = Math.round(100 - (density - 3) * 25);
  else if (density > 5) densityScore = 10;
  else densityScore = 0;

  // 3. Recommended terms score (0-100)
  let termScore = 0;
  if (recommendedTerms.length > 0) {
    const textLower = text.toLowerCase();
    const found = recommendedTerms.filter(t => textLower.includes(t.toLowerCase()));
    termScore = Math.round((found.length / recommendedTerms.length) * 100);
  } else {
    termScore = 50; // Neutral if no terms provided
  }

  // 4. Length score (0-100): ideal 1500-2500 words
  let lengthScore;
  if (totalWords >= 1500 && totalWords <= 2500) lengthScore = 100;
  else if (totalWords >= 800 && totalWords < 1500) lengthScore = Math.round(50 + (totalWords - 800) / 14);
  else if (totalWords > 2500 && totalWords <= 4000) lengthScore = Math.round(100 - (totalWords - 2500) / 30);
  else if (totalWords < 800) lengthScore = Math.round((totalWords / 800) * 50);
  else lengthScore = 50;

  // 5. Readability score (0-100)
  const readability = calculateReadability(text);
  const readabilityScore = Math.min(100, Math.max(0, Math.round(readability.readingEase)));

  // 6. Heading score (0-100): has headings, keyword in headings
  const hasH2 = headings.some(h => h.level === 2);
  const keywordInHeading = headings.some(h => h.text.toLowerCase().includes(keywordLower));
  const headingCount = headings.length;
  let headingScore = 0;
  if (hasH2) headingScore += 40;
  if (keywordInHeading) headingScore += 30;
  if (headingCount >= 3) headingScore += 30;
  else if (headingCount >= 1) headingScore += 15;

  // Overall weighted score
  const overallScore = Math.round(
    titleScore * 0.2 +
    densityScore * 0.15 +
    termScore * 0.15 +
    lengthScore * 0.2 +
    readabilityScore * 0.15 +
    headingScore * 0.15
  );

  return {
    overallScore: Math.min(100, Math.max(0, overallScore)),
    breakdown: {
      titleScore,
      densityScore,
      termScore,
      lengthScore,
      readabilityScore,
      headingScore,
    },
  };
}

/**
 * Calculates readability metrics.
 */
export function calculateReadability(text) {
  const cleanText = text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const sentences = getSentences(cleanText);
  const words = tokenize(cleanText);
  const totalSentences = sentences.length || 1;
  const totalWords = words.length || 1;
  const totalSyllables = words.reduce((sum, w) => sum + countSyllables(w), 0);

  const avgSentenceLength = totalWords / totalSentences;
  const avgSyllablesPerWord = totalSyllables / totalWords;
  const avgWordLength = words.reduce((sum, w) => sum + w.length, 0) / totalWords;

  // Flesch Reading Ease
  const readingEase = 206.835 - (1.015 * avgSentenceLength) - (84.6 * avgSyllablesPerWord);

  // Flesch-Kincaid Grade Level
  const fleschKincaid = (0.39 * avgSentenceLength) + (11.8 * avgSyllablesPerWord) - 15.59;

  // Grade interpretation
  let grade;
  if (readingEase >= 90) grade = '5th grade';
  else if (readingEase >= 80) grade = '6th grade';
  else if (readingEase >= 70) grade = '7th grade';
  else if (readingEase >= 60) grade = '8th-9th grade';
  else if (readingEase >= 50) grade = '10th-12th grade';
  else if (readingEase >= 30) grade = 'College';
  else grade = 'College graduate';

  return {
    fleschKincaid: Math.round(fleschKincaid * 10) / 10,
    readingEase: Math.round(Math.max(0, Math.min(100, readingEase)) * 10) / 10,
    avgSentenceLength: Math.round(avgSentenceLength * 10) / 10,
    avgWordLength: Math.round(avgWordLength * 10) / 10,
    grade,
  };
}

/**
 * Analyzes term frequency and important phrases.
 */
export function analyzeTermFrequency(text, topN = 30) {
  const words = tokenize(text.replace(/<[^>]+>/g, ' '));
  const totalWords = words.length || 1;
  const freq = {};

  for (const word of words) {
    if (STOP_WORDS.has(word) || word.length < 3) continue;
    freq[word] = (freq[word] || 0) + 1;
  }

  // Also extract bigrams
  for (let i = 0; i < words.length - 1; i++) {
    if (STOP_WORDS.has(words[i]) || STOP_WORDS.has(words[i + 1])) continue;
    const bigram = `${words[i]} ${words[i + 1]}`;
    freq[bigram] = (freq[bigram] || 0) + 1;
  }

  return Object.entries(freq)
    .filter(([, count]) => count >= 2)
    .map(([term, count]) => ({
      term,
      count,
      density: Math.round((count / totalWords) * 10000) / 100, // percentage with 2 decimals
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, topN);
}

/**
 * Compares content against competitor content.
 */
export function compareContent(content, competitorContents) {
  const getTermSet = (text) => {
    const words = tokenize(text.replace(/<[^>]+>/g, ' '));
    const terms = new Set();
    for (const w of words) {
      if (!STOP_WORDS.has(w) && w.length >= 3) terms.add(w);
    }
    return terms;
  };

  const myTerms = getTermSet(content);
  const competitorTermSets = competitorContents.map(getTermSet);

  // Union of all competitor terms
  const allCompetitorTerms = new Set();
  for (const s of competitorTermSets) {
    for (const t of s) allCompetitorTerms.add(t);
  }

  // Terms present in competitors but not in our content
  const missingTerms = [...allCompetitorTerms].filter(t => !myTerms.has(t));

  // Terms unique to our content
  const uniqueTerms = [...myTerms].filter(t => !allCompetitorTerms.has(t));

  // Shared terms
  const sharedTerms = [...myTerms].filter(t => allCompetitorTerms.has(t));

  // Score difference (coverage of competitor terms)
  const scoreDiff = allCompetitorTerms.size > 0
    ? Math.round((sharedTerms.length / allCompetitorTerms.size) * 100)
    : 0;

  return {
    missingTerms: missingTerms.slice(0, 50),
    uniqueTerms: uniqueTerms.slice(0, 50),
    sharedTerms: sharedTerms.slice(0, 50),
    scoreDiff,
  };
}
