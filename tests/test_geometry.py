"""Tests for geometry helpers."""
from services.detection.geometry import (
    extract_centroid, haversine_mi, compute_bearing, bearing_to_direction,
)
import json


class TestCentroid:
    def test_simple_polygon(self):
        poly = json.dumps({
            "type": "Polygon",
            "coordinates": [[[-84, 39], [-84, 40], [-83, 40], [-83, 39], [-84, 39]]],
        })
        result = extract_centroid(poly)
        assert result is not None
        lat, lon = result
        assert 39.0 < lat < 40.0
        assert -84.0 < lon < -83.0

    def test_multipolygon(self):
        poly = json.dumps({
            "type": "MultiPolygon",
            "coordinates": [
                [[[-84, 39], [-84, 40], [-83, 40], [-83, 39], [-84, 39]]],
                [[[-82, 39], [-82, 40], [-81, 40], [-81, 39], [-82, 39]]],
            ],
        })
        result = extract_centroid(poly)
        assert result is not None

    def test_none_returns_none(self):
        assert extract_centroid(None) is None

    def test_empty_string_returns_none(self):
        assert extract_centroid("") is None

    def test_invalid_json_returns_none(self):
        assert extract_centroid("{bad json") is None

    def test_no_coordinates_returns_none(self):
        assert extract_centroid(json.dumps({"type": "Polygon"})) is None

    def test_empty_coordinates_returns_none(self):
        assert extract_centroid(json.dumps({"type": "Polygon", "coordinates": []})) is None

    def test_point_type_returns_none(self):
        assert extract_centroid(json.dumps({"type": "Point", "coordinates": [-84, 39]})) is None

    def test_accepts_dict_input(self):
        geom = {"type": "Polygon", "coordinates": [[[-84, 39], [-83, 39], [-83, 40], [-84, 39]]]}
        result = extract_centroid(json.dumps(geom))
        assert result is not None


class TestHaversine:
    def test_same_point_zero(self):
        assert haversine_mi(39.5, -84.5, 39.5, -84.5) == 0.0

    def test_known_distance(self):
        # Columbus OH to Cincinnati OH: ~100 miles
        d = haversine_mi(39.96, -82.99, 39.10, -84.51)
        assert 90 < d < 110

    def test_short_distance(self):
        d = haversine_mi(39.5, -84.5, 39.51, -84.51)
        assert d < 1.0


class TestBearing:
    def test_north(self):
        b = compute_bearing(39.0, -84.0, 40.0, -84.0)
        assert 355 < b or b < 5  # ~0 degrees

    def test_east(self):
        b = compute_bearing(39.0, -84.0, 39.0, -83.0)
        assert 85 < b < 95

    def test_south(self):
        b = compute_bearing(40.0, -84.0, 39.0, -84.0)
        assert 175 < b < 185

    def test_west(self):
        b = compute_bearing(39.0, -83.0, 39.0, -84.0)
        assert 265 < b < 275


class TestBearingToDirection:
    def test_north(self):
        assert bearing_to_direction(0) == "N"
        assert bearing_to_direction(360) == "N"

    def test_east(self):
        assert bearing_to_direction(90) == "E"

    def test_south(self):
        assert bearing_to_direction(180) == "S"

    def test_southwest(self):
        assert bearing_to_direction(225) == "SW"

    def test_northwest(self):
        assert bearing_to_direction(315) == "NW"

    def test_northeast_range(self):
        assert bearing_to_direction(45) == "NE"
        assert bearing_to_direction(30) == "NE"
        assert bearing_to_direction(60) == "NE"
