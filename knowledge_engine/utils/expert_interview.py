import json
from openai import OpenAI
from utils.storage import write_okf_file, slugify

CORE_QUESTIONS = [
    {
        "id": "misunderstandings",
        "category": "Customer Misunderstandings",
        "question": "What do customers commonly misunderstand about your business, industry, or services?"
    },
    {
        "id": "mistakes",
        "category": "Customer Mistakes",
        "question": "What are the biggest mistakes customers make before or during their engagement with your service?"
    },
    {
        "id": "faq_sales",
        "category": "Sales FAQs",
        "question": "What questions come up repeatedly during sales calls or onboarding?"
    },
    {
        "id": "differentiators",
        "category": "Competitor Edge",
        "question": "What makes your business different from competitors, and why do clients choose you?"
    },
    {
        "id": "pre_purchase_advice",
        "category": "Pre-Purchase Advice",
        "question": "What critical advice do you always give clients before they make a purchasing decision?"
    }
]

def get_core_questions():
    return CORE_QUESTIONS

def generate_ai_followup(api_key: str, question: str, user_answer: str) -> str:
    """
    Analyzes the user's answer and generates a dynamic, highly targeted follow-up question using OpenAI.
    """
    client = OpenAI(api_key=api_key)
    
    system_prompt = """
    You are an expert business consultant conducting an interview to document a company's internal knowledge.
    The user has just answered a question. Your goal is to ask a single, natural, and highly targeted follow-up question to drill deeper into their expertise.
    
    - Do not repeat the original question.
    - Ask for specific examples, metrics, or details.
    - Keep it short, encouraging, and clear (1 sentence).
    - If the user's answer is extremely short or vague, ask them to expand. If it's detailed, pick a specific point they made and ask for details or an example.
    """
    
    user_prompt = f"Original Question: {question}\nUser's Answer: {user_answer}"
    
    response = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_prompt}
        ],
        temperature=0.7,
        max_tokens=100
    )
    
    return response.choices[0].message.content.strip()

def save_interview_session(client_slug: str, session_title: str, qa_pairs: list, author: str = "Client Partner"):
    """
    Compiles Q&A pairs into an OKF markdown document and saves it under the /voice/ folder.
    """
    metadata = {
        "type": "voice-interview",
        "title": f"Expert Interview: {session_title}",
        "author": author,
        "tags": ["expert-interview", "voice", "knowledge-capture", "differentiators"]
    }
    
    body = f"# Expert Interview: {session_title}\n\n"
    body += f"**Interviewer**: Local Waves AI Knowledge Engine\n"
    body += f"**Expert**: {author}\n\n"
    body += "---\n\n"
    
    for idx, qa in enumerate(qa_pairs, 1):
        q = qa.get("question", "")
        a = qa.get("answer", "")
        followups = qa.get("followups", [])
        
        body += f"### {idx}. {q}\n\n"
        body += f"> **Answer**: {a}\n\n"
        
        for f_q, f_a in followups:
            body += f"* **Follow-up**: {f_q}\n"
            body += f"  > **Answer**: {f_a}\n\n"
            
        body += "\n"
        
    filename = f"interview-{slugify(session_title)}"
    file_path = write_okf_file(client_slug, "voice", filename, metadata, body)
    return file_path
