import os
import streamlit as st
import datetime
from pathlib import Path

# Fix python import path
import sys
sys.path.append(os.path.dirname(os.path.abspath(__file__)))

from utils.config import get_openai_api_key, CLIENTS_DIR
from utils.storage import (
    list_clients, 
    initialize_client_dirs, 
    write_okf_file, 
    read_okf_file, 
    list_client_files, 
    search_knowledge_context,
    slugify
)
from utils.document_processor import extract_file_content, analyze_document_with_ai
from utils.expert_interview import get_core_questions, generate_ai_followup, save_interview_session
from utils.gap_analyzer import analyze_knowledge_gaps, save_gap_analysis
from utils.content_generator import (
    generate_content_opportunities, 
    save_opportunities, 
    generate_article, 
    save_article
)

# ── Page Layout ──
st.set_page_config(
    page_title="Local Waves AI Knowledge Engine",
    page_icon="🧠",
    layout="wide",
    initial_sidebar_state="expanded"
)

# ── Custom Design System Injector ──
st.markdown("""
<style>
@import url('https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700&display=swap');
html, body, [class*="css"], .stMarkdown {
    font-family: 'Plus Jakarta Sans', sans-serif;
}
.stApp {
    background: radial-gradient(circle at top right, #1e1b4b, #0f172a 70%);
}
div[data-testid="stSidebar"] {
    background-color: rgba(15, 23, 42, 0.8) !important;
    backdrop-filter: blur(16px);
    border-right: 1px solid rgba(255, 255, 255, 0.05);
}
.glass-card {
    background: rgba(30, 41, 59, 0.45);
    backdrop-filter: blur(8px);
    border: 1px solid rgba(255, 255, 255, 0.05);
    border-radius: 12px;
    padding: 1.5rem;
    margin-bottom: 1.25rem;
    color: #f8fafc;
    box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.3), 0 4px 6px -2px rgba(0, 0, 0, 0.15);
}
.card-title {
    font-weight: 600;
    font-size: 1.15rem;
    color: #818cf8;
    margin-bottom: 0.75rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
}
.score-badge {
    background: linear-gradient(135deg, #4f46e5, #7c3aed);
    color: white;
    padding: 0.25rem 0.75rem;
    border-radius: 9999px;
    font-weight: 700;
    font-size: 0.85rem;
    display: inline-block;
}
.gap-item {
    border-left: 4px solid #f59e0b;
    padding-left: 1rem;
    margin-bottom: 1rem;
}
.gap-item.high {
    border-left-color: #ef4444;
}
.gap-item.low {
    border-left-color: #10b981;
}
</style>
""", unsafe_allow_html=True)

# ── Sidebar Configurations ──
st.sidebar.image("https://localwaves.ai/wp-content/uploads/2024/02/cropped-favicon-32x32.png", width=36)
st.sidebar.title("Waves Knowledge Engine")
st.sidebar.markdown("*MVP Client Knowledge Engine*")
st.sidebar.markdown("---")

# API Key handling
api_key_input = st.sidebar.text_input(
    "OpenAI API Key Override",
    type="password",
    help="Leave empty to use configured system/backend environment keys."
)
api_key = get_openai_api_key(api_key_input if api_key_input else None)

# Client selection & syncing
clients = list_clients()
client_names = [c["name"] for c in clients]

# Auto-parse client name passed via React portal query param
query_client_name = st.query_params.get("client_name")
default_idx = 0

if query_client_name and query_client_name in client_names:
    default_idx = client_names.index(query_client_name)
elif query_client_name:
    # If client name was passed but is not in list, prompt to create
    st.sidebar.info(f"Adding context for: **{query_client_name}**")

selected_client_name = None
selected_client_slug = None

if client_names:
    selected_client_name = st.sidebar.selectbox("Active Client Profile", client_names, index=default_idx)
    selected_client_slug = clients[client_names.index(selected_client_name)]["slug"]
else:
    st.sidebar.warning("No clients registered. Create a profile under Client Setup tab.")

