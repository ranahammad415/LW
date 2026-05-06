/**
 * seed-project-tasks.cjs
 * Interactive SEO task seeder for projects.
 * Run: node prisma/seed-project-tasks.cjs
 *
 * Flow:
 *  1. Lists all SEO projects found in DB
 *  2. For each project, asks: which months? (e.g. "4" or "1,2,3" or "4,5,6" or "skip")
 *  3. Seeds only the selected months' tasks, assigned to project's lead PM (or fallback PM)
 */
require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const readline = require('readline');

const prisma = new PrismaClient();

// ─── Interactive prompt helper ───────────────────────────────────────────────
function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ─── Task Definitions by Month ───────────────────────────────────────────────

function getMonth1Tasks() {
  return [
    // --- Keyword Research ---
    { title: 'Search Intent Analysis (Pages 1-10)', taskType: 'keyword-research', priority: 'HIGH' },
    { title: 'Keyword Research (Pages 1-10)', taskType: 'keyword-research', priority: 'HIGH' },
    { title: 'Incorporating Primary & Secondary Keywords (Pages 1-10)', taskType: 'keyword-research', priority: 'MEDIUM' },

    // --- Keyword Integration ---
    { title: 'Meta Tags (Title & Description) Optimization (Pages 1-10)', taskType: 'on-page-seo', priority: 'HIGH' },
    { title: 'Header Tags (H1-H6) Optimization (Pages 1-10)', taskType: 'on-page-seo', priority: 'MEDIUM' },
    { title: 'Natural Keyword Placement in Content (Pages 1-10)', taskType: 'on-page-seo', priority: 'MEDIUM' },

    // --- Content Audit & Refresh ---
    { title: 'Existing Content Quality Check (Pages 1-10)', taskType: 'content-audit', priority: 'MEDIUM' },
    { title: 'Content Gap Analysis (Pages 1-10)', taskType: 'content-audit', priority: 'MEDIUM' },
    { title: 'Content Update & Expansion (Pages 1-10)', taskType: 'content-writing', priority: 'MEDIUM' },
    { title: 'Duplicate Content Fixes (Pages 1-10)', taskType: 'content-audit', priority: 'MEDIUM' },

    // --- UI/UX Audit ---
    { title: 'Mobile Responsiveness Check (Pages 1-10)', taskType: 'technical-seo', priority: 'HIGH' },
    { title: 'Page Layout & Design Improvements (Pages 1-10)', taskType: 'technical-seo', priority: 'MEDIUM' },
    { title: 'User Journey Analysis (Pages 1-10)', taskType: 'ux-audit', priority: 'MEDIUM' },
    { title: 'Navigation Optimization (Pages 1-10)', taskType: 'ux-audit', priority: 'MEDIUM' },
    { title: 'Bounce Rate Improvement Areas (Pages 1-10)', taskType: 'ux-audit', priority: 'LOW' },

    // --- Internal / External Link Optimization ---
    { title: 'Internal Linking Structure Improvement (Pages 1-10)', taskType: 'link-building', priority: 'MEDIUM' },
    { title: 'Broken Link Identification & Fixes (Pages 1-10)', taskType: 'crawl-fix', priority: 'HIGH' },
    { title: 'External Link Quality Check (Pages 1-10)', taskType: 'link-building', priority: 'LOW' },

    // --- URL Structure ---
    { title: 'SEO-Friendly URL Creation (Pages 1-10)', taskType: 'on-page-seo', priority: 'MEDIUM' },
    { title: 'Readability Optimization (Pages 1-10)', taskType: 'on-page-seo', priority: 'LOW' },
    { title: 'Keyword Inclusion in URLs (Pages 1-10)', taskType: 'on-page-seo', priority: 'LOW' },
    { title: 'Canonicalization Handling (Pages 1-10)', taskType: 'technical-seo', priority: 'MEDIUM' },

    // --- CTA Audit ---
    { title: 'CTA Placement Analysis (Pages 1-10)', taskType: 'cro', priority: 'MEDIUM' },
    { title: 'CTA Design & Visibility Improvement (Pages 1-10)', taskType: 'cro', priority: 'MEDIUM' },

    // --- Content Enhancement (4 Blog Posts) ---
    { title: 'Blog Topic Research (Month 1)', taskType: 'content-writing', priority: 'MEDIUM' },
    { title: 'Keyword-Based Content Creation (Month 1)', taskType: 'content-writing', priority: 'MEDIUM' },
    { title: 'Blog Content Writing & Optimization (Month 1)', taskType: 'content-writing', priority: 'MEDIUM' },
    { title: 'Internal Linking Integration for Blogs (Month 1)', taskType: 'link-building', priority: 'LOW' },
    { title: 'Blog Publishing & Indexing (Month 1)', taskType: 'content-writing', priority: 'MEDIUM' },

    // --- Competitive Analysis ---
    { title: 'Competitor Keyword Analysis (Month 1)', taskType: 'keyword-research', priority: 'MEDIUM' },
    { title: 'Competitor Content Review (Month 1)', taskType: 'content-audit', priority: 'MEDIUM' },
    { title: 'Competitor Backlink Analysis (Month 1)', taskType: 'link-building', priority: 'MEDIUM' },
    { title: 'Backlink / Keyword Gap Identification (Month 1)', taskType: 'link-building', priority: 'MEDIUM' },

    // --- Backlink Opportunity ---
    { title: 'Competitor Backlink Gap Analysis (Month 1)', taskType: 'link-building', priority: 'MEDIUM' },
    { title: 'High Authority Site Identification (Month 1)', taskType: 'link-building', priority: 'MEDIUM' },
    { title: 'Outreach Target List Creation (Month 1)', taskType: 'link-building', priority: 'LOW' },

    // --- AEO / GEO ---
    { title: 'Featured Snippet Optimization (Month 1)', taskType: 'aeo-geo', priority: 'HIGH' },
    { title: 'FAQ Section Creation (Month 1)', taskType: 'aeo-geo', priority: 'MEDIUM' },
    { title: 'Structured Content Formatting (Month 1)', taskType: 'aeo-geo', priority: 'MEDIUM' },
    { title: 'Voice Search Optimization (Month 1)', taskType: 'aeo-geo', priority: 'LOW' },
    { title: 'Entity-Based SEO Optimization (Month 1)', taskType: 'aeo-geo', priority: 'MEDIUM' },

    // --- GSC Monitoring ---
    { title: 'Coverage Report & Indexing Report Monitoring (Month 1)', taskType: 'technical-seo', priority: 'HIGH' },
    { title: 'Crawl Error Fixes (Month 1)', taskType: 'crawl-fix', priority: 'HIGH' },
    { title: 'Content Insights & Performance Analysis (Month 1)', taskType: 'reporting', priority: 'MEDIUM' },
    { title: 'Sitemap Submission Monitoring (Month 1)', taskType: 'technical-seo', priority: 'MEDIUM' },

    // --- Foundation Setup ---
    { title: 'Website Audit (Technical SEO)', taskType: 'technical-seo', priority: 'CRITICAL' },
    { title: 'XML Sitemap Optimization & Segmentation', taskType: 'technical-seo', priority: 'HIGH' },
    { title: 'Robots.txt Review', taskType: 'technical-seo', priority: 'HIGH' },
    { title: 'Canonical Tags Audit', taskType: 'technical-seo', priority: 'HIGH' },
    { title: '3xx / 4xx Error Identification', taskType: 'crawl-fix', priority: 'HIGH' },

    // --- SEO Integrations ---
    { title: 'Google Analytics Setup', taskType: 'technical-seo', priority: 'CRITICAL' },
    { title: 'Google Search Console Setup', taskType: 'technical-seo', priority: 'CRITICAL' },
    { title: 'Tag Manager Integration', taskType: 'technical-seo', priority: 'HIGH' },
    { title: 'Conversion Tracking Setup (Forms, Calls, Events)', taskType: 'technical-seo', priority: 'HIGH' },

    // --- Core On-Page SEO ---
    { title: 'Image Optimization (Alt Text, Compression)', taskType: 'on-page-seo', priority: 'MEDIUM' },
    { title: 'URL Structure Fixes', taskType: 'on-page-seo', priority: 'MEDIUM' },
    { title: 'Internal Linking Setup', taskType: 'link-building', priority: 'MEDIUM' },
    { title: 'Add Clear Above-the-Fold CTAs', taskType: 'cro', priority: 'MEDIUM' },
    { title: 'Navigation Menu Optimization', taskType: 'ux-audit', priority: 'MEDIUM' },

    // --- GBP Foundation ---
    { title: 'Google Business Profile Setup', taskType: 'local-seo', priority: 'HIGH' },
    { title: 'Business Information Optimization (NAP)', taskType: 'local-seo', priority: 'HIGH' },
    { title: 'Category & Service Setup (GBP)', taskType: 'local-seo', priority: 'MEDIUM' },
    { title: 'Initial GBP Posts & Updates', taskType: 'local-seo', priority: 'LOW' },

    // --- Local Citation ---
    { title: 'Business Listing Creation', taskType: 'local-seo', priority: 'MEDIUM' },
    { title: 'NAP Consistency Check', taskType: 'local-seo', priority: 'MEDIUM' },
    { title: 'Directory Submissions', taskType: 'local-seo', priority: 'LOW' },
  ];
}

