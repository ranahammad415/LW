import json
import datetime
from openai import OpenAI
from utils.storage import list_client_files, read_okf_file, write_okf_file, slugify

def analyze_knowledge_gaps(api_key: str, client_slug: str):
    """
    Scans the client's folder, extracts the profile metadata, builds a list of existing
    assets, and calls OpenAI to find knowledge gaps and suggest questionnaire items.
    """
    # 1. Read Client Profile
    profile_data = {}
    try:
        profile_meta, profile_body = read_okf_file(client_slug, "company", "client-profile.md")
        profile_data = {
            "company_name": profile_meta.get("company_name"),
            "website": profile_meta.get("website"),
            "industry": profile_meta.get("industry"),
            "services": profile_meta.get("services"),
            "competitors": profile_meta.get("competitors"),
            "differentiators": profile_meta.get("differentiators"),
            "target_customers": profile_meta.get("target_customers"),
            "profile_details": profile_body
        }
    except Exception:
        # Fallback if profile doesn't exist
        profile_data = {
            "company_name": client_slug.replace("-", " ").title(),
            "services": "Unknown - profile not created",
            "profile_details": "No profile exists yet. Please complete client setup."
        }
        
    # 2. List all existing assets
    existing_assets = list_client_files(client_slug)
    
    asset_summaries = []
    for asset in existing_assets:
        # Don't list gap analysis reports themselves as knowledge context
        if asset["folder"] == "knowledge-gaps":
            continue
        asset_summaries.append({
            "title": asset["title"],
            "folder": asset["folder"],
            "type": asset["type"],
            "excerpt": asset["excerpt"]
        })
        
    client = OpenAI(api_key=api_key)
    
    system_prompt = """
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
    """
    
    user_prompt = f"""
    CLIENT PROFILE:
    {json.dumps(profile_data, indent=2)}
    
    EXISTING KNOWLEDGE CATALOG:
    {json.dumps(asset_summaries, indent=2)}
    """
    
    response = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ],
        response_format={"type": "json_object"},
        temperature=0.2
    )
    
    result = json.loads(response.choices[0].message.content)
    return result

def save_gap_analysis(client_slug: str, analysis_results: dict):
    """
    Converts raw gap analysis results into an OKF markdown document and saves it.
    """
    today_str = datetime.date.today().isoformat()
    metadata = {
        "type": "gap-analysis",
        "title": f"Knowledge Gap Analysis - {today_str}",
        "readiness_score": analysis_results.get("readiness_score", 0),
        "tags": ["gap-analysis", "knowledge-audit", "recommended-questions"]
    }
    
    body = f"# Knowledge Gap Analysis: {today_str}\n\n"
    body += f"**Overall Readiness Score**: {analysis_results.get('readiness_score', 0)}/100\n\n"
    body += f"### Summary Evaluation\n{analysis_results.get('findings_summary', '')}\n\n"
    
    body += "### Identified Gaps\n"
    gaps = analysis_results.get("gaps", [])
    if gaps:
        for idx, gap in enumerate(gaps, 1):
            body += f"#### {idx}. [{gap.get('category', '').upper()}] - {gap.get('severity', 'Medium')} Severity\n"
            body += f"- **Description**: {gap.get('description', '')}\n"
            body += f"- **Impact**: {gap.get('impact', '')}\n\n"
    else:
        body += "No significant gaps identified. The knowledge base is robust!\n\n"
        
    body += "### Recommended Interview Questions\n"
    questions = analysis_results.get("recommended_questions", [])
    if questions:
        body += "Ask these questions to the business expert to resolve identified gaps:\n\n"
        for q in questions:
            body += f"- **Category**: {q.get('category', '').title()}\n"
            body += f"  - **Question**: *{q.get('question', '')}*\n"
            body += f"  - **Goal**: {q.get('reason', '')}\n\n"
    else:
        body += "No new interview questions recommended.\n"
        
    filename = f"gap-analysis-{today_str}"
    file_path = write_okf_file(client_slug, "knowledge-gaps", filename, metadata, body)
    return file_path