# Verify API configuration
if not api_key:
    st.warning("⚠️ OpenAI API Key is missing. Please provide it in the sidebar to enable AI analysis and generation features.")

# ── Core UI Dashboard Tabs ──
tabs = st.tabs([
    "🏢 Client Setup",
    "📤 Upload Asset",
    "💬 Guided Interview",
    "🔍 Gap Analysis",
    "💡 Content Ideas",
    "✍️ Article Writer",
    "🗄️ KB Browser"
])

# ── Tab 1: Client Setup ──
with tabs[0]:
    st.header("🏢 Client Setup & Profiles")
    st.markdown("Create a structured profile for a client. This creates their folder structure and generates a base context profile file.")
    
    with st.form("client_setup_form"):
        col1, col2 = st.columns(2)
        with col1:
            co_name = st.text_input("Company Name *", value=query_client_name if query_client_name else "")
            co_website = st.text_input("Website URL", value="https://")
            co_industry = st.text_input("Industry / Vertical", placeholder="e.g. Roof repair, HVAC, Legal consulting")
            co_service_area = st.text_input("Service Area / Location", placeholder="e.g. Austin, Texas metro area")
            co_services = st.text_area("Core Services (one per line)", placeholder="SEO Optimization\nPay-per-click management\nContent strategy")
        with col2:
            co_industries_served = st.text_input("Target Industries Served", placeholder="e.g. Residential homeowners, local businesses")
            co_competitors = st.text_area("Known Competitors", placeholder="Acme Competitor Ltd\nStandard Marketing Inc")
            co_differentiators = st.text_area("Key Differentiators / Differentiators", placeholder="What makes us unique? Why do clients select us?")
            co_brand_voice = st.text_input("Brand Voice Guidelines", placeholder="e.g. Warm, technical, direct, conversational")
            co_target_customers = st.text_input("Ideal Customer Target Profiles", placeholder="e.g. Mid-sized contractors looking for local leads")
            
        co_notes = st.text_area("Additional Profile Notes")
        
        submit_setup = st.form_submit_button("Save Profile & Initialize KB")
        
        if submit_setup:
            if not co_name.strip():
                st.error("Company Name is required.")
            else:
                slug = slugify(co_name)
                initialize_client_dirs(co_name)
                
                # Save metadata
                meta = {
                    "type": "company-profile",
                    "title": f"Company Profile: {co_name}",
                    "company_name": co_name,
                    "website": co_website,
                    "industry": co_industry,
                    "service_area": co_service_area,
                    "services": [s.strip() for s in co_services.split("\n") if s.strip()],
                    "industries_served": co_industries_served,
                    "competitors": [c.strip() for c in co_competitors.split("\n") if c.strip()],
                    "differentiators": co_differentiators,
                    "brand_voice": co_brand_voice,
                    "target_customers": co_target_customers
                }
                
                body = f"# Company Profile: {co_name}\n\n"
                body += f"This profile encapsulates the baseline contexts and differentiators for {co_name} used to ground the AI engine content operations.\n\n"
                body += f"### Baseline Details\n"
                body += f"- **Website**: [{co_website}]({co_website})\n"
                body += f"- **Industry Focus**: {co_industry}\n"
                body += f"- **Service Locations**: {co_service_area}\n"
                body += f"- **Brand Voice tone**: {co_brand_voice}\n\n"
                body += f"### Unique Differentiators\n{co_differentiators}\n\n"
                body += f"### Target Customer Contexts\n{co_target_customers}\n\n"
                body += f"### Additional Notes\n{co_notes}\n"
                
                write_okf_file(slug, "company", "client-profile.md", meta, body)
                st.success(f"🎉 Created client profile folder: `/clients/{slug}`. Base profile saved in OKF format.")
                st.rerun()

