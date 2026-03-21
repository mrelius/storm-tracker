"""Tests for the detection adapter layer.

Tests NWS alert → StormObject conversion, enrichment fallbacks,
partial data handling, and end-to-end pipeline integration.
"""
import json
import time
import asyncio
from unittest.mock import patch, AsyncMock, MagicMock
from services.detection.adapter import (
    build_storm_from_alert, fetch_severe_alerts,
    run_detection_cycle, enrich_storms_cc, get_pipeline,
    STORM_EVENTS, SEVERITY_DBZ_ESTIMATE,
)
from services.detection.models import StormObject, Trend, DetectionType


def run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


_DEFAULT_POLYGON = json.dumps({
    "type": "Polygon",
    "coordinates": [[
        [-84.5, 39.5], [-84.5, 39.6], [-84.4, 39.6], [-84.4, 39.5], [-84.5, 39.5]
    ]],
})


def _alert(event="Tornado Warning", severity="Extreme", polygon=_DEFAULT_POLYGON, alert_id=None):
    """Build a mock NWS alert dict. Pass polygon=None explicitly to test missing polygon."""
    return {
        "id": alert_id or "urn:oid:2.49.0.1.840.0.abc123.001.1",
        "event": event,
        "severity": severity,
        "polygon": polygon,
        "onset": "2026-03-20T20:00:00Z",
        "expires": "2026-03-20T21:00:00Z",
        "issued": "2026-03-20T20:00:00Z",
        "headline": "Tornado Warning for Franklin County",
        "priority_score": 100,
    }


class TestBuildStormFromAlert:
    def test_basic_conversion(self):
        alert = _alert()
        storm = build_storm_from_alert(alert, ref_lat=39.5, ref_lon=-84.5)
        assert storm is not None
        assert isinstance(storm, StormObject)
        assert storm.lat != 0
        assert storm.lon != 0
        assert storm.distance_mi >= 0
        assert storm.bearing_deg >= 0
        assert storm.direction != ""

    def test_id_prefix(self):
        storm = build_storm_from_alert(_alert(), 39.5, -84.5)
        assert storm.id.startswith("nws_")

    def test_reflectivity_from_extreme(self):
        storm = build_storm_from_alert(_alert(severity="Extreme"), 39.5, -84.5)
        assert storm.reflectivity_dbz == 60.0

    def test_reflectivity_from_severe(self):
        storm = build_storm_from_alert(_alert(severity="Severe"), 39.5, -84.5)
        assert storm.reflectivity_dbz == 50.0

    def test_reflectivity_unknown_severity(self):
        storm = build_storm_from_alert(_alert(severity="Unknown"), 39.5, -84.5)
        assert storm.reflectivity_dbz is None

    def test_no_polygon_returns_none(self):
        alert = _alert(polygon=None)
        assert build_storm_from_alert(alert, 39.5, -84.5) is None

    def test_invalid_polygon_returns_none(self):
        alert = _alert(polygon="{bad}")
        assert build_storm_from_alert(alert, 39.5, -84.5) is None

    def test_empty_polygon_returns_none(self):
        alert = _alert(polygon="")
        assert build_storm_from_alert(alert, 39.5, -84.5) is None

    def test_velocity_delta_none_by_default(self):
        storm = build_storm_from_alert(_alert(), 39.5, -84.5)
        assert storm.velocity_delta is None

    def test_speed_defaults_to_zero(self):
        storm = build_storm_from_alert(_alert(), 39.5, -84.5)
        assert storm.speed_mph == 0.0

    def test_trend_defaults_to_unknown(self):
        storm = build_storm_from_alert(_alert(), 39.5, -84.5)
        assert storm.trend == Trend.unknown

    def test_close_distance(self):
        """Alert polygon centered near reference point should be short distance."""
        storm = build_storm_from_alert(_alert(), ref_lat=39.55, ref_lon=-84.45)
        assert storm.distance_mi < 10

    def test_far_distance(self):
        """Alert polygon far from reference point."""
        storm = build_storm_from_alert(_alert(), ref_lat=41.0, ref_lon=-81.0)
        assert storm.distance_mi > 100


