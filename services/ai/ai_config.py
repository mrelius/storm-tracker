"""
Storm Tracker — AI Configuration

All AI inference is remote via Ollama on Gaming PC (10.206.4.21).
No models run inside LXC 119.
"""

from dataclasses import dataclass, field


@dataclass
class AIConfig:
    # Remote Ollama endpoint
    ollama_url: str = "http://10.206.4.21:11434"

    # Split model strategy
    fast_model: str = "mistral:latest"       # classification, prioritization (low latency)
    heavy_model: str = "llama3.1:latest"     # summaries, narration (higher quality)

    # Timeouts
    inference_timeout: float = 15.0          # max seconds per inference call
    health_check_timeout: float = 5.0        # health probe timeout
    health_check_interval: float = 60.0      # seconds between health probes

    # Rate limits
    min_interval_summary: float = 30.0       # min seconds between summary jobs
    min_interval_narration: float = 20.0     # min seconds between narration jobs
    min_interval_priority: float = 15.0      # min seconds between priority jobs

    # Queue
    max_queue_depth: int = 10                # drop oldest if exceeded
    worker_count: int = 1                    # single worker (remote GPU is shared)

    # Cache
    result_cache_ttl: float = 300.0          # 5 min cache for AI results
    max_cached_results: int = 50

    # Retry
    max_retries: int = 1
    retry_delay: float = 2.0

    # Feature toggle
    enabled: bool = True

    # Context limits
    max_alerts_in_prompt: int = 8            # don't overwhelm the model
    max_prompt_tokens: int = 2000            # rough limit on prompt size


# Singleton
_config = AIConfig()


def get_ai_config() -> AIConfig:
    return _config
