import json
from pathlib import Path
from openai import OpenAI
from utils.storage import search_knowledge_context, write_okf_file, slugify, read_okf_file_by_path

def generate_content_opportunities(api_key: str, client_slug: str, keyword: str, service: str, topic: str):
    """
    Finds content opportunities (intent, questions, FAQ ideas, AI visibility, article concepts)
    grounded in matching knowledge base assets.
    """
    # 1. Search knowledge base for matching context
    search_query = f"{keyword} {service} {topic}"
    matches = search_knowledge_context(client_slug, search_query, limit=5)
    
    context_blocks = []
    for match in matches:
        asset = match["asset"]
        context_blocks.append(f"Source Document: {asset['title']} (Folder: {asset['folder']})\nContent:\n{match['body'][:3000]}")
        
    context_text = "\n\n---\n\n".join(context_blocks) if context_blocks else "No matching internal documents found."
    
    client = OpenAI(api_key=api_key)
    
    system_prompt = """
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
    """
    
    user_prompt = f"""
    USER INPUTS:
    - Keyword: {keyword}
    - Service: {service}
    - Topic: {topic}
    
    KNOWLEDGE BASE CONTEXT:
    {context_text}
    """
    
    response = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ],
        response_format={"type": "json_object"},
        temperature=0.4
    )
    
    result = json.loads(response.choices[0].message.content)
    return result

def save_opportunities(client_slug: str, topic: str, opp_results: dict):
    """Saves opportunities as an OKF file."""
    metadata = {
        "type": "content-opportunities",
        "title": f"Content Opportunities: {topic}",
        "tags": ["content-opportunity", "seo-insights", "keywords"]
    }
    
    body = f"# Content Opportunities: {topic}\n\n"
    body += f"### Search Intent Analysis\n{opp_results.get('search_intent', '')}\n\n"
    
    body += "### 10 Target Customer Questions\n"
    for idx, q in enumerate(opp_results.get("questions", []), 1):
        body += f"{idx}. {q}\n"
    body += "\n"
    
    body += "### FAQ Opportunities\n"
    for faq in opp_results.get("faq_opportunities", []):
        body += f"- **Q**: {faq.get('question', '')}\n"
        body += f"  - **Concept**: {faq.get('concept', '')}\n\n"
        
    body += f"### AI Visibility & Search Engine Optimization Insights\n{opp_results.get('ai_visibility_insights', '')}\n\n"
    
    body += "### Recommended Article Concepts\n"
    for concept in opp_results.get("article_concepts", []):
        body += f"#### {concept.get('title', '')}\n"
        body += f"- **Hook**: *{concept.get('hook', '')}*\n"
        body += f"- **Brief**: {concept.get('brief', '')}\n\n"
        
    filename = f"opportunities-{slugify(topic)}"
    file_path = write_okf_file(client_slug, "content", filename, metadata, body)
    return file_path

def generate_article(api_key: str, client_slug: str, topic: str, selected_question: str, selected_asset_paths: list):
    """
    Generates a full-length article outline, draft, FAQs, internal links, and schema markup
    leveraging the selected knowledge assets.
    """
    # 1. Fetch text of selected assets
    context_blocks = []
    for asset_path in selected_asset_paths:
        try:
            p = Path(asset_path)
            meta, body = read_okf_file_by_path(p)
            context_blocks.append(f"Document Name: {meta.get('title', p.name)}\nFolder: {p.parent.name}\nContent:\n{body}")
        except Exception as e:
            context_blocks.append(f"Failed to read asset {asset_path}: {str(e)}")
            
    context_text = "\n\n---\n\n".join(context_blocks) if context_blocks else "No reference assets selected."
    
    client = OpenAI(api_key=api_key)
    
    system_prompt = """
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
    """
    
    user_prompt = f"""
    TOPIC: {topic}
    CUSTOMER QUESTION ADDRESSED: {selected_question}
    
    KNOWLEDGE BASE REFERENCE ASSETS:
    {context_text}
    """
    
    response = client.chat.completions.create(
        model="gpt-4o", # Use GPT-4o for better writing quality
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ],
        response_format={"type": "json_object"},
        temperature=0.5
    )
    
    result = json.loads(response.choices[0].message.content)
    return result

def save_article(client_slug: str, topic: str, article_results: dict, selected_assets_meta: list):
    """Saves article output to content/articles folder."""
    metadata = {
        "type": "article",
        "title": article_results.get("article_title", topic),
        "source_assets": selected_assets_meta,
        "tags": ["blog-article", "content-marketing", "knowledge-operationalized"]
    }
    
    body = f"# {article_results.get('article_title', topic)}\n\n"
    
    body += "### Article Outline\n"
    body += f"{article_results.get('outline', '')}\n\n"
    body += "---\n\n"
    
    body += f"### Article Draft\n\n{article_results.get('draft', '')}\n\n"
    body += "---\n\n"
    
    body += "### Frequently Asked Questions\n"
    for faq in article_results.get("faqs", []):
        body += f"#### Q: {faq.get('q', '')}\n"
        body += f"A: {faq.get('a', '')}\n\n"
        
    body += "### Suggested Internal Links\n"
    for link in article_results.get("suggested_internal_links", []):
        body += f"- {link}\n"
    body += "\n"
    
    body += "### Suggested SEO JSON-LD Schema Markup\n"
    body += f"```html\n<script type=\"application/ld+json\">\n{article_results.get('schema_markup', '')}\n</script>\n```\n"
    
    filename = slugify(topic)
    file_path = write_okf_file(client_slug, "content/articles", filename, metadata, body)
    return file_path
