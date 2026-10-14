/**
 * Interview question bank and template catalog (plan §2–§3).
 *
 * Pure data. `interviewAgenda.js` picks from here to fill an agenda; the email
 * renderer uses `topic` (a short line) and the live interviewer uses `prompt`
 * and `probe`. Keep folders inside CAPTURE_FOLDERS (expertInterview.js) — the
 * folder enum must stay identical across realtimeVoice.js, expertInterview.js
 * and this file.
 */

/** Human labels for OKF folders, used to group agenda topics in emails and UI. */
export const FOLDER_LABELS = {
  company: 'Your business',
  services: 'Services',
  products: 'Products',
  locations: 'Areas you cover',
  competitors: 'Competitors',
  faq: 'Customer questions',
  proof: 'Proof and results',
  'proof/case-studies': 'Recent jobs and case studies',
  'proof/testimonials': 'Customer feedback',
  'proof/reviews': 'Reviews',
  voice: 'How you sound',
  'seo/local': 'Offers and local news',
  'seo/strategy': 'Goals',
};

export function folderLabel(folder) {
  return FOLDER_LABELS[folder] || FOLDER_LABELS[String(folder || '').split('/')[0]] || 'Other';
}

/** Fact types the interviewer may tag a capture with. */
export const FACT_TYPES = [
  'fact',
  'person',
  'claim',
  'service',
  'price',
  'number',
  'hours',
  'contact',
  'location',
  'story',
  'testimonial',
  'faq',
  'preference',
  'promo',
];

export const INTERVIEW_TEMPLATES = {
  ONBOARDING: {
    key: 'ONBOARDING',
    label: 'Onboarding',
    description: 'First interview with a new client: who they are, what they sell, where, and what we may claim.',
    defaultMinutes: 25,
    goal: 'Get the basics right so everything we write for you is accurate from day one.',
  },
  MONTHLY_UPDATE: {
    key: 'MONTHLY_UPDATE',
    label: 'Monthly business update',
    description: 'What changed this month: hours, prices, staff, services, recent jobs and upcoming offers.',
    defaultMinutes: 10,
    goal: 'Catch up on what changed this month so your website and listings stay fresh.',
  },
  GAP_FILL: {
    key: 'GAP_FILL',
    label: 'Fill knowledge gaps',
    description: 'Targeted questions for the gaps in the knowledge base.',
    defaultMinutes: 15,
    goal: 'Fill in a few details we are missing so we can write about you with confidence.',
  },
  SEASONAL_PROMO: {
    key: 'SEASONAL_PROMO',
    label: 'Seasonal promotion',
    description: 'Upcoming offers, events and seasonal pushes.',
    defaultMinutes: 10,
    goal: 'Plan your next offer or seasonal push.',
  },
  CASE_STUDY: {
    key: 'CASE_STUDY',
    label: 'Case study',
    description: 'One recent job in detail, with permission to publish.',
    defaultMinutes: 15,
    goal: 'Turn a recent job you are proud of into a case study.',
  },
  REPUTATION: {
    key: 'REPUTATION',
    label: 'Reputation',
    description: 'Customer objections, how to respond to reviews, and proof.',
    defaultMinutes: 15,
    goal: 'Understand what customers worry about and how you want us to respond.',
  },
  NEW_LAUNCH: {
    key: 'NEW_LAUNCH',
    label: 'New service or location',
    description: 'Everything we need to launch a new service or location page.',
    defaultMinutes: 15,
    goal: 'Get the details for your new service or location so we can launch it properly.',
  },
  CUSTOM: {
    key: 'CUSTOM',
    label: 'Custom',
    description: 'Owner-written agenda.',
    defaultMinutes: 20,
    goal: 'Help us get the details right so everything we write for you is accurate.',
  },
};

export const TEMPLATE_KEYS = Object.keys(INTERVIEW_TEMPLATES);

const ALL = TEMPLATE_KEYS;

/**
 * Bank items: {id, folder, factType, topic, prompt, probe, seoPurpose, templates[]}.
 * `topic` is the short email line; `prompt` is what the interviewer asks.
 */