# ── Tab 2: Upload Asset ──
with tabs[1]:
    st.header("📤 Knowledge Asset Upload")
    st.markdown("Upload proposals, brochures, FAQs, or content sheets. The AI will extract text, generate structured summaries, classify standard sections, and store files.")
    
    if not selected_client_slug:
        st.warning("Please configure/select a client first.")
    else:
        uploaded_file = st.file_uploader(
            "Upload Document", 
            type=["pdf", "docx", "txt", "csv", "md", "markdown"],
            help="Supported: PDF, DOCX, TXT, CSV, MD"
        )
        
        if uploaded_file:
            st.info(f"Uploaded: {uploaded_file.name} ({uploaded_file.size} bytes)")
            
            # Temporary file write to parse text
            temp_path = Path("temp_upload")
            with open(temp_path, "wb") as f:
                f.write(uploaded_file.getvalue())
                
            try:
                ext = uploaded_file.name.split(".")[-1]
                extracted_text = extract_file_content(temp_path, ext)
                
                st.markdown("### Extracted Raw Content Preview")
                with st.expander("Show extracted raw text"):
                    st.text(extracted_text[:3000] + "..." if len(extracted_text) > 3000 else extracted_text)
                    
                if st.button("Run AI Extraction & Summary Analysis"):
                    if not api_key:
                        st.error("Provide an OpenAI API Key in the sidebar.")
                    else:
                        with st.spinner("Analyzing document content via GPT-4o-mini..."):
                            analysis = analyze_document_with_ai(api_key, extracted_text, uploaded_file.name)
                            
                            # Cache analysis in session state to review before write
                            st.session_state["cur_analysis"] = analysis
                            st.session_state["raw_content"] = extracted_text
                            st.session_state["upload_filename"] = uploaded_file.name
                            
            except Exception as e:
                st.error(f"Error parsing file: {e}")
            finally:
                if temp_path.exists():
                    os.remove(temp_path)
                    
        # Review analysis and save
        if "cur_analysis" in st.session_state:
            st.markdown("---")
            st.subheader("💡 Review AI Analysis Details")
            analysis = st.session_state["cur_analysis"]
            
            col1, col2 = st.columns(2)
            with col1:
                meta_title = st.text_input("Asset Title", value=analysis.get("title", ""))
                meta_type = st.text_input("OKF Type", value=analysis.get("type", ""))
                target_folder = st.selectbox(
                    "Target Folder Classification",
                    ["company", "services", "projects", "faq", "proof", "voice", "sales", "knowledge"],
                    index=["company", "services", "projects", "faq", "proof", "voice", "sales", "knowledge"].index(analysis.get("folder", "knowledge"))
                )
                meta_tags_str = st.text_input("Tags (comma separated)", value=", ".join(analysis.get("tags", [])))
            with col2:
                meta_summary = st.text_area("Structured Knowledge Summary", value=analysis.get("summary", ""), rows=5)
                
            formatted_body = st.text_area("Extracted Details & Content (Markdown Cleaned)", value=analysis.get("recommended_cleanup", ""), rows=10)
            
            if st.button("Confirm Details & Save to Knowledge Base"):
                tags = [t.strip() for t in meta_tags_str.split(",") if t.strip()]
                metadata = {
                    "type": meta_type,
                    "title": meta_title,
                    "tags": tags,
                    "source_file": st.session_state["upload_filename"]
                }
                
                body = f"# {meta_title}\n\n"
                body += f"### Structured Knowledge Summary\n{meta_summary}\n\n"
                body += f"---\n\n"
                body += f"### Cleaned Context Details\n{formatted_body}\n"
                
                file_slug = slugify(meta_title)
                save_path = write_okf_file(selected_client_slug, target_folder, file_slug, metadata, body)
                st.success(f"Saved to: `{save_path.relative_to(CLIENTS_DIR)}` in Open Knowledge Format.")
                
                # Clear session keys
                del st.session_state["cur_analysis"]
                del st.session_state["raw_content"]
                del st.session_state["upload_filename"]