function getMonth2Tasks() {
  return [
    // --- Keyword Research ---
    { title: 'Search Intent Analysis (Pages 11-20)', taskType: 'keyword-research', priority: 'HIGH' },
    { title: 'Keyword Research (Pages 11-20)', taskType: 'keyword-research', priority: 'HIGH' },
    { title: 'Incorporating Primary & Secondary Keywords (Pages 11-20)', taskType: 'keyword-research', priority: 'MEDIUM' },

    // --- Keyword Integration ---
    { title: 'Meta Tags (Title & Description) Optimization (Pages 11-20)', taskType: 'on-page-seo', priority: 'HIGH' },
    { title: 'Header Tags (H1-H6) Optimization (Pages 11-20)', taskType: 'on-page-seo', priority: 'MEDIUM' },
    { title: 'Natural Keyword Placement in Content (Pages 11-20)', taskType: 'on-page-seo', priority: 'MEDIUM' },

    // --- Content Audit ---
    { title: 'Existing Content Quality Check (Pages 11-20)', taskType: 'content-audit', priority: 'MEDIUM' },
    { title: 'Content Gap Analysis (Pages 11-20)', taskType: 'content-audit', priority: 'MEDIUM' },
    { title: 'Content Update & Expansion (Pages 11-20)', taskType: 'content-writing', priority: 'MEDIUM' },
    { title: 'Duplicate Content Fixes (Pages 11-20)', taskType: 'content-audit', priority: 'MEDIUM' },

    // --- UI/UX ---
    { title: 'Mobile Responsiveness Check (Pages 11-20)', taskType: 'technical-seo', priority: 'HIGH' },
    { title: 'Page Layout & Design Improvements (Pages 11-20)', taskType: 'technical-seo', priority: 'MEDIUM' },
    { title: 'User Journey Analysis (Pages 11-20)', taskType: 'ux-audit', priority: 'MEDIUM' },
    { title: 'Navigation Optimization (Pages 11-20)', taskType: 'ux-audit', priority: 'MEDIUM' },
    { title: 'Bounce Rate Improvement Areas (Pages 11-20)', taskType: 'ux-audit', priority: 'LOW' },

    // --- Links ---
    { title: 'Internal Linking Structure Improvement (Pages 11-20)', taskType: 'link-building', priority: 'MEDIUM' },
    { title: 'Broken Link Identification & Fixes (Pages 11-20)', taskType: 'crawl-fix', priority: 'HIGH' },
    { title: 'External Link Quality Check (Pages 11-20)', taskType: 'link-building', priority: 'LOW' },

    // --- URL / CTA ---
    { title: 'SEO-Friendly URL Creation (Pages 11-20)', taskType: 'on-page-seo', priority: 'MEDIUM' },
    { title: 'Canonicalization Handling (Pages 11-20)', taskType: 'technical-seo', priority: 'MEDIUM' },
    { title: 'CTA Placement Analysis (Pages 11-20)', taskType: 'cro', priority: 'MEDIUM' },
    { title: 'CTA Design & Visibility Improvement (Pages 11-20)', taskType: 'cro', priority: 'MEDIUM' },

    // --- Blog Posts ---
    { title: 'Blog Topic Research (Month 2)', taskType: 'content-writing', priority: 'MEDIUM' },
    { title: 'Blog Content Writing & Optimization (Month 2)', taskType: 'content-writing', priority: 'MEDIUM' },
    { title: 'Blog Publishing & Indexing (Month 2)', taskType: 'content-writing', priority: 'MEDIUM' },

    // --- Competitive ---
    { title: 'Competitor Keyword Analysis (Month 2)', taskType: 'keyword-research', priority: 'MEDIUM' },
    { title: 'Competitor Content Review (Month 2)', taskType: 'content-audit', priority: 'MEDIUM' },
    { title: 'Competitor Backlink Analysis (Month 2)', taskType: 'link-building', priority: 'MEDIUM' },
    { title: 'Competitor Backlink Gap Analysis (Month 2)', taskType: 'link-building', priority: 'MEDIUM' },
    { title: 'High Authority Site Identification (Month 2)', taskType: 'link-building', priority: 'MEDIUM' },
    { title: 'Outreach Target List Creation (Month 2)', taskType: 'link-building', priority: 'LOW' },

    // --- AEO / GEO ---
    { title: 'Featured Snippet Optimization (Month 2)', taskType: 'aeo-geo', priority: 'HIGH' },
    { title: 'FAQ Section Creation (Month 2)', taskType: 'aeo-geo', priority: 'MEDIUM' },
    { title: 'Structured Content Formatting (Month 2)', taskType: 'aeo-geo', priority: 'MEDIUM' },
    { title: 'Voice Search Optimization (Month 2)', taskType: 'aeo-geo', priority: 'LOW' },
    { title: 'Entity-Based SEO Optimization (Month 2)', taskType: 'aeo-geo', priority: 'MEDIUM' },

    // --- GSC ---
    { title: 'Coverage Report & Indexing Report Monitoring (Month 2)', taskType: 'technical-seo', priority: 'HIGH' },
    { title: 'Crawl Error Fixes (Month 2)', taskType: 'crawl-fix', priority: 'HIGH' },
    { title: 'Content Insights & Performance Analysis (Month 2)', taskType: 'reporting', priority: 'MEDIUM' },
    { title: 'Sitemap Submission Monitoring (Month 2)', taskType: 'technical-seo', priority: 'MEDIUM' },

    // --- Performance & Speed ---
    { title: 'Page Speed Improvements', taskType: 'technical-seo', priority: 'HIGH' },
    { title: 'Core Web Vitals Optimization (LCP, CLS, INP)', taskType: 'technical-seo', priority: 'HIGH' },
    { title: 'Image & Code Optimization', taskType: 'technical-seo', priority: 'MEDIUM' },

    // --- GBP ---
    { title: 'GBP Regular Posting (Month 2)', taskType: 'local-seo', priority: 'MEDIUM' },
    { title: 'Review Management (Month 2)', taskType: 'local-seo', priority: 'MEDIUM' },
    { title: 'GBP Q&A Updates (Month 2)', taskType: 'local-seo', priority: 'LOW' },

    // --- Local SEO ---
    { title: 'Geo-Targeted Content (Month 2)', taskType: 'local-seo', priority: 'MEDIUM' },
    { title: 'NAP Consistency Audit (Month 2)', taskType: 'local-seo', priority: 'MEDIUM' },
    { title: 'Local Landing Page Optimization (Month 2)', taskType: 'local-seo', priority: 'MEDIUM' },

    // --- Backlink Building ---
    { title: 'Generic Link Building (Pages 1-20)', taskType: 'link-building', priority: 'MEDIUM' },
    { title: 'Outreach Campaign Execution (Month 2)', taskType: 'link-building', priority: 'MEDIUM' },
    { title: 'Guest Posting (Month 2)', taskType: 'link-building', priority: 'MEDIUM' },
    { title: 'Anchor Text Strategy (Month 2)', taskType: 'link-building', priority: 'MEDIUM' },

    // --- Schema ---
    { title: 'FAQ Schema Implementation (Month 2)', taskType: 'schema', priority: 'HIGH' },
    { title: 'Structured Data Optimization (Month 2)', taskType: 'schema', priority: 'HIGH' },
    { title: 'Featured Snippet Targeting (Month 2)', taskType: 'aeo-geo', priority: 'MEDIUM' },
    { title: 'Schema Implementation & Validation (Month 2)', taskType: 'schema', priority: 'HIGH' },
  ];
}

