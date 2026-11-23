"""Clearly synthetic key-shaped values for offline auth/redaction tests only."""

def synthetic_key(suffix: str) -> str:
    """Keep the exercised key shape without storing a credential-like literal."""
    return "sk-" + suffix

def synthetic_env_prefix(name: str) -> str:
    """Build an offline dotenv fixture field independently of its test value."""
    return name + "="