# ── Tab 3: Guided Interview ──
with tabs[2]:
    st.header("💬 Guided Expert Interview")
    st.markdown("Capture raw, unwritten company expertise. Answer core questions and get contextual follow-ups generated dynamically by the AI interviewer.")
    
    if not selected_client_slug:
        st.warning("Please configure/select a client first.")
    else:
        # Load core question index
        questions = get_core_questions()
        
        # Select interview theme
        col_theme, col_auth = st.columns(2)
        with col_theme:
            interview_theme = st.selectbox("Interview Theme / Topic", ["Service Deep-dive", "Competitor Edge & Voice", "Sales Objections", "General Strategy"])
        with col_auth:
            expert_name = st.text_input("Expert / Respondent Name", value="Company Owner")
            
        st.markdown("---")
        
        if "interview_qa" not in st.session_state:
            st.session_state["interview_qa"] = [{"q": q["question"], "answer": "", "followups": [], "active_followup_q": ""} for q in questions]
            st.session_state["active_q_idx"] = 0
            
        active_idx = st.session_state["active_q_idx"]
        qa_data = st.session_state["interview_qa"]
        
        if active_idx < len(questions):
            current_item = qa_data[active_idx]
            st.subheader(f"Question {active_idx + 1} of {len(questions)}: {questions[active_idx]['category']}")
            st.info(f"**{current_item['q']}**")
            
            # Answer input
            ans = st.text_area("Your Response", key=f"ans_{active_idx}", value=current_item["answer"])
            
            col_actions = st.columns([1,1,4])
            with col_actions[0]:
                if st.button("Generate Follow-up Question"):
                    if not ans.strip():
                        st.error("Please answer the question first.")
                    elif not api_key:
                        st.error("Provide an OpenAI API key.")
                    else:
                        with st.spinner("Generating follow-up..."):
                            fol_q = generate_ai_followup(api_key, current_item["q"], ans)
                            current_item["active_followup_q"] = fol_q
                            current_item["answer"] = ans
                            st.rerun()
            with col_actions[1]:
                if st.button("Next Question"):
                    current_item["answer"] = ans
                    st.session_state["active_q_idx"] += 1
                    st.rerun()
                    
            # Render active follow-up if it exists
            if current_item["active_followup_q"]:
                st.markdown("---")
                st.markdown(f"🤖 **Contextual Follow-up Question:**")
                st.warning(current_item["active_followup_q"])
                
                # Check if there is already an answer to this follow-up
                f_ans = st.text_area("Follow-up Answer", key=f"f_ans_{active_idx}")
                
                if st.button("Save Follow-up Answer & Proceed"):
                    if f_ans.strip():
                        current_item["followups"].append((current_item["active_followup_q"], f_ans))
                    current_item["active_followup_q"] = "" # Clear active
                    current_item["answer"] = ans
                    st.session_state["active_q_idx"] += 1
                    st.success("Follow-up saved.")
                    st.rerun()
                    
        else:
            st.success("🎉 Guided Interview completed! Review all answers below.")
            
            # Review inputs
            qa_pairs_to_save = []
            for idx, qa in enumerate(qa_data):
                st.markdown(f"**Question {idx+1}:** {qa['q']}")
                st.markdown(f"*Answer:* {qa['answer']}")
                for f_q, f_a in qa["followups"]:
                    st.markdown(f"  *Follow-up Q:* {f_q}")
                    st.markdown(f"  *Follow-up Ans:* {f_a}")
                st.markdown("---")
                
                qa_pairs_to_save.append({
                    "question": qa["q"],
                    "answer": qa["answer"],
                    "followups": qa["followups"]
                })
                
            if st.button("Compile & Save Interview to Knowledge Base"):
                session_title = f"{interview_theme} Interview - {datetime.date.today().isoformat()}"
                save_path = save_interview_session(selected_client_slug, session_title, qa_pairs_to_save, expert_name)
                st.success(f"Interview compiled and written to: `{save_path.relative_to(CLIENTS_DIR)}`")
                # Clear session
                del st.session_state["interview_qa"]
                del st.session_state["active_q_idx"]
                
            if st.button("Start Fresh Interview"):
                del st.session_state["interview_qa"]
                del st.session_state["active_q_idx"]
                st.rerun()