function getMonth3Tasks() {
  return [
    // --- Keyword Research ---
    { title: 'Search Intent Analysis (Pages 21-30)', taskType: 'keyword-research', priority: 'HIGH' },
    { title: 'Keyword Research (Pages 21-30)', taskType: 'keyword-research', priority: 'HIGH' },
    { title: 'Incorporating Primary & Secondary Keywords (Pages 21-30)', taskType: 'keyword-research', priority: 'MEDIUM' },

    // --- Keyword Integration ---
    { title: 'Meta Tags (Title & Description) Optimization (Pages 21-30)', taskType: 'on-page-seo', priority: 'HIGH' },
    { title: 'Header Tags (H1-H6) Optimization (Pages 21-30)', taskType: 'on-page-seo', priority: 'MEDIUM' },
    { title: 'Natural Keyword Placement in Content (Pages 21-30)', taskType: 'on-page-seo', priority: 'MEDIUM' },

    // --- Content Audit ---
    { title: 'Existing Content Quality Check (Pages 21-30)', taskType: 'content-audit', priority: 'MEDIUM' },
    { title: 'Content Gap Analysis (Pages 21-30)', taskType: 'content-audit', priority: 'MEDIUM' },
    { title: 'Content Update & Expansion (Pages 21-30)', taskType: 'content-writing', priority: 'MEDIUM' },
    { title: 'Duplicate Content Fixes (Pages 21-30)', taskType: 'content-audit', priority: 'MEDIUM' },

    // --- UI/UX ---
    { title: 'Mobile Responsiveness Check (Pages 21-30)', taskType: 'technical-seo', priority: 'HIGH' },
    { title: 'Page Layout & Design Improvements (Pages 21-30)', taskType: 'technical-seo', priority: 'MEDIUM' },
    { title: 'User Journey Analysis (Pages 21-30)', taskType: 'ux-audit', priority: 'MEDIUM' },
    { title: 'Navigation Optimization (Pages 21-30)', taskType: 'ux-audit', priority: 'MEDIUM' },

    // --- Links ---
    { title: 'Internal Linking Structure Improvement (Pages 21-30)', taskType: 'link-building', priority: 'MEDIUM' },
    { title: 'Broken Link Identification & Fixes (Pages 21-30)', taskType: 'crawl-fix', priority: 'HIGH' },

    // --- CTA ---
    { title: 'CTA Placement Analysis (Pages 21-30)', taskType: 'cro', priority: 'MEDIUM' },
    { title: 'CTA Design & Visibility Improvement (Pages 21-30)', taskType: 'cro', priority: 'MEDIUM' },

    // --- Blog Posts ---
    { title: 'Blog Topic Research (Month 3)', taskType: 'content-writing', priority: 'MEDIUM' },
    { title: 'Blog Content Writing & Optimization (Month 3)', taskType: 'content-writing', priority: 'MEDIUM' },
    { title: 'Blog Publishing & Indexing (Month 3)', taskType: 'content-writing', priority: 'MEDIUM' },

    // --- Competitive ---
    { title: 'Competitor Keyword Analysis (Month 3)', taskType: 'keyword-research', priority: 'MEDIUM' },
    { title: 'Competitor Backlink Analysis (Month 3)', taskType: 'link-building', priority: 'MEDIUM' },

    // --- AEO / GEO ---
    { title: 'Featured Snippet Optimization (Month 3)', taskType: 'aeo-geo', priority: 'HIGH' },
    { title: 'FAQ Section Creation (Month 3)', taskType: 'aeo-geo', priority: 'MEDIUM' },
    { title: 'Voice Search Optimization (Month 3)', taskType: 'aeo-geo', priority: 'LOW' },
    { title: 'Entity-Based SEO Optimization (Month 3)', taskType: 'aeo-geo', priority: 'MEDIUM' },

    // --- GSC ---
    { title: 'Coverage Report & Indexing Report Monitoring (Month 3)', taskType: 'technical-seo', priority: 'HIGH' },
    { title: 'Crawl Error Fixes (Month 3)', taskType: 'crawl-fix', priority: 'HIGH' },
    { title: 'Content Insights & Performance Analysis (Month 3)', taskType: 'reporting', priority: 'MEDIUM' },
    { title: 'Sitemap Submission Monitoring (Month 3)', taskType: 'technical-seo', priority: 'MEDIUM' },

    // --- Content Expansion & Topical Authority ---
    { title: 'Content Pruning', taskType: 'content-audit', priority: 'MEDIUM' },
    { title: 'Existing Content Expansion', taskType: 'content-writing', priority: 'MEDIUM' },
    { title: 'Topic Coverage Improvement', taskType: 'content-writing', priority: 'MEDIUM' },
    { title: 'Evergreen Content Development', taskType: 'content-writing', priority: 'MEDIUM' },

    // --- Content Cluster ---
    { title: 'Pillar Page Creation', taskType: 'content-writing', priority: 'HIGH' },
    { title: 'Supporting Content Linking', taskType: 'link-building', priority: 'MEDIUM' },
    { title: 'Topic Cluster Structuring', taskType: 'content-writing', priority: 'MEDIUM' },

    // --- Local SEO & PR ---
    { title: 'Local Outreach (Month 3)', taskType: 'local-seo', priority: 'MEDIUM' },
    { title: 'PR Mentions (Month 3)', taskType: 'link-building', priority: 'MEDIUM' },
    { title: 'Brand Visibility Campaigns (Month 3)', taskType: 'link-building', priority: 'MEDIUM' },

    // --- Advanced AEO ---
    { title: 'Advanced Structured Data Implementation', taskType: 'schema', priority: 'HIGH' },
    { title: 'Voice Search Authority Development', taskType: 'aeo-geo', priority: 'MEDIUM' },
    { title: 'Entity Strengthening (Month 3)', taskType: 'aeo-geo', priority: 'MEDIUM' },

    // --- Authority Link Building ---
    { title: 'High Authority Backlinks Campaign', taskType: 'link-building', priority: 'HIGH' },
    { title: 'Digital PR Outreach', taskType: 'link-building', priority: 'MEDIUM' },
    { title: 'Competitor Backlink Gap Coverage', taskType: 'link-building', priority: 'MEDIUM' },

    // --- CRO ---
    { title: 'A/B Testing Setup', taskType: 'cro', priority: 'MEDIUM' },
    { title: 'Funnel Optimization', taskType: 'cro', priority: 'MEDIUM' },
    { title: 'User Behavior Analysis (Heatmaps)', taskType: 'cro', priority: 'LOW' },
  ];
}

