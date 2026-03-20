import os
import sys
import pytest
import tempfile

# Add project root to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

# Set test env vars before importing anything
os.environ["SQLITE_DB_PATH"] = ":memory:"
os.environ["REDIS_URL"] = "redis://localhost:6379/15"  # test DB
os.environ["NWS_POLL_INTERVAL"] = "9999"  # don't auto-poll in tests


@pytest.fixture
def tmp_db_path():
    """Provide a temporary database path for tests."""
    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
        path = f.name
    yield path
    try:
        os.unlink(path)
    except OSError:
        pass