# ── Tab 4: Gap Analysis ──
with tabs[3]:
    st.header("🔍 Knowledge Gap Auditing")
    st.markdown("Compare the files loaded in the client folder with their profile targets. Find content gaps and auto-generate interview guides.")
    
    if not selected_client_slug:
        st.warning("Please configure/select a client first.")
    else:
        if st.button("Audit Knowledge Base Gaps"):
            if not api_key:
                st.error("Provide OpenAI API Key in the sidebar.")
            else:
                with st.spinner("Analyzing active catalog structures..."):
                    gap_data = analyze_knowledge_gaps(api_key, selected_client_slug)
                    st.session_state["gap_data"] = gap_data
                    
        if "gap_data" in st.session_state:
            gap_data = st.session_state["gap_data"]
            
            col_score, col_findings = st.columns([1, 3])
            with col_score:
                st.markdown("<div class='glass-card' style='text-align: center;'>", unsafe_allow_html=True)
                st.subheader("KB Readiness")
                st.markdown(f"<div class='score-badge' style='font-size: 2.5rem; padding: 0.5rem 1.5rem;'>{gap_data.get('readiness_score', 0)}/100</div>", unsafe_allow_html=True)
                st.markdown("</div>", unsafe_allow_html=True)
            with col_findings:
                st.markdown("<div class='glass-card'>", unsafe_allow_html=True)
                st.markdown("<div class='card-title'>🔍 Audit Findings Summary</div>", unsafe_allow_html=True)
                st.write(gap_data.get("findings_summary", ""))
                st.markdown("</div>", unsafe_allow_html=True)
                
            st.subheader("🎯 Identified Content Gaps")
            for gap in gap_data.get("gaps", []):
                sev = gap.get("severity", "Medium").lower()
                st.markdown(f"""
                <div class='glass-card gap-item {sev}'>
                    <strong>[{gap.get('category', '').upper()}]</strong> - {gap.get('severity', 'Medium')} Severity
                    <p><strong>Description:</strong> {gap.get('description', '')}</p>
                    <p style='font-size: 0.9rem; color: #cbd5e1;'><strong>Impact:</strong> {gap.get('impact', '')}</p>
                </div>
                """, unsafe_allow_html=True)
                
            st.subheader("📋 Recommended Questions to Resolve Gaps")
            for q in gap_data.get("recommended_questions", []):
                st.markdown(f"- **Category: {q.get('category', '').title()}**\n  - **Question:** *{q.get('question', '')}*\n  - **Rationale:** {q.get('reason', '')}")
                
            col_save, col_fill = st.columns(2)
            with col_save:
                if st.button("Save Gap Report to KB"):
                    save_path = save_gap_analysis(selected_client_slug, gap_data)
                    st.success(f"Gap Report saved to: `{save_path.relative_to(CLIENTS_DIR)}`")
            with col_fill:
                if st.button("Load Recommended Questions into Interview Tab"):
                    custom_questions = []
                    for idx, rq in enumerate(gap_data.get("recommended_questions", [])):
                        custom_questions.append({
                            "id": f"custom_{idx}",
                            "category": rq.get("category", "Gap Solution").title(),
                            "question": rq.get("question")
                        })
                    st.session_state["interview_qa"] = [{"q": q["question"], "answer": "", "followups": [], "active_followup_q": ""} for q in custom_questions]
                    st.session_state["active_q_idx"] = 0
                    st.success("Custom questions loaded. Switch to 'Guided Interview' tab to begin.")

