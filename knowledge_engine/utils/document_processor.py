import os
import json
import pandas as pd
from pypdf import PdfReader
from docx import Document
from openai import OpenAI

def extract_pdf_text(file_path) -> str:
    """Extracts raw text from a PDF file."""
    reader = PdfReader(file_path)
    text = []
    for page in reader.pages:
        page_text = page.extract_text()
        if page_text:
            text.append(page_text)
    return "\n".join(text)

def extract_docx_text(file_path) -> str:
    """Extracts raw text from a DOCX file."""
    doc = Document(file_path)
    text = []
    for para in doc.paragraphs:
        if para.text:
            text.append(para.text)
    return "\n".join(text)

def extract_csv_text(file_path) -> str:
    """Extracts tabular CSV data and formats it as a markdown table."""
    df = pd.read_csv(file_path)
    # Convert dataframe to a clean markdown table
    return df.to_markdown(index=False)

def extract_file_content(file_path, file_extension: str) -> str:
    """Route file parsing by extension."""
    ext = file_extension.lower().strip(".")
    if ext == "pdf":
        return extract_pdf_text(file_path)
    elif ext in ["docx", "doc"]:
        return extract_docx_text(file_path)
    elif ext == "csv":
        return extract_csv_text(file_path)
    elif ext in ["txt", "md", "markdown"]:
        with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
            return f.read()
    else:
        raise ValueError(f"Unsupported file format: .{ext}")

def analyze_document_with_ai(api_key: str, doc_text: str, original_filename: str):
    """
    Sends extracted document text to OpenAI for structured summary, classification, and metadata extraction.
    """
    client = OpenAI(api_key=api_key)
    
    system_prompt = """
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
    """
    
    user_prompt = f"Original Filename: {original_filename}\n\nRaw Extracted Content:\n{doc_text[:12000]}" # Cap context to ~12k chars for safety
    
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