function getMonth4Tasks() {
  return [
    // --- Competitive Analysis ---
    { title: 'Competitor Keyword Analysis', taskType: 'keyword-research', priority: 'HIGH' },
    { title: 'Competitor Backlink Analysis', taskType: 'link-building', priority: 'MEDIUM' },
    { title: 'Create Competitor Content Benchmark Sheet', taskType: 'content-audit', priority: 'MEDIUM' },

    // --- Backlink Opportunity ---
    { title: 'Identify Free & Paid Backlink Opportunities', taskType: 'link-building', priority: 'MEDIUM' },
    { title: 'Outreach for Backlinks', taskType: 'link-building', priority: 'MEDIUM' },
    { title: 'Repurpose Content into Linkable Formats', taskType: 'content-writing', priority: 'LOW' },

    // --- Local SEO ---
    { title: 'Location-Based Pages Creation', taskType: 'local-seo', priority: 'HIGH' },
    { title: 'GBP Growth Activities', taskType: 'local-seo', priority: 'MEDIUM' },
    { title: 'Reviews Strategy Implementation', taskType: 'local-seo', priority: 'MEDIUM' },
    { title: 'Local Schema Implementation', taskType: 'schema', priority: 'HIGH' },
    { title: 'Add Local Business Citations to US Directories', taskType: 'local-seo', priority: 'MEDIUM' },

    // --- AEO / GEO ---
    { title: 'Implement Schema (High Impression Zero-Click Pages)', taskType: 'schema', priority: 'HIGH' },
    { title: 'Entity Strengthening (High Impression Zero-Click Pages)', taskType: 'aeo-geo', priority: 'HIGH' },
    { title: 'Analyse / Improve FAQ Section (New & Zero-Click Pages)', taskType: 'aeo-geo', priority: 'MEDIUM' },
    { title: 'Structured Content Formatting (New & Zero-Click Pages)', taskType: 'aeo-geo', priority: 'MEDIUM' },
    { title: 'Voice Search Optimization (New Pages)', taskType: 'aeo-geo', priority: 'LOW' },
    { title: 'Entity-Based SEO Optimization (New Pages)', taskType: 'aeo-geo', priority: 'MEDIUM' },

    // --- GSC Monitoring ---
    { title: 'Crawl / Indexing Issues Monitoring', taskType: 'technical-seo', priority: 'HIGH' },
    { title: 'Coverage Report Monitoring', taskType: 'technical-seo', priority: 'MEDIUM' },
    { title: 'Sitemap Monitoring', taskType: 'technical-seo', priority: 'MEDIUM' },
    { title: 'Crawl Budget Optimization', taskType: 'technical-seo', priority: 'MEDIUM' },
    { title: 'Improve Internal Crawl Paths (2-3 Clicks)', taskType: 'technical-seo', priority: 'MEDIUM' },

    // --- Zero-Click Strategy ---
    { title: 'Identify 10 High Impression Zero-Click Pages', taskType: 'keyword-research', priority: 'CRITICAL' },
    { title: 'Analyze Target Keywords for Zero-Click Strategy', taskType: 'keyword-research', priority: 'HIGH' },
    { title: 'Content Audit for 10 Zero-Click Pages', taskType: 'content-audit', priority: 'HIGH' },
    { title: 'On-Page SEO for 10 Zero-Click Pages', taskType: 'on-page-seo', priority: 'HIGH' },
    { title: 'Technical SEO for 10 Zero-Click Pages', taskType: 'technical-seo', priority: 'HIGH' },

    // --- Low-Hanging Keywords ---
    { title: 'List 20 Low-Hang Keywords (Position 20-30)', taskType: 'keyword-research', priority: 'HIGH' },

    // --- Content Optimization ---
    { title: 'Audit Underperforming Pages', taskType: 'content-audit', priority: 'MEDIUM' },
    { title: 'Refresh Content on Underperforming Pages', taskType: 'content-writing', priority: 'MEDIUM' },
    { title: 'Title & Meta Updates for CTR Focus', taskType: 'on-page-seo', priority: 'HIGH' },
    { title: 'Internal Linking Update', taskType: 'link-building', priority: 'MEDIUM' },
    { title: 'Media Optimization', taskType: 'on-page-seo', priority: 'LOW' },

    // --- Data-Driven Keyword ---
    { title: 'Identify Low-Hanging Keywords (Below Position 10)', taskType: 'keyword-research', priority: 'HIGH' },
    { title: 'Optimize Low-Hanging Keywords', taskType: 'on-page-seo', priority: 'HIGH' },
    { title: 'Align Content with Search Intent', taskType: 'content-writing', priority: 'MEDIUM' },
    { title: 'Identify Long-Tail Opportunities', taskType: 'keyword-research', priority: 'MEDIUM' },

    // --- Internal Linking ---
    { title: 'High Authority to Low Ranking Pages Linking', taskType: 'link-building', priority: 'HIGH' },
    { title: 'Anchor Text Refinement (Zero-Click Pages)', taskType: 'link-building', priority: 'MEDIUM' },
    { title: 'Audit Orphan Pages & Fix via Blogs/New Pages', taskType: 'link-building', priority: 'MEDIUM' },

    // --- CRO ---
    { title: 'CTA Optimization (High Impression Zero-Click)', taskType: 'cro', priority: 'MEDIUM' },
    { title: 'Funnel Fixes (High Impression Zero-Click)', taskType: 'cro', priority: 'MEDIUM' },
    { title: 'Track User Behavior with Heatmaps', taskType: 'cro', priority: 'LOW' },

    // --- Technical SEO ---
    { title: 'Full Technical SEO Audit', taskType: 'technical-seo', priority: 'HIGH' },
    { title: 'Crawl Fixes', taskType: 'crawl-fix', priority: 'HIGH' },
    { title: 'Page Speed Optimization', taskType: 'technical-seo', priority: 'MEDIUM' },
    { title: 'Schema Audit', taskType: 'schema', priority: 'MEDIUM' },

    // --- Q1 Carryover ---
    { title: 'Update Content for First 5 Pages (Content Gap Analysis)', taskType: 'content-writing', priority: 'MEDIUM' },
    { title: 'Reach Out to Competitor Broken Backlink Owners', taskType: 'link-building', priority: 'MEDIUM' },
  ];
}