# ── Tab 5: Content Ideas ──
with tabs[4]:
    st.header("💡 Content Opportunity Planner")
    st.markdown("Input targets to discover customer questions, FAQ structures, and article ideas backed by existing company assets.")
    
    if not selected_client_slug:
        st.warning("Please configure/select a client first.")
    else:
        col_k, col_s = st.columns(2)
        with col_k:
            keyword = st.text_input("Target Focus Keyword", placeholder="e.g. emergency roofing repair")
        with col_s:
            service = st.text_input("Associated Core Service", placeholder="e.g. Roof Inspection")
        topic = st.text_input("Content Topic / Focus Area", placeholder="e.g. How to spot hail damage on shingle roofs")
        
        if st.button("Plan Content Opportunities"):
            if not api_key:
                st.error("Provide OpenAI API Key in the sidebar.")
            elif not topic.strip():
                st.error("Topic is required.")
            else:
                with st.spinner("Searching KB assets and drafting planner opportunities..."):
                    opps = generate_content_opportunities(api_key, selected_client_slug, keyword, service, topic)
                    st.session_state["opp_data"] = opps
                    st.session_state["opp_topic"] = topic
                    
        if "opp_data" in st.session_state:
            opps = st.session_state["opp_data"]
            opp_topic = st.session_state["opp_topic"]
            
            st.markdown("<div class='glass-card'>", unsafe_allow_html=True)
            st.markdown("<div class='card-title'>🎯 Estimated Search Intent</div>", unsafe_allow_html=True)
            st.write(opps.get("search_intent", ""))
            st.markdown("</div>", unsafe_allow_html=True)
            
            st.subheader("❓ Target Customer Questions")
            for idx, q in enumerate(opps.get("questions", []), 1):
                st.write(f"**{idx}. {q}**")
                
            st.subheader("💡 FAQ Blocks")
            for faq in opps.get("faq_opportunities", []):
                st.markdown(f"- **Question:** {faq.get('question')}\n  - **Details:** {faq.get('concept')}")
                
            st.markdown("<div class='glass-card'>", unsafe_allow_html=True)
            st.markdown("<div class='card-title'>🤖 AI Search visibility Insights</div>", unsafe_allow_html=True)
            st.write(opps.get("ai_visibility_insights", ""))
            st.markdown("</div>", unsafe_allow_html=True)
            
            st.subheader("✍️ Article Concepts")
            for c in opps.get("article_concepts", []):
                st.markdown(f"#### {c.get('title')}\n- **Hook:** *{c.get('hook')}*\n- **Brief:** {c.get('brief')}")
                
            if st.button("Save Opportunity Plan to KB"):
                save_path = save_opportunities(selected_client_slug, opp_topic, opps)
                st.success(f"Opportunities plan saved to: `{save_path.relative_to(CLIENTS_DIR)}`")

