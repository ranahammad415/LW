import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import { generateChat } from './ai.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_DIR = path.resolve(__dirname, '../..');

// Set absolute path of knowledge_base folder inside backend/
export const KB_BASE_DIR = path.join(BACKEND_DIR, 'knowledge_base');

const SUBDIRS = [
  'company',
  'services',
  'projects',
  'faq',
  'proof',
  'voice',
  'sales',
  'content/articles',
  'knowledge-gaps'
];

// Ensure base folder exists
if (!fs.existsSync(KB_BASE_DIR)) {
  fs.mkdirSync(KB_BASE_DIR, { recursive: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Text Extraction Helpers
// ─────────────────────────────────────────────────────────────────────────────

export async function extractPdfText(buffer) {
  const data = await pdfParse(buffer);
  return data.text || '';
}

export async function extractDocxText(buffer) {
  const result = await mammoth.extractRawText({ buffer });
  return result.value || '';
}

export function extractCsvText(buffer) {
  const text = buffer.toString('utf8');
  const lines = text.split(/\r?\n/).filter(line => line.trim());
  if (lines.length === 0) return '';

  const tableLines = lines.map(line => {
    // Basic CSV splitting, handles quotes simply
    const cells = line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/).map(c => {
      let cell = c.trim();
      if (cell.startsWith('"') && cell.endsWith('"')) {
        cell = cell.slice(1, -1).replace(/""/g, '"');
      }
      return cell;
    });
    return '| ' + cells.join(' | ') + ' |';
  });

  // Insert header separator line
  if (tableLines.length > 1) {
    const numHeaders = lines[0].split(',').length;
    const separator = '| ' + Array(numHeaders).fill('---').join(' | ') + ' |';
    tableLines.splice(1, 0, separator);
  }

  return tableLines.join('\n');
}

export async function extractFileContent(buffer, extension) {
  const ext = extension.toLowerCase().replace(/^\./, '');
  if (ext === 'pdf') {
    return extractPdfText(buffer);
  } else if (ext === 'docx' || ext === 'doc') {
    return extractDocxText(buffer);
  } else if (ext === 'csv') {
    return extractCsvText(buffer);
  } else if (['txt', 'md', 'markdown'].includes(ext)) {
    return buffer.toString('utf8');
  } else {
    throw new Error(`Unsupported file extension: .${ext}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Open Knowledge Format (OKF) YAML Frontmatter Helpers
// ─────────────────────────────────────────────────────────────────────────────

export function stringifyYaml(obj) {
  const lines = [];
  for (const [key, val] of Object.entries(obj)) {
    if (Array.isArray(val)) {
      lines.push(`${key}:`);
      for (const item of val) {
        lines.push(`  - ${String(item).replace(/"/g, '\\"')}`);
      }
    } else if (typeof val === 'object' && val !== null) {
      lines.push(`${key}: ${JSON.stringify(val)}`);
    } else {
      const valStr = String(val);
      if (valStr.includes('\n') || valStr.includes(':') || valStr.includes('"')) {
        lines.push(`${key}: ${JSON.stringify(valStr)}`);
      } else {
        lines.push(`${key}: ${valStr}`);
      }
    }
  }
  return lines.join('\n');
}

export function parseYaml(yamlText) {
  const obj = {};
  const lines = yamlText.split('\n');
  let currentKey = null;
  let currentArray = null;

  for (let line of lines) {
    line = line.trimEnd();
    if (!line.trim()) continue;

    if (line.trim().startsWith('- ')) {
      if (currentArray) {
        let val = line.trim().slice(2);
        if (val.startsWith('"') && val.endsWith('"')) {
          try { val = JSON.parse(val); } catch (_) {}
        }
        currentArray.push(val);
      }
      continue;
    }

    const match = line.match(/^([a-zA-Z0-9_-]+)\s*:\s*(.*)$/);
    if (match) {
      const key = match[1];
      let val = match[2].trim();

      if (val === '') {
        currentKey = key;
        currentArray = [];
        obj[key] = currentArray;
      } else {
        currentKey = null;
        currentArray = null;
        if (val.startsWith('"') && val.endsWith('"')) {
          try { val = JSON.parse(val); } catch (_) {}
        } else if (val === 'true') {
          val = true;
        } else if (val === 'false') {
          val = false;
        } else if (!isNaN(val) && val !== '') {
          val = Number(val);
        }
        obj[key] = val;
      }
    }
  }
  return obj;
}

export function slugify(text) {
  return text.toLowerCase().strip ? text.toLowerCase().strip() : text.toLowerCase().trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. OKF Filesystem Storage Helpers
// ─────────────────────────────────────────────────────────────────────────────

export function getClientDir(clientId) {
  return path.join(KB_BASE_DIR, clientId);
}

export function initializeClientDirs(clientId) {
  const clientDir = getClientDir(clientId);
  if (!fs.existsSync(clientDir)) {
    fs.mkdirSync(clientDir, { recursive: true });
  }
  for (const subdir of SUBDIRS) {
    const subpath = path.join(clientDir, subdir);
    if (!fs.existsSync(subpath)) {
      fs.mkdirSync(subpath, { recursive: true });
    }
  }
  return clientDir;
}

export function writeOkfFile(clientId, relativeFolder, filename, metadata, body) {
  const clientDir = initializeClientDirs(clientId);
  const targetDir = path.join(clientDir, relativeFolder);
  
  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const cleanFilename = filename.endsWith('.md') ? filename : `${filename}.md`;
  const filePath = path.join(targetDir, cleanFilename);

  const now = new Date().toISOString();
  if (!metadata.created_at) {
    metadata.created_at = now;
  }
  metadata.updated_at = now;

  const yamlHeader = stringifyYaml(metadata);
  const content = `---\n${yamlHeader}\n---\n\n${body.trim()}\n`;

  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

export function readOkfFile(clientId, relativeFolder, filename) {
  const clientDir = getClientDir(clientId);
  const cleanFilename = filename.endsWith('.md') ? filename : `${filename}.md`;
  const filePath = path.join(clientDir, relativeFolder, cleanFilename);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Knowledge asset not found: ${relativeFolder}/${cleanFilename}`);
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  
  if (match) {
    const yamlText = match[1];
    const body = match[2];
    try {
      const metadata = parseYaml(yamlText);
      return { metadata, body };
    } catch (e) {
      return { metadata: { parsing_error: String(e), type: 'unknown' }, body: content };
    }
  }
  return { metadata: { type: 'raw_text' }, body: content };
}

export function listClientFiles(clientId) {
  const clientDir = getClientDir(clientId);
  if (!fs.existsSync(clientDir)) {
    return [];
  }

  const assets = [];
  
  function walkDir(currentPath) {
    const items = fs.readdirSync(currentPath);
    for (const item of items) {
      const itemPath = path.join(currentPath, item);
      const stat = fs.statSync(itemPath);
      
      if (stat.isDirectory()) {
        walkDir(itemPath);
      } else if (stat.isFile() && item.endsWith('.md')) {
        const relPath = path.relative(clientDir, itemPath).replace(/\\/g, '/');
        const folder = path.dirname(relPath);
        
        try {
          const content = fs.readFileSync(itemPath, 'utf8');
          const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
          let metadata = {};
          let body = content;
          
          if (match) {
            metadata = parseYaml(match[1]);
            body = match[2];
          }

          assets.push({
            filename: item,
            folder: folder,
            rel_path: relPath,
            abs_path: itemPath,
            metadata: metadata,
            title: metadata.title || item.replace(/\.md$/, '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
            type: metadata.type || 'unknown',
            size_bytes: stat.size,
            updated_at: metadata.updated_at || stat.mtime.toISOString(),
            excerpt: body.slice(0, 200) + (body.length > 200 ? '...' : '')
          });
        } catch (_) {
          // Ignore files that fail to parse
        }
      }
    }
  }

  walkDir(clientDir);
  return assets;
}

export function searchKnowledgeContext(clientId, query, limit = 5) {
  const assets = listClientFiles(clientId);
  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);

  if (terms.length === 0) {
    return assets.slice(0, limit).map(asset => {
      const { body } = readOkfFile(clientId, asset.folder, asset.filename);
      return { asset, body, score: 1 };
    });
  }

  const scored = [];
  for (const asset of assets) {
    try {
      const { body } = readOkfFile(clientId, asset.folder, asset.filename);
      const textToSearch = `${body} ${asset.title} ${asset.folder}`.toLowerCase();
      let score = 0;
      for (const term of terms) {
        let index = textToSearch.indexOf(term);
        while (index !== -1) {
          score++;
          index = textToSearch.indexOf(term, index + 1);
        }
      }
      if (score > 0) {
        scored.push({ asset, body, score });
      }
    } catch (_) {}
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Claude SDK wrapper prompts
// ─────────────────────────────────────────────────────────────────────────────

export async function analyzeDocumentWithAi(docText, originalFilename, options = {}) {
  const system = `
    You are an expert knowledge engineer. Your task is to analyze raw text extracted from a business document and compile it into a structured summary.
    
    You must classify the document into one of the following standard folders based on its contents:
    - 'company': general profile, client onboarding, business overview.
    - 'services': service definitions, product sheets, capability lists.
    - 'projects': case studies, portfolio projects, past project summaries.
    - 'faq': lists of customer questions and answers, help sheets.
    - 'proof': testimonials, reviews, credentials, awards, metrics.
    - 'voice': style guides, brand guides, copywriting instructions.
    - 'sales': proposals, sales copy, pricing, contract terms.
    - 'knowledge': generic reference materials, files that do not fit the above.
    
    You must return a valid JSON object. Do not include markdown code block formatting in your response. The JSON structure must be:
    {
      "type": "The specific OKF document type (e.g. 'service-description', 'case-study', 'faq-list', 'brand-voice-guide')",
      "title": "A short, descriptive, human-friendly title for the asset",
      "folder": "The classified folder name (must be one of: 'company', 'services', 'projects', 'faq', 'proof', 'voice', 'sales', 'knowledge')",
      "summary": "A clean, markdown-formatted bulleted summary of the core business knowledge captured in this asset (about 3-6 bullet points)",
      "tags": ["list", "of", "3-5", "relevant", "tags"],
      "recommended_cleanup": "Provide a clean, well-formatted markdown version of the key knowledge details found in this text. Strip out noise, headers/footers, or scan artifacts, making it highly readable."
    }
  `;

  const user = `Original Filename: ${originalFilename}\n\nRaw Extracted Content:\n${docText.slice(0, 15000)}`;

  const res = await generateChat({
    system,
    user,
    json: true,
    feature: 'knowledge_extraction',
    ...options
  });

  return res.parsed || {};
}

export async function generateAiFollowup(question, userAnswer, options = {}) {
  const system = `
    You are an expert business consultant conducting an interview to document a company's internal knowledge.
    The user has just answered a question. Your goal is to ask a single, natural, and highly targeted follow-up question to drill deeper into their expertise.
    
    - Do not repeat the original question.
    - Ask for specific examples, metrics, or details.
    - Keep it short, encouraging, and clear (1 sentence).
    - If the user's answer is extremely short or vague, ask them to expand. If it's detailed, pick a specific point they made and ask for details or an example.
  `;

  const user = `Original Question: ${question}\nUser's Answer: ${userAnswer}`;

  const res = await generateChat({
    system,
    user,
    feature: 'expert_interview_followup',
    ...options
  });

  return res.text ? res.text.trim() : '';
}

export async function analyzeKnowledgeGaps(profileData, assetCatalog, options = {}) {
  const system = `
    You are an expert AI knowledge auditor. Your job is to analyze a business's knowledge base and identify gaps in their documentation.
    
    You will be given:
    1. The Client Profile (services, target market, differentiators).
    2. A Catalog of current Knowledge Assets loaded in their folder.
    
    Compare the declared services and industry focus with the loaded assets. Identify what is missing across these standard categories:
    - 'services': Missing granular service details, pricing sheets, or scope documents.
    - 'projects': Missing case studies, project timelines, or client work examples.
    - 'faq': Missing answers to common customer questions, onboarding FAQs.
    - 'proof': Missing customer testimonials, credentials, reviews, or awards.
    - 'sales': Missing customer objection sheets, competitive sheets, sales guides.
    
    You must return a valid JSON object. Do not include markdown code block formatting in your response. The JSON structure must be:
    {
      "readiness_score": 75, // Integer 0 to 100 based on documentation completeness
      "findings_summary": "A brief overall evaluation of their knowledge state.",
      "gaps": [
        {
          "category": "services", // One of: services, projects, faq, proof, sales
          "severity": "High", // High, Medium, Low
          "description": "Missing description for X service",
          "impact": "Why this gap matters for sales / SEO / AI visibility"
        }
      ],
      "recommended_questions": [
        {
          "id": "question_1",
          "category": "services",
          "question": "Can you walk through the step-by-step process of delivering X service?",
          "reason": "To document workflow and details for the services folder."
        }
      ]
    }
  `;

  const user = `
    CLIENT PROFILE:
    ${JSON.stringify(profileData, null, 2)}
    
    EXISTING KNOWLEDGE CATALOG:
    ${JSON.stringify(assetCatalog, null, 2)}
  `;

  const res = await generateChat({
    system,
    user,
    json: true,
    feature: 'gap_audit',
    ...options
  });

  return res.parsed || {};
}

export async function generateContentOpportunities(keyword, service, topic, contextText, options = {}) {
  const system = `
    You are an expert content strategist and SEO specialist. Your goal is to analyze search inputs and extract content opportunities.
    You MUST prioritize company-specific expertise and facts from the provided Knowledge Base Context. Do not generate generic SEO fluff.
    
    Generate the following details:
    - Search intent analysis (Informational, Commercial, Navigational, Transactional).
    - 10 highly specific customer questions that align with this topic.
    - 3-5 FAQ opportunities.
    - AI visibility opportunities (how ChatGPT, Gemini, Perplexity would cite this company based on the facts in the knowledge base).
    - 3 Article concepts (each with a Title, Hook, and brief explanation).
    
    You must return a valid JSON object. Do not include markdown code block formatting in your response. The JSON structure must be:
    {
      "search_intent": "Intent summary...",
      "questions": [
        "Question 1?",
        "Question 2?"
      ],
      "faq_opportunities": [
        {
          "question": "FAQ Q...",
          "concept": "Core detail to answer this FAQ..."
        }
      ],
      "ai_visibility_insights": "Details on what specific assets or facts this business has that will get them cited in AI search engines.",
      "article_concepts": [
        {
          "title": "Article Title",
          "hook": "Magnetic first line hook",
          "brief": "Short synopsis of what the article covers"
        }
      ]
    }
  `;

  const user = `
    USER INPUTS:
    - Keyword: ${keyword}
    - Service: ${service}
    - Topic: ${topic}
    
    KNOWLEDGE BASE CONTEXT:
    ${contextText}
  `;

  const res = await generateChat({
    system,
    user,
    json: true,
    feature: 'content_opportunities',
    ...options
  });

  return res.parsed || {};
}

export async function generateArticle(topic, selectedQuestion, contextText, options = {}) {
  const system = `
    You are a premium content writer. Your task is to generate a comprehensive, high-quality article based on a specific question and the provided Knowledge Base Context.
    
    CRITICAL PRINCIPLES:
    1. Ground the article in real expertise, case examples, or differentiators from the Knowledge Base Context.
    2. Write in a natural, authoritative, and direct tone.
    3. Avoid boilerplate SEO introductions like "In today's fast-paced digital world...". Jump straight to the value.
    4. Write detailed sections with clear headers.
    5. Prioritize customer language and practical examples.
    
    You must return a valid JSON object. Do not include markdown code block formatting in your response. The JSON structure must be:
    {
      "article_title": "Vibrant, click-worthy, yet professional Title",
      "outline": "Bulleted outline of the sections",
      "draft": "The full-length article draft written in clean markdown. Use appropriate subheadings, list elements, and bold terms.",
      "faqs": [
        {
          "q": "Frequently asked question related to the topic",
          "a": "Direct, expert answer"
        }
      ],
      "suggested_internal_links": [
        "Page to link to (e.g. '/services/service-x') - explain why"
      ],
      "schema_markup": "Provide a clean JSON-LD schema payload (e.g. FAQPage or Article schema) representing the data in this article."
    }
  `;

  const user = `
    TOPIC: ${topic}
    CUSTOMER QUESTION ADDRESSED: ${selectedQuestion}
    
    KNOWLEDGE BASE REFERENCE ASSETS:
    ${contextText}
  `;

  const res = await generateChat({
    system,
    user,
    json: true,
    feature: 'article_generation',
    maxTokens: 3000,
    ...options
  });

  return res.parsed || {};
}