function getMonth5Tasks() {
  return [
    // --- Authority / Backlink Growth ---
    { title: 'Authority Link Campaigns', taskType: 'link-building', priority: 'HIGH' },
    { title: 'Digital PR Campaign', taskType: 'link-building', priority: 'MEDIUM' },
    { title: 'Competitor Gap Coverage', taskType: 'link-building', priority: 'MEDIUM' },
    { title: 'Paid Backlinks via LinkedIn/Email Outreach', taskType: 'link-building', priority: 'MEDIUM' },
    { title: 'Reverse Engineer Competitor Top 5 Pages', taskType: 'keyword-research', priority: 'HIGH' },
    { title: 'Monitor Competitor New Backlinks & Replicate', taskType: 'link-building', priority: 'MEDIUM' },

    // --- Backlink Research (Low-Hang KWs) ---
    { title: 'Find Free & Paid Backlink Opportunities (Low-Hang KWs)', taskType: 'link-building', priority: 'HIGH' },
    { title: 'Finalise Paid Backlink Website List', taskType: 'link-building', priority: 'MEDIUM' },
    { title: 'Identify Keywords/Pages for Paid Backlinks', taskType: 'keyword-research', priority: 'MEDIUM' },
    { title: 'Create & Ready Content for Paid Backlinks', taskType: 'content-writing', priority: 'MEDIUM' },
    { title: 'Acquire Backlinks from Paid Resources', taskType: 'link-building', priority: 'HIGH' },

    // --- Local SEO ---
    { title: 'GBP Growth Activities', taskType: 'local-seo', priority: 'MEDIUM' },
    { title: 'Reviews Strategy Implementation', taskType: 'local-seo', priority: 'MEDIUM' },
    { title: 'Local Schema Updates', taskType: 'schema', priority: 'MEDIUM' },
    { title: 'Add Local Testimonials (City-Specific)', taskType: 'local-seo', priority: 'LOW' },

    // --- AEO / GEO ---
    { title: 'Implement Schema (High Impression Zero-Click Pages)', taskType: 'schema', priority: 'HIGH' },
    { title: 'Entity Strengthening (High Impression Zero-Click Pages)', taskType: 'aeo-geo', priority: 'HIGH' },
    { title: 'Analyse / Improve FAQ Section (New & Zero-Click Pages)', taskType: 'aeo-geo', priority: 'MEDIUM' },
    { title: 'Structured Content Formatting (New & Zero-Click Pages)', taskType: 'aeo-geo', priority: 'MEDIUM' },
    { title: 'Voice Search Optimization (New Pages)', taskType: 'aeo-geo', priority: 'LOW' },
    { title: 'Entity-Based SEO Optimization (New Pages)', taskType: 'aeo-geo', priority: 'MEDIUM' },

    // --- GSC ---
    { title: 'Coverage Report & Indexing Monitoring', taskType: 'technical-seo', priority: 'HIGH' },
    { title: 'Crawl Error Fixes', taskType: 'crawl-fix', priority: 'HIGH' },
    { title: 'Content Insights & Performance Analysis', taskType: 'reporting', priority: 'MEDIUM' },
    { title: 'Sitemap Submission Monitoring', taskType: 'technical-seo', priority: 'MEDIUM' },

    // --- Content Scaling ---
    { title: 'New Content Strategy (Zero-Click Pages)', taskType: 'content-writing', priority: 'HIGH' },
    { title: 'Blog Expansion for Zero-Click Pages', taskType: 'content-writing', priority: 'MEDIUM' },
    { title: 'Supporting Content for Zero-Click Pages', taskType: 'content-writing', priority: 'MEDIUM' },
    { title: 'Content Gap Filling (Zero-Click Pages)', taskType: 'content-writing', priority: 'MEDIUM' },

    // --- Topical Authority ---
    { title: 'Audit Topical Coverage & Expand Pillar Content (1 Service)', taskType: 'content-writing', priority: 'HIGH' },
    { title: 'Expand Cluster Pages (1 Service)', taskType: 'content-writing', priority: 'HIGH' },
    { title: 'Interlink Clusters (1 Service)', taskType: 'link-building', priority: 'MEDIUM' },
    { title: 'Update Low-Performing Pages (Content Pruning Report)', taskType: 'content-writing', priority: 'MEDIUM' },

    // --- Backlink Maintenance ---
    { title: 'Disavow Toxic Backlinks', taskType: 'link-building', priority: 'MEDIUM' },
    { title: 'Track Referral Traffic from Backlinks', taskType: 'reporting', priority: 'LOW' },

    // --- Advanced Technical ---
    { title: 'Perform Technical SEO Audit', taskType: 'technical-seo', priority: 'HIGH' },
    { title: 'Core Web Vitals Optimization', taskType: 'technical-seo', priority: 'HIGH' },
    { title: 'Crawl Budget Optimization', taskType: 'technical-seo', priority: 'MEDIUM' },
    { title: 'Schema Expansion', taskType: 'schema', priority: 'MEDIUM' },

    // --- Q1 Carryover ---
    { title: 'Update FAQs from FAQ Cluster Analysis', taskType: 'aeo-geo', priority: 'MEDIUM' },
    { title: 'Acquire Free Backlinks from Competitor Gap Analysis', taskType: 'link-building', priority: 'MEDIUM' },
  ];
}

