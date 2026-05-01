import Anthropic from '@anthropic-ai/sdk';
import { AI_MODEL } from './omniSearchConfig.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const DEFAULT_MODEL = AI_MODEL;

/**
 * Uses Claude to generate keyword suggestions with estimated metrics.
 */
export async function analyzeKeywords(seedKeyword, country = 'US', count = 20) {
  const response = await anthropic.messages.create({
    model: DEFAULT_MODEL,
    max_tokens: 4096,
    system: `You are an expert SEO keyword researcher. Given a seed keyword, generate a list of related keyword suggestions with estimated search metrics. Return ONLY valid JSON — no markdown, no explanation.

Output format:
{
  "seedKeyword": "<seed>",
  "country": "<country>",
  "keywords": [
    {
      "keyword": "...",
      "estimatedVolume": <number>,
      "difficulty": <0-100>,
      "intent": "informational|transactional|navigational|commercial",
      "cpc": <number>,
      "trend": "rising|stable|declining"
    }
  ]
}`,
    messages: [{ role: 'user', content: `Generate ${count} keyword suggestions for "${seedKeyword}" targeting ${country}. Include long-tail variations, questions, and related terms.` }],
  });
  const text = response.content[0]?.text || '{}';
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

/**
 * Uses Claude to cluster keywords into semantic groups.
 */
export async function clusterKeywords(keywords) {
  const response = await anthropic.messages.create({
    model: DEFAULT_MODEL,
    max_tokens: 4096,
    system: `You are an SEO expert specializing in keyword clustering and topic modeling. Group the given keywords into semantic clusters based on search intent and topical relevance. Return ONLY valid JSON.

Output format:
{
  "clusters": [
    {
      "name": "Cluster Name",
      "intent": "informational|transactional|navigational|commercial",
      "keywords": ["kw1", "kw2"],
      "pillarKeyword": "main keyword for this cluster",
      "estimatedTotalVolume": <number>
    }
  ],
  "unclustered": ["keywords that don't fit any group"]
}`,
    messages: [{ role: 'user', content: `Cluster these keywords:\n${keywords.join('\n')}` }],
  });
  const text = response.content[0]?.text || '{}';
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

/**
 * Uses Claude to analyze content and provide NLP-like scoring.
 */
export async function analyzeContent(content, targetKeyword, competitorData = null) {
  const competitorContext = competitorData
    ? `\n\nCompetitor data for comparison:\n${JSON.stringify(competitorData)}`
    : '';

  const response = await anthropic.messages.create({
    model: DEFAULT_MODEL,
    max_tokens: 4096,
    system: `You are an advanced content optimization AI. Analyze the given content for SEO quality, relevance to the target keyword, and provide actionable scores and recommendations. Return ONLY valid JSON.

Output format:
{
  "overallScore": <0-100>,
  "targetKeyword": "...",
  "scores": {
    "relevance": <0-100>,
    "depth": <0-100>,
    "readability": <0-100>,
    "uniqueness": <0-100>,
    "structure": <0-100>,
    "eeat": <0-100>
  },
  "keywordAnalysis": {
    "density": <number>,
    "inTitle": <boolean>,
    "inH1": <boolean>,
    "inFirstParagraph": <boolean>,
    "semanticVariations": ["..."]
  },
  "recommendations": ["actionable suggestion 1", "..."],
  "missingTopics": ["topic not covered"],
  "wordCount": <number>
}`,
    messages: [{ role: 'user', content: `Analyze this content for the target keyword "${targetKeyword}":${competitorContext}\n\n---\n${content}` }],
  });
  const text = response.content[0]?.text || '{}';
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

/**
 * Uses Claude to generate article content (returns stream for SSE).
 */
export function generateArticleStream(topic, outline, instructions, model = DEFAULT_MODEL) {
  const systemPrompt = `You are a world-class SEO content writer. Write high-quality, human-sounding, publish-ready articles that rank well on Google. Follow E-E-A-T principles. Vary sentence length naturally. Use real examples. Write with opinion and authority. Avoid AI-sounding phrases like "In today's digital landscape", "Furthermore", "Moreover", "It is worth noting".`;

  const userContent = `Write a complete article on: ${topic}

${outline ? `Outline to follow:\n${outline}\n` : ''}
${instructions ? `Additional instructions:\n${instructions}` : ''}

Deliver the full article with SEO title, meta description, headings, body, FAQ section, and conclusion.`;

  return anthropic.messages.stream({
    model,
    max_tokens: 4096,
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
  });
}

/**
 * Uses Claude to generate a content brief.
 */
export async function generateContentBrief(keyword, serpData) {
  const response = await anthropic.messages.create({
    model: DEFAULT_MODEL,
    max_tokens: 4096,
    system: `You are an SEO content strategist. Generate a comprehensive content brief for a writer. Return ONLY valid JSON.

Output format:
{
  "keyword": "...",
  "suggestedTitle": "...",
  "metaDescription": "...",
  "searchIntent": "informational|transactional|navigational|commercial",
  "targetWordCount": <number>,
  "outline": [
    { "heading": "H2: ...", "subheadings": ["H3: ..."], "keyPoints": ["..."], "wordCount": <number> }
  ],
  "requiredTerms": ["term1", "term2"],
  "faqQuestions": ["question1", "question2"],
  "internalLinkSuggestions": ["topic to link"],
  "toneGuidance": "...",
  "competitorInsights": "..."
}`,
    messages: [{ role: 'user', content: `Generate a content brief for the keyword "${keyword}".\n\n${serpData ? `SERP data:\n${JSON.stringify(serpData)}` : 'No SERP data provided — use your knowledge.'}` }],
  });
  const text = response.content[0]?.text || '{}';
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

/**
 * Uses Claude to perform competitive gap analysis.
 */
export async function analyzeCompetitiveGap(domain, competitors) {
  const response = await anthropic.messages.create({
    model: DEFAULT_MODEL,
    max_tokens: 4096,
    system: `You are an SEO competitive intelligence analyst. Analyze the domain vs competitors and identify content and keyword gaps. Return ONLY valid JSON.

Output format:
{
  "domain": "...",
  "competitors": ["..."],
  "keywordGaps": [
    { "keyword": "...", "competitorRanking": "...", "opportunity": "high|medium|low", "estimatedVolume": <number> }
  ],
  "contentGaps": [
    { "topic": "...", "coveredBy": ["competitor"], "priority": "high|medium|low" }
  ],
  "strengthAreas": ["topics where domain is strong"],
  "recommendations": ["actionable steps"]
}`,
    messages: [{ role: 'user', content: `Analyze competitive gaps for "${domain}" against these competitors: ${competitors.join(', ')}` }],
  });
  const text = response.content[0]?.text || '{}';
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

/**
 * Uses Claude to check AI platform responses for brand mentions.
 */
export async function checkGeoVisibility(prompt, brandName, platform = 'general') {
  const response = await anthropic.messages.create({
    model: DEFAULT_MODEL,
    max_tokens: 4096,
    system: `You are an AEO (Answer Engine Optimization) analyst. Simulate how an AI assistant would answer the given prompt, then analyze whether the brand is mentioned or recommended. Return ONLY valid JSON.

Output format:
{
  "prompt": "...",
  "platform": "...",
  "simulatedResponse": "...",
  "brandMentioned": <boolean>,
  "mentionPosition": <number or null>,
  "sentiment": "positive|neutral|negative|absent",
  "competitorsMentioned": ["..."],
  "recommendations": ["how to improve visibility"]
}`,
    messages: [{ role: 'user', content: `Check if "${brandName}" appears when an AI is asked: "${prompt}"\nPlatform context: ${platform}` }],
  });
  const text = response.content[0]?.text || '{}';
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

/**
 * Uses Claude to provide AI-powered SEO recommendations.
 */
export async function generateRecommendations(projectData) {
  const response = await anthropic.messages.create({
    model: DEFAULT_MODEL,
    max_tokens: 4096,
    system: `You are a senior SEO consultant providing strategic recommendations based on project data. Prioritize actionable, high-impact suggestions. Return ONLY valid JSON.

Output format:
{
  "priorities": [
    { "title": "...", "impact": "high|medium|low", "effort": "high|medium|low", "category": "technical|content|links|local", "description": "...", "steps": ["step1", "step2"] }
  ],
  "quickWins": ["immediate actions"],
  "longTermStrategy": "...",
  "estimatedTimeline": "..."
}`,
    messages: [{ role: 'user', content: `Provide SEO recommendations based on this project data:\n${JSON.stringify(projectData)}` }],
  });
  const text = response.content[0]?.text || '{}';
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

/**
 * Uses Claude to humanize or rewrite content.
 */
export async function rewriteContent(content, instructions, style = 'humanize') {
  const styleGuides = {
    humanize: 'Rewrite the content to sound naturally human. Vary sentence length, add personality, use conversational transitions, and remove any AI-sounding patterns. Keep the same information and SEO value.',
    formal: 'Rewrite in a professional, authoritative tone suitable for B2B audiences. Maintain clarity and precision.',
    casual: 'Rewrite in a friendly, casual tone. Use contractions, speak directly to the reader, add personality.',
    concise: 'Rewrite to be more concise. Remove fluff, tighten sentences, keep only essential information.',
    expand: 'Expand the content with more detail, examples, and supporting points. Add depth without padding.',
  };

  const response = await anthropic.messages.create({
    model: DEFAULT_MODEL,
    max_tokens: 4096,
    system: `You are an expert content editor and rewriter. ${styleGuides[style] || styleGuides.humanize}${instructions ? `\n\nAdditional instructions: ${instructions}` : ''}

Return only the rewritten content. No commentary or explanation.`,
    messages: [{ role: 'user', content }],
  });
  return response.content[0]?.text || '';
}

/**
 * Uses Claude to generate a topical map.
 */
export async function generateTopicalMap(domain, seedTopics) {
  const response = await anthropic.messages.create({
    model: DEFAULT_MODEL,
    max_tokens: 4096,
    system: `You are a topical authority strategist. Generate a comprehensive topical map that establishes authority in a niche. Return ONLY valid JSON.

Output format:
{
  "domain": "...",
  "pillars": [
    {
      "topic": "Pillar Topic",
      "targetKeyword": "...",
      "clusters": [
        {
          "topic": "Cluster Topic",
          "targetKeyword": "...",
          "articles": [
            { "title": "...", "keyword": "...", "intent": "informational|transactional", "priority": "high|medium|low", "wordCount": <number> }
          ]
        }
      ]
    }
  ],
  "totalArticles": <number>,
  "estimatedTimeline": "...",
  "interlinkingStrategy": "..."
}`,
    messages: [{ role: 'user', content: `Generate a topical map for "${domain}" covering these seed topics: ${seedTopics.join(', ')}` }],
  });
  const text = response.content[0]?.text || '{}';
  try { return JSON.parse(text); } catch { return { raw: text }; }
}