# ── Tab 6: Article Writer ──
with tabs[5]:
    st.header("✍️ Operationalized Article Generator")
    st.markdown("Select a question and reference assets to draft a comprehensive article grounded in actual company knowledge. Avoids generic AI filler.")
    
    if not selected_client_slug:
        st.warning("Please configure/select a client first.")
    else:
        # Load active assets lists to use as references
        assets = list_client_files(selected_client_slug)
        asset_options = {f"[{a['folder']}] {a['title']}": a["abs_path"] for a in assets}
        
        art_topic = st.text_input("Article Focus / Topic", placeholder="e.g. Spottng Shingle Hail Damage")
        art_question = st.text_input("Primary Question Addressed", placeholder="e.g. How do homeowners know if their roof has hail damage?")
        
        selected_references = st.multiselect(
            "Select Reference Knowledge Assets (Context grounds the writing)",
            list(asset_options.keys())
        )
        
        if st.button("Write Article Draft"):
            if not api_key:
                st.error("Provide OpenAI API Key in the sidebar.")
            elif not art_topic.strip():
                st.error("Article Focus Topic is required.")
            else:
                ref_paths = [asset_options[ref] for ref in selected_references]
                with st.spinner("Retrieving contexts and writing article draft via GPT-4o..."):
                    article = generate_article(api_key, selected_client_slug, art_topic, art_question, ref_paths)
                    st.session_state["generated_article"] = article
                    st.session_state["art_topic"] = art_topic
                    st.session_state["ref_titles"] = [ref for ref in selected_references]
                    
        if "generated_article" in st.session_state:
            article = st.session_state["generated_article"]
            art_topic = st.session_state["art_topic"]
            ref_titles = st.session_state["ref_titles"]
            
            st.subheader("📝 Review Generated Article details")
            
            art_title = st.text_input("Article Title", value=article.get("article_title", ""))
            art_outline = st.text_area("Outline", value=article.get("outline", ""), rows=5)
            art_draft = st.text_area("Full Draft Content (Markdown)", value=article.get("draft", ""), rows=15)
            
            st.subheader("💡 Suggested FAQs")
            for idx, faq in enumerate(article.get("faqs", []), 1):
                st.markdown(f"**FAQ {idx}:** {faq.get('q')}\n*Answer:* {faq.get('a')}")
                
            st.subheader("🔗 Internal Link Recommendations")
            for link in article.get("suggested_internal_links", []):
                st.markdown(f"- {link}")
                
            st.subheader("🛠️ Suggested JSON-LD Schema")
            st.code(article.get("schema_markup", ""), language="json")
            
            if st.button("Save Article Draft to KB"):
                # Clean references formatting for saving
                selected_meta = [{"title": t, "path": asset_options[t]} for t in ref_titles]
                
                # Recompile editor changes
                compiled_results = {
                    "article_title": art_title,
                    "outline": art_outline,
                    "draft": art_draft,
                    "faqs": article.get("faqs", []),
                    "suggested_internal_links": article.get("suggested_internal_links", []),
                    "schema_markup": article.get("schema_markup", "")
                }
                
                save_path = save_article(selected_client_slug, art_topic, compiled_results, selected_meta)
                st.success(f"Article saved to: `{save_path.relative_to(CLIENTS_DIR)}`")

# ── Tab 7: KB Browser ──
with tabs[6]:
    st.header("🗄️ Knowledge Base File Browser")
    st.markdown("Inspect, read, and edit the files stored in the client knowledge structure. Amplifies human review.")
    
    if not selected_client_slug:
        st.warning("Please configure/select a client first.")
    else:
        assets = list_client_files(selected_client_slug)
        
        if not assets:
            st.info("No assets created in this client's knowledge base yet.")
        else:
            col_list, col_view = st.columns([2, 3])
            
            with col_list:
                st.subheader("📂 Catalog Items")
                for a in assets:
                    # Render selection card
                    card_label = f"[{a['folder'].upper()}] {a['title']}"
                    if st.button(card_label, key=f"sel_{a['rel_path']}"):
                        st.session_state["view_file_rel"] = a["rel_path"]
                        
            with col_view:
                if "view_file_rel" in st.session_state:
                    view_rel = st.session_state["view_file_rel"]
                    
                    try:
                        metadata, body = read_okf_file(selected_client_slug, Path(view_rel).parent.as_posix(), Path(view_rel).name)
                        st.subheader(f"📄 Viewing: {Path(view_rel).name}")
                        
                        # Render metadata details
                        st.markdown("### Metadata (YAML Frontmatter)")
                        st.json(metadata)
                        
                        st.markdown("---")
                        st.markdown("### Preview Content")
                        st.markdown(body)
                        st.markdown("---")
                        
                        # Enable edits
                        st.subheader("✏️ Edit File Content")
                        new_body = st.text_area("Markdown Body", value=body, rows=15, key="edit_body")
                        
                        if st.button("Save Changes"):
                            # Save back profile modifications
                            write_okf_file(
                                selected_client_slug, 
                                Path(view_rel).parent.as_posix(), 
                                Path(view_rel).name, 
                                metadata, 
                                new_body
                            )
                            st.success("File updated successfully.")
                            st.rerun()
                            
                    except Exception as e:
                        st.error(f"Error loading file: {e}")
                else:
                    st.info("Select a document from the catalog list to view its contents.")