function getMonth6Tasks() {
  return [
    // --- Competitive / Authority ---
    { title: 'High-Authority Backlinks Campaign', taskType: 'link-building', priority: 'HIGH' },
    { title: 'PR Coverage', taskType: 'link-building', priority: 'MEDIUM' },
    { title: 'Collaborate with Industry Experts (Co-Create Content)', taskType: 'content-writing', priority: 'MEDIUM' },
    { title: 'Publish Thought Leadership on External Platforms', taskType: 'content-writing', priority: 'LOW' },

    // --- Backlink (Low-Hang KWs) ---
    { title: 'Finalise Paid Backlink Website List', taskType: 'link-building', priority: 'MEDIUM' },
    { title: 'Identify Keywords/Pages for Paid Backlinks', taskType: 'keyword-research', priority: 'MEDIUM' },
    { title: 'Create & Ready Content for Paid Backlinks', taskType: 'content-writing', priority: 'MEDIUM' },
    { title: 'Acquire Backlinks from Paid Resources', taskType: 'link-building', priority: 'HIGH' },

    // --- Local SEO ---
    { title: 'Location-Based Pages Creation', taskType: 'local-seo', priority: 'MEDIUM' },
    { title: 'GBP Growth Activities', taskType: 'local-seo', priority: 'MEDIUM' },
    { title: 'Reviews Strategy Implementation', taskType: 'local-seo', priority: 'MEDIUM' },
    { title: 'Local Schema', taskType: 'schema', priority: 'MEDIUM' },

    // --- AEO / GEO ---
    { title: 'Implement Schema (High Impression Zero-Click Pages)', taskType: 'schema', priority: 'HIGH' },
    { title: 'Entity Strengthening (Zero-Click Pages)', taskType: 'aeo-geo', priority: 'HIGH' },
    { title: 'Analyse / Improve FAQ Section (New & Zero-Click Pages)', taskType: 'aeo-geo', priority: 'MEDIUM' },
    { title: 'Structured Content Formatting (New & Zero-Click Pages)', taskType: 'aeo-geo', priority: 'MEDIUM' },
    { title: 'Voice Search Optimization (New Pages)', taskType: 'aeo-geo', priority: 'LOW' },
    { title: 'Entity-Based SEO Optimization (New Pages)', taskType: 'aeo-geo', priority: 'MEDIUM' },

    // --- GSC ---
    { title: 'Coverage Report & Indexing Monitoring', taskType: 'technical-seo', priority: 'HIGH' },
    { title: 'Crawl Error Fixes', taskType: 'crawl-fix', priority: 'HIGH' },
    { title: 'Content Insights & Performance Analysis', taskType: 'reporting', priority: 'MEDIUM' },
    { title: 'Sitemap Submission Monitoring', taskType: 'technical-seo', priority: 'MEDIUM' },

    // --- Authority Building ---
    { title: 'High-Authority Backlinks Acquisition', taskType: 'link-building', priority: 'HIGH' },
    { title: 'Digital PR Outreach', taskType: 'link-building', priority: 'MEDIUM' },

    // --- Conversion Optimization ---
    { title: 'Funnel Optimization', taskType: 'cro', priority: 'HIGH' },
    { title: 'UI/UX Audit (Mobile/iPad Devices)', taskType: 'ux-audit', priority: 'MEDIUM' },
    { title: 'Form Optimization', taskType: 'cro', priority: 'MEDIUM' },
    { title: 'Add Live Chat Support for Real-Time Conversions', taskType: 'cro', priority: 'LOW' },

    // --- Website Enhancements ---
    { title: 'Technical Monitoring', taskType: 'technical-seo', priority: 'MEDIUM' },
    { title: 'Core Web Vitals Maintenance', taskType: 'technical-seo', priority: 'HIGH' },
    { title: 'Advanced Schema Implementation', taskType: 'schema', priority: 'HIGH' },

    // --- Q1 Carryover ---
    { title: 'Update FAQs from FAQ Cluster Analysis', taskType: 'aeo-geo', priority: 'MEDIUM' },
    { title: 'Acquire Free Backlinks from Competitor Gap Analysis', taskType: 'link-building', priority: 'MEDIUM' },

    // --- Final Report ---
    { title: 'Final Performance & KPI Report (Quarter)', taskType: 'reporting', priority: 'HIGH' },
    { title: '3-Month Performance Summary & Recommendations', taskType: 'reporting', priority: 'HIGH' },
  ];
}

