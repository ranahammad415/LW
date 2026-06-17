import re
import yaml
import datetime
from pathlib import Path
from utils.config import CLIENTS_DIR

SUBDIRS = [
    "company",
    "services",
    "projects",
    "faq",
    "proof",
    "voice",
    "sales",
    "content/articles",
    "knowledge-gaps"
]

def slugify(text: str) -> str:
    """Sanitize and format string to make it safe for file paths."""
    text = text.lower().strip()
    text = re.sub(r"[^\w\s-]", "", text)
    text = re.sub(r"[\s_-]+", "-", text)
    return text.strip("-")

def get_client_dir(client_name: str) -> Path:
    """Returns the base path of a client's folders."""
    return CLIENTS_DIR / slugify(client_name)

def initialize_client_dirs(client_name: str) -> Path:
    """Creates the folders layout for a new client."""
    client_dir = get_client_dir(client_name)
    client_dir.mkdir(parents=True, exist_ok=True)
    for subdir in SUBDIRS:
        (client_dir / subdir).mkdir(parents=True, exist_ok=True)
    return client_dir

def list_clients():
    """Lists slugs of all clients created in the folder."""
    if not CLIENTS_DIR.exists():
        return []
    clients = []
    for p in CLIENTS_DIR.iterdir():
        # A valid client folder has a company profile or has standard directories
        if p.is_dir() and not p.name.startswith("."):
            # Try to read the profile name if available
            profile_path = p / "company" / "client-profile.md"
            title = p.name.replace("-", " ").title()
            if profile_path.exists():
                try:
                    meta, _ = read_okf_file_by_path(profile_path)
                    title = meta.get("company_name", title)
                except Exception:
                    pass
            clients.append({"slug": p.name, "name": title, "path": p})
    return clients

def write_okf_file(client_slug: str, relative_folder: str, filename: str, metadata: dict, body: str) -> Path:
    """Writes a markdown file with YAML frontmatter conforming to Open Knowledge Format."""
    client_dir = CLIENTS_DIR / client_slug
    target_dir = client_dir / relative_folder
    target_dir.mkdir(parents=True, exist_ok=True)
    
    # Ensure standard filename suffix
    if not filename.endswith(".md"):
        filename = f"{filename}.md"
        
    file_path = target_dir / filename
    
    # Standardize metadata timestamps
    now = datetime.datetime.now().isoformat()
    if "created_at" not in metadata:
        metadata["created_at"] = now
    metadata["updated_at"] = now
    
    # Write yaml frontmatter and body
    yaml_header = yaml.safe_dump(metadata, default_flow_style=False, sort_keys=False)
    
    content = f"---\n{yaml_header}---\n\n{body.strip()}\n"
    
    with open(file_path, "w", encoding="utf-8") as f:
        f.write(content)
        
    return file_path

def read_okf_file(client_slug: str, relative_folder: str, filename: str):
    """Reads and parses an OKF file."""
    client_dir = CLIENTS_DIR / client_slug
    file_path = client_dir / relative_folder / filename
    return read_okf_file_by_path(file_path)

def read_okf_file_by_path(file_path: Path):
    """Helper to read OKF from direct path."""
    if not file_path.exists():
        raise FileNotFoundError(f"File not found: {file_path}")
        
    with open(file_path, "r", encoding="utf-8") as f:
        content = f.read()
        
    # Match YAML block
    match = re.match(r"^---\s*\n(.*?)\n---\s*\n(.*)$", content, re.DOTALL)
    if match:
        yaml_text = match.group(1)
        body = match.group(2)
        try:
            metadata = yaml.safe_load(yaml_text) or {}
            return metadata, body
        except Exception as e:
            # Fallback if YAML is malformed
            return {"parsing_error": str(e), "type": "unknown"}, content
            
    return {"type": "raw_text"}, content

def list_client_files(client_slug: str):
    """Walks the client folder and returns summaries of all OKF markdown files."""
    client_dir = CLIENTS_DIR / client_slug
    if not client_dir.exists():
        return []
        
    assets = []
    # Walk all folders
    for ext_file in client_dir.glob("**/*.md"):
        if ext_file.is_file():
            rel_path = ext_file.relative_to(client_dir)
            # Find relative folder name
            folder_parts = rel_path.parent.as_posix()
            
            try:
                metadata, body = read_okf_file_by_path(ext_file)
                assets.append({
                    "filename": ext_file.name,
                    "folder": folder_parts,
                    "rel_path": rel_path.as_posix(),
                    "abs_path": str(ext_file.resolve()),
                    "metadata": metadata,
                    "title": metadata.get("title", ext_file.stem.replace("-", " ").title()),
                    "type": metadata.get("type", "unknown"),
                    "size_bytes": ext_file.stat().st_size,
                    "updated_at": metadata.get("updated_at", datetime.datetime.fromtimestamp(ext_file.stat().st_mtime).isoformat()),
                    "excerpt": body[:200] + "..." if len(body) > 200 else body
                })
            except Exception:
                # Log or handle unparseable files
                pass
                
    return assets

def search_knowledge_context(client_slug: str, query: str, limit=5):
    """
    Search keywords across client files to collect context for RAG generation.
    Returns a list of matching file summaries and full bodies.
    """
    assets = list_client_files(client_slug)
    query_terms = [term.lower() for term in re.findall(r"\w+", query) if len(term) > 2]
    
    if not query_terms:
        # If query is too short, return the first few assets
        results = []
        for asset in assets[:limit]:
            try:
                _, body = read_okf_file_by_path(Path(asset["abs_path"]))
                results.append({"asset": asset, "body": body, "score": 1})
            except Exception:
                pass
        return results
        
    scored_results = []
    for asset in assets:
        try:
            meta, body = read_okf_file_by_path(Path(asset["abs_path"]))
            text_to_search = (body + " " + asset["title"] + " " + yaml.dump(meta)).lower()
            
            # Count terms occurrences for scoring
            score = sum(text_to_search.count(term) for term in query_terms)
            if score > 0:
                scored_results.append({
                    "asset": asset,
                    "body": body,
                    "score": score
                })
        except Exception:
            pass
            
    # Sort by score descending
    scored_results.sort(key=lambda x: x["score"], reverse=True)
    return scored_results[:limit]