class TestEnrichCC:
    def test_enrichment_sets_cc(self):
        async def check():
            storm = StormObject(
                id="test", lat=39.55, lon=-84.45,
                distance_mi=5, bearing_deg=180,
            )
            mock_resp = MagicMock()
            mock_resp.status_code = 200
            mock_resp.json.return_value = {"cc_value": 0.92, "in_range": True}

            with patch("services.detection.adapter.httpx.AsyncClient") as mock_client:
                mock_instance = AsyncMock()
                mock_instance.get.return_value = mock_resp
                mock_instance.__aenter__ = AsyncMock(return_value=mock_instance)
                mock_instance.__aexit__ = AsyncMock(return_value=None)
                mock_client.return_value = mock_instance

                await enrich_storms_cc([storm])
                assert storm.cc_min == 0.92

        run(check())

    def test_enrichment_failure_leaves_none(self):
        async def check():
            storm = StormObject(
                id="test", lat=39.55, lon=-84.45,
                distance_mi=5, bearing_deg=180,
            )
            with patch("services.detection.adapter.httpx.AsyncClient") as mock_client:
                mock_instance = AsyncMock()
                mock_instance.get.side_effect = Exception("timeout")
                mock_instance.__aenter__ = AsyncMock(return_value=mock_instance)
                mock_instance.__aexit__ = AsyncMock(return_value=None)
                mock_client.return_value = mock_instance

                await enrich_storms_cc([storm])
                assert storm.cc_min is None

        run(check())

    def test_low_cc_sets_velocity_proxy(self):
        async def check():
            storm = StormObject(
                id="test", lat=39.55, lon=-84.45,
                distance_mi=5, bearing_deg=180,
                reflectivity_dbz=60.0,
            )
            mock_resp = MagicMock()
            mock_resp.status_code = 200
            mock_resp.json.return_value = {"cc_value": 0.70, "in_range": True}

            with patch("services.detection.adapter.httpx.AsyncClient") as mock_client:
                mock_instance = AsyncMock()
                mock_instance.get.return_value = mock_resp
                mock_instance.__aenter__ = AsyncMock(return_value=mock_instance)
                mock_instance.__aexit__ = AsyncMock(return_value=None)
                mock_client.return_value = mock_instance

                await enrich_storms_cc([storm])
                assert storm.cc_min == 0.70
                assert storm.velocity_delta == 40.0

        run(check())


class TestEndToEnd:
    """End-to-end: mock alert data → adapter → StormObjects → pipeline → detections."""

    def test_tornado_warning_produces_detections(self):
        async def check():
            pipeline = get_pipeline()
            pipeline.reset()

            alert = _alert(event="Tornado Warning", severity="Extreme")

            with patch("services.detection.adapter.fetch_severe_alerts",
                       new_callable=AsyncMock, return_value=[alert]):
                with patch("services.detection.adapter.enrich_storms_cc",
                           new_callable=AsyncMock):
                    result = await run_detection_cycle(ref_lat=39.55, ref_lon=-84.45)

            assert result.storms_processed == 1
            types = {e.type for e in result.events}
            assert DetectionType.strong_storm in types

        run(check())

    def test_no_alerts_produces_empty(self):
        async def check():
            with patch("services.detection.adapter.fetch_severe_alerts",
                       new_callable=AsyncMock, return_value=[]):
                result = await run_detection_cycle()

            assert result.storms_processed == 0
            assert result.events == []

        run(check())

    def test_alert_without_polygon_skipped(self):
        async def check():
            pipeline = get_pipeline()
            pipeline.reset()

            alert = _alert(polygon=None)

            with patch("services.detection.adapter.fetch_severe_alerts",
                       new_callable=AsyncMock, return_value=[alert]):
                with patch("services.detection.adapter.enrich_storms_cc",
                           new_callable=AsyncMock):
                    result = await run_detection_cycle()

            assert result.storms_processed == 0

        run(check())

    def test_output_contract(self):
        async def check():
            pipeline = get_pipeline()
            pipeline.reset()

            alert = _alert(severity="Extreme")

            with patch("services.detection.adapter.fetch_severe_alerts",
                       new_callable=AsyncMock, return_value=[alert]):
                with patch("services.detection.adapter.enrich_storms_cc",
                           new_callable=AsyncMock):
                    result = await run_detection_cycle(ref_lat=39.55, ref_lon=-84.45)

            for e in result.events:
                assert e.type is not None
                assert isinstance(e.severity, int)
                assert 0 <= e.confidence <= 1.0
                assert e.storm_id.startswith("nws_")
                assert e.timestamp > 0
                assert isinstance(e.detail, str)

        run(check())
