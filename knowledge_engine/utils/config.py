import os
from pathlib import Path
from dotenv import load_dotenv

# Get paths
UTILS_DIR = Path(__file__).resolve().parent
APP_DIR = UTILS_DIR.parent
ROOT_DIR = APP_DIR.parent

# 1. Load local .env if it exists
local_env = APP_DIR / ".env"
if local_env.exists():
    load_dotenv(local_env)

# 2. Try loading backend .env if variables are still empty
backend_env = ROOT_DIR / "backend" / ".env"
if backend_env.exists():
    load_dotenv(backend_env)

# Resolve Clients Directory
# Allows overriding via env, defaults to `knowledge_engine/clients`
CLIENTS_DIR_PATH = os.getenv("CLIENTS_DIR")
if CLIENTS_DIR_PATH:
    CLIENTS_DIR = Path(CLIENTS_DIR_PATH).resolve()
else:
    CLIENTS_DIR = APP_DIR / "clients"

# Ensure clients base directory exists
CLIENTS_DIR.mkdir(parents=True, exist_ok=True)

def get_openai_api_key(session_key=None):
    """
    Returns OpenAI API Key in order of preference:
    1. Session state input (passed as session_key)
    2. Environment variable / .env file
    """
    if session_key:
        return session_key
    return os.getenv("OPENAI_API_KEY")

def get_anthropic_api_key():
    """
    Returns Anthropic API Key from environment if available as fallback.
    """
    return os.getenv("ANTHROPIC_API_KEY")