export const QUESTION_BANK = [
  // ── company ──
  { id: 'company-what-you-do', folder: 'company', factType: 'fact',
    topic: 'What the business does and who it is for',
    prompt: 'In your own words, what does the business do and who is it for?',
    probe: 'Who is your ideal customer, specifically?',
    seoPurpose: 'Entity description (Organization schema)', templates: ['ONBOARDING', 'GAP_FILL', 'CUSTOM'] },
  { id: 'company-history', folder: 'company', factType: 'person',
    topic: 'How long you have been trading, and who founded it',
    prompt: 'How long have you been trading, and who founded the business?',
    probe: 'What year exactly, and what is the founder\'s full name and role today?',
    seoPurpose: 'E-E-A-T, Organization/Person schema', templates: ['ONBOARDING', 'GAP_FILL'] },
  { id: 'company-team', folder: 'company', factType: 'person',
    topic: 'The people customers deal with, and their qualifications',
    prompt: 'Who are the key people customers deal with, and what qualifications or experience do they have?',
    probe: 'May we name them on the website?',
    seoPurpose: 'E-E-A-T author/staff entities', templates: ['ONBOARDING', 'GAP_FILL'] },
  { id: 'company-hours', folder: 'company', factType: 'hours',
    topic: 'Your opening hours — has anything changed?',
    prompt: 'What are your opening hours now, including weekends and holidays?',
    probe: 'Any emergency or out-of-hours service?',
    seoPurpose: 'NAP + hours consistency (GBP, LocalBusiness schema)', templates: ['ONBOARDING', 'MONTHLY_UPDATE'] },
  { id: 'company-contact', folder: 'company', factType: 'contact',
    topic: 'Phone, email and address customers should use',
    prompt: 'Which phone number, email and address should customers use?',
    probe: 'Is that the same everywhere — website, Google, directories?',
    seoPurpose: 'NAP consistency', templates: ['ONBOARDING'] },
  { id: 'company-approved-claims', folder: 'company', factType: 'claim',
    topic: 'Guarantees and accreditations we may state',
    prompt: 'Which guarantees, accreditations or awards may we state exactly as written?',
    probe: 'Can you give me the exact wording and the year?',
    seoPurpose: 'Compliance gate for all content', templates: ['ONBOARDING', 'GAP_FILL', 'NEW_LAUNCH'] },
  { id: 'company-restricted-claims', folder: 'company', factType: 'claim',
    topic: 'Anything we must never claim',
    prompt: 'Is there anything we must never claim or say about the business?',
    probe: 'Any regulatory or legal reason behind that?',
    seoPurpose: 'Compliance gate for all content', templates: ['ONBOARDING', 'GAP_FILL'] },
  { id: 'company-changes', folder: 'company', factType: 'fact',
    topic: 'Anything that changed recently — staff, prices, hours',
    prompt: 'What has changed in the business since we last spoke — staff, prices, hours, anything?',
    probe: 'Since when exactly?',
    seoPurpose: 'Freshness', templates: ['MONTHLY_UPDATE'] },

  // ── services ──
  { id: 'services-main', folder: 'services', factType: 'service',
    topic: 'Your main services, and which ones matter most',
    prompt: 'Which services bring in most of your work, and which do you want more of?',
    probe: 'Roughly what share of jobs is each?',
    seoPurpose: 'Service pages and internal links', templates: ['ONBOARDING', 'GAP_FILL'] },
  { id: 'services-typical-job', folder: 'services', factType: 'service',
    topic: 'What a typical job involves, how long it takes and what it costs',
    prompt: 'Walk me through a typical job for your main service: the steps, how long it takes, what it costs from, and what is included.',
    probe: 'What is the starting price, and what makes it go up?',
    seoPurpose: 'Service schema, non-thin service pages', templates: ['ONBOARDING', 'GAP_FILL', 'NEW_LAUNCH'] },
  { id: 'services-new', folder: 'services', factType: 'service',
    topic: 'New services you have started or stopped',
    prompt: 'Have you started offering anything new, or stopped offering anything, recently?',
    probe: 'When did it start, and who is it for?',
    seoPurpose: 'New service pages', templates: ['MONTHLY_UPDATE', 'NEW_LAUNCH'] },
  { id: 'services-prices', folder: 'services', factType: 'price',
    topic: 'Prices — anything changed?',
    prompt: 'Have any of your prices changed recently?',
    probe: 'What was it before and what is it now?',
    seoPurpose: 'Accurate Offer data', templates: ['MONTHLY_UPDATE'] },

  // ── products ──
  { id: 'products-new', folder: 'products', factType: 'service',
    topic: 'New products or suppliers',
    prompt: 'Any new products, brands or suppliers this quarter?',
    probe: 'Why did you choose them?',
    seoPurpose: 'Product/Offer schema', templates: ['MONTHLY_UPDATE', 'NEW_LAUNCH'] },

  // ── locations ──
  { id: 'locations-areas', folder: 'locations', factType: 'location',
    topic: 'The towns and areas you genuinely cover',
    prompt: 'Which towns or areas do you genuinely travel to? Any you turn down?',
    probe: 'Is there a call-out charge for the further ones?',
    seoPurpose: 'Service-area pages, GBP areas', templates: ['ONBOARDING', 'GAP_FILL', 'NEW_LAUNCH'] },
  { id: 'locations-new', folder: 'locations', factType: 'location',
    topic: 'Any new areas or a new branch',
    prompt: 'Are you covering any new areas, or opening a new location?',
    probe: 'When does it start, and what is the address?',
    seoPurpose: 'Location pages', templates: ['MONTHLY_UPDATE', 'NEW_LAUNCH'] },

  // ── proof ──
  { id: 'proof-recent-job', folder: 'proof/case-studies', factType: 'story',
    topic: 'One recent job you are proud of',
    prompt: 'Tell me about one job last month you are proud of: where it was, the problem, what you did, and the result in numbers.',
    probe: 'Can we name the customer or the town?',
    seoPurpose: 'E-E-A-T, case-study pages', templates: ['ONBOARDING', 'MONTHLY_UPDATE', 'CASE_STUDY'] },
  { id: 'proof-case-detail', folder: 'proof/case-studies', factType: 'story',
    topic: 'The details behind that job: timeline, numbers, result',
    prompt: 'For that job: how long did it take, what did it cost the customer, and what changed for them afterwards?',
    probe: 'Do you have before and after photos?',
    seoPurpose: 'Case-study pages with real numbers', templates: ['CASE_STUDY'] },
  { id: 'proof-testimonial', folder: 'proof/testimonials', factType: 'testimonial',
    topic: 'Things customers have said about you',
    prompt: 'What is something a customer said about you recently that stuck with you?',
    probe: 'May we publish that with their name?',
    seoPurpose: 'Review schema, social proof', templates: ['ONBOARDING', 'CASE_STUDY', 'REPUTATION'] },
  { id: 'proof-numbers', folder: 'proof', factType: 'number',
    topic: 'Numbers that prove you are good — jobs done, response times',
    prompt: 'Are there any numbers that show you are good at this — jobs completed, response times, repeat customers?',
    probe: 'Where does that number come from?',
    seoPurpose: 'Quotable stats for AI answers', templates: ['ONBOARDING', 'GAP_FILL'] },
  { id: 'proof-reviews-response', folder: 'proof/reviews', factType: 'preference',
    topic: 'How you want us to respond to reviews',
    prompt: 'When someone leaves a disappointing review, how do you want us to respond?',
    probe: 'Anything we should never say in a reply?',
    seoPurpose: 'Review replies, reputation', templates: ['REPUTATION'] },

  // ── faq ──
  { id: 'faq-before-booking', folder: 'faq', factType: 'faq',
    topic: 'What customers ask before they book',
    prompt: 'What do customers usually ask you before they book?',
    probe: 'How do you answer that, in two sentences?',
    seoPurpose: 'FAQPage schema, AI answer snippets', templates: ['ONBOARDING', 'GAP_FILL', 'REPUTATION', 'SEASONAL_PROMO'] },
  { id: 'faq-objections', folder: 'faq', factType: 'faq',
    topic: 'What stops people from booking',
    prompt: 'What stops people from booking with you, or makes them go elsewhere?',
    probe: 'What do you say to change their mind?',
    seoPurpose: 'Objection handling content', templates: ['REPUTATION', 'GAP_FILL'] },

  // ── voice ──
  { id: 'voice-tone', folder: 'voice', factType: 'preference',
    topic: 'How you want to sound in writing',
    prompt: 'How do you want to sound in writing — formal or casual, technical or plain English?',
    probe: 'Any words you love, or words that make you cringe?',
    seoPurpose: 'Content generation tone', templates: ['ONBOARDING', 'GAP_FILL'] },

  // ── competitors ──
  { id: 'competitors-lose-to', folder: 'competitors', factType: 'fact',
    topic: 'Who you lose jobs to, and why',
    prompt: 'Who do you lose jobs to, and why do customers pick them?',
    probe: 'What do you do better than them?',
    seoPurpose: 'Positioning, competitor audits', templates: ['ONBOARDING', 'GAP_FILL'] },

  // ── seo/local ──
  { id: 'local-promo', folder: 'seo/local', factType: 'promo',
    topic: 'Any offer, event or seasonal push in the next six weeks',
    prompt: 'Do you have any offer, event or seasonal push coming up in the next six weeks?',
    probe: 'What are the exact dates and terms?',
    seoPurpose: 'GBP posts, freshness', templates: ['MONTHLY_UPDATE', 'SEASONAL_PROMO'] },
  { id: 'local-season', folder: 'seo/local', factType: 'promo',
    topic: 'Your busy and quiet seasons',
    prompt: 'When are your busy and quiet seasons, and what do people need at those times?',
    probe: 'Anything you want to push in the quiet months?',
    seoPurpose: 'Seasonal content planning', templates: ['SEASONAL_PROMO', 'ONBOARDING'] },
];

/** Bank items for a template, in bank order. */
export function bankForTemplate(templateKey) {
  const key = INTERVIEW_TEMPLATES[templateKey] ? templateKey : 'CUSTOM';
  return QUESTION_BANK.filter((q) => q.templates.includes(key) || (key === 'CUSTOM' && q.templates.includes('ONBOARDING')));
}

/** Small public catalog for the admin UI. */
export function templateCatalog() {
  return TEMPLATE_KEYS.map((key) => ({
    ...INTERVIEW_TEMPLATES[key],
    questionCount: bankForTemplate(key).length,
  }));
}

export { ALL as ALL_TEMPLATE_KEYS };