// Month lookup
const MONTH_TASKS = {
  1: getMonth1Tasks,
  2: getMonth2Tasks,
  3: getMonth3Tasks,
  4: getMonth4Tasks,
  5: getMonth5Tasks,
  6: getMonth6Tasks,
};

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════════');
  console.log('  Interactive SEO Task Seeder');
  console.log('═══════════════════════════════════════════════════\n');

  // Find fallback PM
  const fallbackPm = await prisma.user.findFirst({
    where: { role: 'PM' },
    select: { id: true, name: true },
  });
  if (!fallbackPm) {
    console.log('No PM users found. Exiting.');
    return;
  }

  // Get all SEO projects
  const projects = await prisma.project.findMany({
    where: { projectType: 'SEO_CAMPAIGN' },
    include: { leadPm: true, client: true },
    orderBy: { name: 'asc' },
  });

  if (!projects.length) {
    console.log('No SEO projects found in database.');
    return;
  }

  console.log('Found SEO projects:\n');
  projects.forEach((p, i) => {
    console.log(`  [${i + 1}] ${p.name} (PM: ${p.leadPm?.name || 'none'})`);
  });
  console.log('');

  let totalCreated = 0;

  for (const project of projects) {
    const answer = await ask(`\n${project.name}\n  Which months to seed? (e.g. "4" or "1,2,3" or "skip"): `);

    if (!answer || answer.toLowerCase() === 'skip') {
      console.log('  → Skipped.');
      continue;
    }

    // Parse month numbers
    const months = answer.split(',').map((s) => parseInt(s.trim(), 10)).filter((n) => n >= 1 && n <= 6);

    if (!months.length) {
      console.log('  → No valid months entered. Skipped.');
      continue;
    }

    const leadPmId = project.leadPmId || fallbackPm.id;
    const pmName = project.leadPm?.name || fallbackPm.name;

    // Collect tasks for selected months
    let allTasks = [];
    for (const m of months) {
      const getter = MONTH_TASKS[m];
      if (getter) {
        const tasks = getter().map((t) => ({ ...t, milestone: `Month ${m}` }));
        allTasks = allTasks.concat(tasks);
      } else {
        console.log(`  ⚠️  Month ${m} has no task definitions.`);
      }
    }

    // Check for existing tasks to avoid duplicates
    const existingTasks = await prisma.task.findMany({
      where: { projectId: project.id },
      select: { title: true },
    });
    const existingTitles = new Set(existingTasks.map((t) => t.title));

    let created = 0;
    let skipped = 0;

    for (const task of allTasks) {
      if (existingTitles.has(task.title)) {
        skipped++;
        continue;
      }

      await prisma.task.create({
        data: {
          projectId: project.id,
          title: task.title,
          taskType: task.taskType,
          priority: task.priority || 'MEDIUM',
          status: 'TO_DO',
          milestone: task.milestone || null,
          description: task.description || null,
          clientVisible: true,
          createdById: leadPmId,
          assignees: { connect: [{ id: leadPmId }] },
        },
      });
      created++;
    }

    totalCreated += created;
    console.log(`  ✅ ${project.name} → Created: ${created} | Skipped: ${skipped} (assigned to ${pmName})`);
  }

  console.log(`\n═══════════════════════════════════════════════════`);
  console.log(`  DONE: ${totalCreated} total tasks created.`);
  console.log(`═══════════════════════════════════════════════════\n`);
}

main()
  .catch((e) => { console.error('Error:', e); process.exit(1); })
  .finally(() => prisma.$disconnect());
