from app import config


def test_llm_audit_disabled_by_default():
    assert config.LLM_AUDIT_ENABLED is False
