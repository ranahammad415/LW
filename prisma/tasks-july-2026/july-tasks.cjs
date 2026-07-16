/**
 * july-tasks.cjs
 * July 2026 monthly SEO task plan (from "July Task 2026.xlsx").
 * Same template is applied to every SEO campaign project.
 *
 * Shape: { title, taskType, priority, milestone (Category), section, assigneeKey, description }
 */
module.exports = [
  // ═══ On-Page SEO ═══
  {
    title: 'Keyword Research & Mapping',
    taskType: 'keyword-research',
    priority: 'HIGH',
    milestone: 'On-Page SEO',
    section: 'Research',
    assigneeKey: 'haider',
    description:
      'Conduct keyword research, identify primary and supporting keywords, analyze search intent, and map each primary keyword to a single relevant page to prevent keyword cannibalization.',
  },
  {
    title: 'Content Gap Analysis',
    taskType: 'content-audit',
    priority: 'HIGH',
    milestone: 'On-Page SEO',
    section: 'Research',
    assigneeKey: 'haider',
    description:
      'Proper Content Gap Analysis Of Top Competitors Strategy and Structure Mention in Report (Collaborate With Content Writer and Implement Relevant Strategy)',
  },
  {
    title: 'SEO Title Optimization / Meta Description Optimization',
    taskType: 'meta-optimisation',
    priority: 'HIGH',
    milestone: 'On-Page SEO',
    section: 'Metadata',
    assigneeKey: 'haider',
    description:
      'Improve Meta Title With Sentiments Strategy and Power Words (Low Impression with Zero Click Pages) / (Optimized Meta Description Low impression With Zero Click Page and Adjust Keyword With Semantic Entities)',
  },
  {
    title: 'Service Page Optimization',
    taskType: 'on-page-seo',
    priority: 'HIGH',
    milestone: 'On-Page SEO',
    section: 'Content',
    assigneeKey: 'haider',
    description:
      'Review and optimize service pages for keyword relevance, search intent, content quality, EEAT, NLP Keywords internal linking, schema markup, and conversion-focused elements to improve rankings and lead generation.',
  },
  {
    title: 'Location Page Optimization',
    taskType: 'on-page-seo',
    priority: 'HIGH',
    milestone: 'On-Page SEO',
    section: 'Content',
    assigneeKey: 'haider',
    description:
      'Review and optimize location pages for local search intent, location-specific keywords, unique content, NAP consistency, internal linking, local schema, and conversion-focused elements to improve local rankings.',
  },
  {
    title: 'Pillar Page Optimization',
    taskType: 'on-page-seo',
    priority: 'MEDIUM',
    milestone: 'On-Page SEO',
    section: 'Content',
    assigneeKey: 'haider',
    description:
      'Review and optimize pillar pages by expanding topic coverage, strengthening internal links to supporting content, improving EEAT, entity optimization, NLP Keywords and content structure to enhance topical authority and organic rankings.',
  },
  {
    title: 'Internal Linking',
    taskType: 'on-page-seo',
    priority: 'HIGH',
    milestone: 'On-Page SEO',
    section: 'Internal',
    assigneeKey: 'haider',
    description:
      'Review and optimize internal links, anchor text, and orphan pages to improve website structure, crawlability, user navigation, and link equity distribution.',
  },
  {
    title: 'Entity, Semantic & NLP Optimization (For New Blog)',
    taskType: 'content-writing',
    priority: 'MEDIUM',
    milestone: 'On-Page SEO',
    section: 'Content',
    assigneeKey: 'haider',
    description:
      'Identify and integrate relevant entities (people, places, services, and concepts) naturally throughout the content to strengthen topical authority, semantic relevance, NLP Keywords and search engine understanding.',
  },

  // ═══ Technical SEO ═══
  {
    title: 'Website Crawl Audit',
    taskType: 'technical-seo',
    priority: 'HIGH',
    milestone: 'Technical SEO',
    section: 'Technical',
    assigneeKey: 'haider',
    description:
      'Perform a full website crawl to identify crawl errors, broken links, redirect issues, duplicate content, indexability problems, and other technical SEO issues that impact search performance.',
  },
  {
    title: 'Index Coverage Audit',
    taskType: 'technical-seo',
    priority: 'HIGH',
    milestone: 'Technical SEO',
    section: 'Technical',
    assigneeKey: 'haider',
    description:
      "Review Google Search Console's Index Coverage report to identify indexing errors, excluded pages, and opportunities to improve indexability and search visibility.",
  },
  {
    title: 'Canonical Audit',
    taskType: 'technical-seo',
    priority: 'MEDIUM',
    milestone: 'Technical SEO',
    section: 'Technical',
    assigneeKey: 'haider',
    description:
      'Audit canonical tags across the website to ensure the preferred URL is correctly specified, eliminate conflicting canonicals, and prevent duplicate content and indexing issues.',
  },
  {
    title: 'XML Sitemap Audit',
    taskType: 'technical-seo',
    priority: 'MEDIUM',
    milestone: 'Technical SEO',
    section: 'Technical',
    assigneeKey: 'haider',
    description:
      'Review the XML sitemap to ensure it includes only canonical, indexable URLs, excludes non-indexable pages, and is properly submitted and monitored in Google Search Console and Bing Webmaster Tools.',
  },
  {
    title: 'Core Web Vitals',
    taskType: 'technical-seo',
    priority: 'HIGH',
    milestone: 'Technical SEO',
    section: 'Technical',
    assigneeKey: 'haider',
    description:
      'Audit Core Web Vitals using PageSpeed Insights, Google Search Console, and Lighthouse, then optimize LCP, INP, and CLS to improve loading performance, responsiveness, visual stability, and overall user experience.',
  },
  {
    title: 'PageSpeed Optimization',
    taskType: 'technical-seo',
    priority: 'HIGH',
    milestone: 'Technical SEO',
    section: 'Technical',
    assigneeKey: 'haider',
    description:
      'Analyze PageSpeed Insights recommendations and optimize images, CSS, JavaScript, caching, server response, resource loading, and code efficiency to improve page speed and overall website performance.',
  },
  {
    title: 'Redirect Audit',
    taskType: 'crawl-fix',
    priority: 'MEDIUM',
    milestone: 'Technical SEO',
    section: 'Technical',
    assigneeKey: 'haider',
    description:
      'Analyze all website redirects to identify redirect chains, loops, broken redirects, incorrect redirect types, and non-canonical redirect paths, then implement best practices to improve crawl efficiency and preserve link equity.',
  },
  {
    title: '404 Audit & Broken Link Audit',
    taskType: 'crawl-fix',
    priority: 'HIGH',
    milestone: 'Technical SEO',
    section: 'Technical',
    assigneeKey: 'haider',
    description:
      'Audit the website to identify 404 errors, soft 404 pages, broken internal and external links, broken images, and missing resources, then implement redirects or updates to restore accessibility and maintain SEO value.',
  },

  // ═══ Off-Page SEO ═══
  {
    title: 'Guest Posting',
    taskType: 'link-building',
    priority: 'HIGH',
    milestone: 'Off-Page SEO',
    section: 'Links',
    assigneeKey: 'haider',
    description:
      'Research niche-relevant websites, evaluate domain quality, conduct outreach, publish valuable guest content, and secure contextual backlinks that comply with SEO best practices.',
  },
  {
    title: 'Niche Edits',
    taskType: 'link-building',
    priority: 'HIGH',
    milestone: 'Off-Page SEO',
    section: 'Links',
    assigneeKey: 'haider',
    description:
      'Research authoritative websites with relevant existing content, evaluate page quality, conduct outreach, and secure natural contextual backlinks within indexed articles to strengthen domain authority and search visibility.',
  },
  {
    title: 'Broken Link Building',
    taskType: 'link-building',
    priority: 'MEDIUM',
    milestone: 'Off-Page SEO',
    section: 'Links',
    assigneeKey: 'haider',
    description:
      'Research relevant websites to identify broken outbound links, create or match suitable replacement content, conduct outreach, and secure contextual backlinks by replacing broken resources.',
  },
  {
    title: 'Competitor Backlink Analysis',
    taskType: 'link-building',
    priority: 'HIGH',
    milestone: 'Off-Page SEO',
    section: 'Links',
    assigneeKey: 'haider',
    description:
      "Analyze competitors' backlink profiles to identify authoritative referring domains, anchor text patterns, top-linked content, and link-building opportunities that can be replicated to improve the client's backlink authority.",
  },
  {
    title: 'Digital PR',
    taskType: 'link-building',
    priority: 'MEDIUM',
    milestone: 'Off-Page SEO',
    section: 'Outreach',
    assigneeKey: 'haider',
    description:
      'Create data-driven or newsworthy content, identify relevant journalists and publications, conduct targeted outreach, and secure editorial coverage, brand mentions, and authoritative backlinks that enhance brand authority and organic visibility.',
  },
  {
    title: 'Citation Building',
    taskType: 'local-seo',
    priority: 'MEDIUM',
    milestone: 'Off-Page SEO',
    section: 'Local',
    assigneeKey: 'haider',
    description:
      'Build and optimize consistent NAP citations across high-authority local and industry directories to strengthen entity signals, improve local relevance, and reinforce search engine trust through structured business listings.',
  },
  {
    title: 'GBP Optimization',
    taskType: 'local-seo',
    priority: 'HIGH',
    milestone: 'Off-Page SEO',
    section: 'Local',
    assigneeKey: 'haider',
    description:
      'Optimize Google Business Profile with complete and keyword-aligned business information, category selection, service listings, posts, images, reviews strategy, and regular updates to strengthen local relevance, engagement, and map pack performance.',
  },

  // ═══ Local SEO ═══
  {
    title: 'Local Landing Page Optimization',
    taskType: 'local-seo',
    priority: 'HIGH',
    milestone: 'Local SEO',
    section: 'Local',
    assigneeKey: 'haider',
    description:
      'Optimize location-specific landing pages with geo-targeted keywords, structured headings, localized content, internal linking, schema markup, and conversion-focused elements to improve relevance for local search intent and strengthen organic visibility across target areas.',
  },
  {
    title: 'Local Schema',
    taskType: 'schema',
    priority: 'HIGH',
    milestone: 'Local SEO',
    section: 'Local',
    assigneeKey: 'haider',
    description:
      'Implement and optimize structured data (LocalBusiness, Service, FAQ, Review, and Organization schema) to improve search engine understanding of business identity, services, location relevance, and enhance eligibility for rich results and local SERP features.',
  },
];
