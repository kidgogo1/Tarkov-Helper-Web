#!/usr/bin/env python3
"""Deterministically export TarkovHelper's packaged data for the web app."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import shutil
import sqlite3
import sys
import unicodedata
from collections import defaultdict
from contextlib import closing
from pathlib import Path
from typing import Any


ORIGINAL_COMMIT = "ef71936bd428f2abb0c1320010a8e7c29c36482f"
MODIFIED_COMMIT = "77ee7343ed0f98dc6aa8610519062c61120535f1"
# The modified commit timestamp is used instead of wall-clock time so reruns are byte-identical.
EXPORTED_AT = "2026-05-06T18:03:23Z"

EXPECTED_TABLE_COUNTS = {
    "ApiMarkers": 3937,
    "AppSettings": 2,
    "HideoutItemRequirements": 317,
    "HideoutLevels": 68,
    "HideoutSkillRequirements": 9,
    "HideoutStationRequirements": 127,
    "HideoutStations": 26,
    "HideoutTraderRequirements": 26,
    "Items": 4014,
    "MapFloorLocations": 32,
    "MapMarkers": 454,
    "OptionalQuests": 20,
    "QuestObjectives": 1514,
    "QuestRequiredItems": 638,
    "QuestRequirements": 794,
    "Quests": 488,
    "Traders": 15,
    "_schema_meta": 17,
}
EXPECTED_REFERENCED_ITEM_ICONS = 475
EXPECTED_MAP_ICON_FILES = 25


def parse_args() -> argparse.Namespace:
    project_root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source_path", nargs="?", type=Path)
    parser.add_argument("output_path", nargs="?", type=Path)
    parser.add_argument("--source", dest="source_option", type=Path)
    parser.add_argument("--output", dest="output_option", type=Path)
    args = parser.parse_args()
    if args.source_path and args.source_option:
        parser.error("pass source either positionally or with --source, not both")
    if args.output_path and args.output_option:
        parser.error("pass output either positionally or with --output, not both")
    args.source = (args.source_option or args.source_path or
                   project_root.parents[1] / "work" / "reference-modified").resolve()
    args.output = (args.output_option or args.output_path or project_root / "public").resolve()
    return args


def resolve_assets(source: Path) -> Path:
    candidates = (source / "TarkovHelper" / "Assets", source)
    for candidate in candidates:
        if (candidate / "tarkov_data.db").is_file():
            return candidate.resolve()
    tried = ", ".join(str(path) for path in candidates)
    raise FileNotFoundError(f"packaged tarkov_data.db not found; tried: {tried}")


def open_read_only(database: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(f"{database.resolve().as_uri()}?mode=ro&immutable=1", uri=True)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only = ON")
    check = connection.execute("PRAGMA quick_check").fetchone()[0]
    if check != "ok":
        connection.close()
        raise RuntimeError(f"SQLite quick_check failed: {check}")
    return connection


def assert_source_counts(connection: sqlite3.Connection, map_count: int) -> dict[str, int]:
    actual: dict[str, int] = {}
    for table, expected in EXPECTED_TABLE_COUNTS.items():
        escaped = table.replace('"', '""')
        count = connection.execute(f'SELECT COUNT(*) FROM "{escaped}"').fetchone()[0]
        actual[table] = count
        if count != expected:
            raise RuntimeError(
                f"packaged {table} count changed: expected {expected}, discovered {count}"
            )
    if map_count != 12:
        raise RuntimeError(f"packaged map config count changed: expected 12, discovered {map_count}")
    return actual


def rows(connection: sqlite3.Connection, sql: str) -> list[dict[str, Any]]:
    return [dict(row) for row in connection.execute(sql)]


def without_none(value: dict[str, Any]) -> dict[str, Any]:
    return {key: item for key, item in value.items() if item is not None}


def normalized_name(value: str) -> str:
    return (value.lower().replace(" ", "-").replace("'", "").replace(".", "")
            .replace(",", "").replace("?", "").replace("!", "")
            .replace(":", "").replace('"', ""))


def item_lookup_key(value: str) -> str:
    normalized = unicodedata.normalize("NFKC", value).casefold()
    return "".join(character for character in normalized if character.isalnum())


def json_value(value: str | None) -> Any:
    if not value:
        return None
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return value


def world_points(value: str | None, field: str) -> list[dict[str, Any]]:
    if not value:
        return []
    try:
        document = json.loads(value)
    except json.JSONDecodeError as error:
        raise ValueError(f"invalid {field} JSON: {error}") from error
    if not isinstance(document, list):
        raise ValueError(f"{field} must be a JSON array")
    result: list[dict[str, Any]] = []
    for point in document:
        if not isinstance(point, dict):
            raise ValueError(f"{field} contains a non-object point")
        try:
            mapped = {
                "x": point.get("X", point.get("x")),
                "y": point.get("Y", point.get("y")),
                "z": point.get("Z", point.get("z")),
                "floorId": point.get("FloorId", point.get("floorId")),
            }
            if any(mapped[axis] is None for axis in ("x", "y", "z")):
                raise KeyError("x/y/z")
        except KeyError as error:
            raise ValueError(f"{field} point is missing coordinates: {point}") from error
        result.append(without_none(mapped))
    return result


def split_values(value: str | None, separator: str) -> list[str]:
    if not value or value.casefold() == "any":
        return []
    return [part.strip() for part in value.split(separator) if part.strip()]


def export_items(
    connection: sqlite3.Connection,
) -> tuple[list[dict[str, Any]], dict[str, dict[str, Any]], dict[str, str]]:
    exported: list[dict[str, Any]] = []
    by_id: dict[str, dict[str, Any]] = {}
    by_name: dict[str, str] = {}
    source_rows = rows(connection, "SELECT * FROM Items ORDER BY Name COLLATE NOCASE, Id")
    for row in source_rows:
        item = without_none({
            "id": row["Id"],
            "bsgId": row["BsgId"],
            "name": row["Name"],
            "nameEn": row["NameEN"] or row["Name"],
            "nameKo": row["NameKO"],
            "nameJa": row["NameJA"],
            "shortNameEn": row["ShortNameEN"],
            "shortNameKo": row["ShortNameKO"],
            "shortNameJa": row["ShortNameJA"],
            "wikiPageLink": row["WikiPageLink"],
            "category": row["Category"],
            "categories": split_values(row["Categories"], "|"),
            "isDogtagItem": bool(row["IsDogtagItem"]),
            "dogtagFaction": row["DogtagFaction"],
        })
        exported.append(item)
        by_id[item["id"]] = item
        for name in (row["Name"], row["NameEN"]):
            if not name:
                continue
            key = item_lookup_key(name)
            existing = by_name.get(key)
            if existing and existing != item["id"]:
                raise ValueError(f"ambiguous normalized item name {name!r}: {existing}, {item['id']}")
            by_name[key] = item["id"]
    return exported, by_id, by_name


def export_quests(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    requirements: dict[str, list[dict[str, Any]]] = defaultdict(list)
    follow_ups: dict[str, set[str]] = defaultdict(set)
    for row in rows(connection, "SELECT * FROM QuestRequirements ORDER BY GroupId, Id"):
        requirements[row["QuestId"]].append({
            "questId": row["RequiredQuestId"],
            "requirementType": row["RequirementType"],
            "groupId": row["GroupId"],
        })
        follow_ups[row["RequiredQuestId"]].add(row["QuestId"])

    alternatives: dict[str, set[str]] = defaultdict(set)
    for row in rows(connection, "SELECT * FROM OptionalQuests ORDER BY QuestId, AlternativeQuestId"):
        alternatives[row["QuestId"]].add(row["AlternativeQuestId"])

    objectives: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows(connection, "SELECT * FROM QuestObjectives ORDER BY QuestId, SortOrder, Id"):
        objective = without_none({
            "id": row["Id"],
            "sortOrder": row["SortOrder"],
            "objectiveType": row["ObjectiveType"],
            "description": row["Description"],
            "targetType": row["TargetType"],
            "targetCount": row["TargetCount"],
            "itemId": row["ItemId"],
            "requiresFir": bool(row["RequiresFIR"]),
            "mapName": row["MapName"],
            "locationName": row["LocationName"],
            "locationPoints": world_points(row["LocationPoints"], "QuestObjectives.LocationPoints"),
            "optionalPoints": world_points(row["OptionalPoints"], "QuestObjectives.OptionalPoints"),
            "conditions": json_value(row["Conditions"]),
            "dogtagMinLevel": row["DogtagMinLevel"],
            "dogtagFaction": row["DogtagFaction"],
        })
        objectives[row["QuestId"]].append(objective)

    required_items: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows(connection, "SELECT * FROM QuestRequiredItems ORDER BY QuestId, SortOrder, Id"):
        item = without_none({
            "id": row["Id"],
            "itemId": row["ItemId"] or "",
            "itemName": row["ItemName"],
            "count": row["Count"],
            "requiresFir": bool(row["RequiresFIR"]),
            "requirementType": row["RequirementType"],
            "sortOrder": row["SortOrder"],
            "dogtagMinLevel": row["DogtagMinLevel"],
            "dogtagFaction": row["DogtagFaction"],
        })
        required_items[row["QuestId"]].append(item)

    result: list[dict[str, Any]] = []
    for row in rows(connection, "SELECT * FROM Quests ORDER BY Name COLLATE NOCASE, Id"):
        quest_id = row["Id"]
        result.append(without_none({
            "id": quest_id,
            "bsgId": row["BsgId"],
            "normalizedName": normalized_name(row["Name"]),
            "name": row["Name"],
            "nameEn": row["NameEN"] or row["Name"],
            "nameKo": row["NameKO"],
            "nameJa": row["NameJA"],
            "wikiPageLink": row["WikiPageLink"],
            "trader": row["Trader"] or "",
            "locations": split_values(row["Location"], ","),
            "minLevel": row["MinLevel"],
            "minScavKarma": row["MinScavKarma"],
            "kappaRequired": bool(row["KappaRequired"]),
            "faction": row["Faction"],
            "requiredEdition": row["RequiredEdition"],
            "excludedEdition": row["ExcludedEdition"],
            "requiredDecodeCount": row["RequiredDecodeCount"],
            "requiredPrestigeLevel": row["RequiredPrestigeLevel"],
            "requirements": requirements[quest_id],
            "alternativeQuestIds": sorted(alternatives[quest_id]),
            "followUpQuestIds": sorted(follow_ups[quest_id]),
            "objectives": objectives[quest_id],
            "requiredItems": required_items[quest_id],
        }))
    return result


def resolve_hideout_item_id(
    row: dict[str, Any], item_by_id: dict[str, dict[str, Any]], item_by_name: dict[str, str]
) -> str:
    if row["ItemId"] in item_by_id:
        return row["ItemId"]
    resolved = item_by_name.get(item_lookup_key(row["ItemName"]))
    if not resolved:
        raise ValueError(
            f"cannot map hideout item {row['ItemId']} ({row['ItemName']}) to Items.Id"
        )
    return resolved


def export_hideout(
    connection: sqlite3.Connection,
    item_by_id: dict[str, dict[str, Any]],
    item_by_name: dict[str, str],
) -> tuple[list[dict[str, Any]], set[str]]:
    level_lookup: dict[tuple[str, int], dict[str, Any]] = {}
    for row in rows(connection, "SELECT * FROM HideoutLevels ORDER BY StationId, Level, Id"):
        level_lookup[(row["StationId"], row["Level"])] = {
            "id": row["Id"],
            "level": row["Level"],
            "constructionTime": row["ConstructionTime"],
            "items": [],
            "stations": [],
            "traders": [],
            "skills": [],
        }

    referenced_item_ids: set[str] = set()
    for row in rows(connection, "SELECT * FROM HideoutItemRequirements ORDER BY StationId, Level, SortOrder, Id"):
        item_id = resolve_hideout_item_id(row, item_by_id, item_by_name)
        referenced_item_ids.add(item_id)
        level_lookup[(row["StationId"], row["Level"])]["items"].append(without_none({
            "id": row["Id"],
            "itemId": item_id,
            "itemName": row["ItemName"],
            "itemNameKo": row["ItemNameKO"],
            "itemNameJa": row["ItemNameJA"],
            "count": row["Count"],
            "foundInRaid": bool(row["FoundInRaid"]),
            "sortOrder": row["SortOrder"],
        }))

    for row in rows(connection, "SELECT * FROM HideoutStationRequirements ORDER BY StationId, Level, SortOrder, Id"):
        level_lookup[(row["StationId"], row["Level"])]["stations"].append(without_none({
            "id": row["Id"],
            "stationId": row["RequiredStationId"],
            "stationName": row["RequiredStationName"],
            "stationNameKo": row["RequiredStationNameKO"],
            "stationNameJa": row["RequiredStationNameJA"],
            "requiredLevel": row["RequiredLevel"],
            "sortOrder": row["SortOrder"],
        }))

    for table, target, name_column in (
        ("HideoutTraderRequirements", "traders", "TraderName"),
        ("HideoutSkillRequirements", "skills", "SkillName"),
    ):
        for row in rows(connection, f'SELECT * FROM "{table}" ORDER BY StationId, Level, SortOrder, Id'):
            level_lookup[(row["StationId"], row["Level"])][target].append(without_none({
                "id": row["Id"],
                "name": row[name_column],
                "nameKo": row[f"{name_column}KO"],
                "nameJa": row[f"{name_column}JA"],
                "requiredLevel": row["RequiredLevel"],
                "sortOrder": row["SortOrder"],
            }))

    levels_by_station: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for (station_id, _), level in level_lookup.items():
        levels_by_station[station_id].append(level)
    for station_levels in levels_by_station.values():
        station_levels.sort(key=lambda level: (level["level"], level["id"]))

    stations: list[dict[str, Any]] = []
    for row in rows(connection, "SELECT * FROM HideoutStations ORDER BY Name COLLATE NOCASE, Id"):
        stations.append(without_none({
            "id": row["Id"],
            "name": row["Name"],
            "nameKo": row["NameKO"],
            "nameJa": row["NameJA"],
            "normalizedName": row["NormalizedName"] or normalized_name(row["Name"]),
            "maxLevel": row["MaxLevel"],
            "levels": levels_by_station[row["Id"]],
        }))
    return stations, referenced_item_ids


def export_traders(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    return [without_none({
        "id": row["Id"],
        "name": row["Name"],
        "nameKo": row["NameKO"],
        "nameJa": row["NameJA"],
        "normalizedName": row["NormalizedName"] or normalized_name(row["Name"]),
    }) for row in rows(connection, "SELECT * FROM Traders ORDER BY Name COLLATE NOCASE, Id")]


def export_map_configs(source: list[dict[str, Any]]) -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for row in source:
        required = ("key", "displayName", "svgFileName", "imageWidth", "imageHeight", "aliases")
        missing = [field for field in required if field not in row]
        if missing:
            raise ValueError(f"map config is missing {missing}: {row}")
        config = {
            "key": row["key"],
            "displayName": row["displayName"],
            "svgFileName": row["svgFileName"],
            "imageWidth": row["imageWidth"],
            "imageHeight": row["imageHeight"],
            "aliases": row["aliases"],
            "playerMarkerTransform": row.get("playerMarkerTransform"),
            "calibratedTransform": row.get("calibratedTransform"),
            "transform": row.get("transform"),
            "svgBounds": row.get("svgBounds"),
            "mapRotation": row.get("mapRotation"),
            "markerScale": row.get("markerScale"),
            "floors": [{
                "layerId": floor["layerId"],
                "displayName": floor["displayName"],
                "order": floor["order"],
                "isDefault": bool(floor["isDefault"]),
            } for floor in row.get("floors", [])],
        }
        result.append(without_none(config))
    return result


def export_map_markers(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    result = []
    for row in rows(connection, "SELECT * FROM MapMarkers ORDER BY MapKey, MarkerType, Name, Id"):
        result.append(without_none({
            "id": row["Id"],
            "name": row["Name"],
            "nameKo": row["NameKo"],
            "markerType": row["MarkerType"],
            "mapKey": row["MapKey"],
            "x": row["X"],
            "y": row["Y"],
            "z": row["Z"],
            "floorId": row["FloorId"],
        }))
    return result


def export_floor_locations(connection: sqlite3.Connection) -> list[dict[str, Any]]:
    result = []
    for row in rows(connection, "SELECT * FROM MapFloorLocations ORDER BY MapKey, Priority DESC, FloorId, Id"):
        result.append(without_none({
            "id": row["Id"],
            "mapKey": row["MapKey"],
            "floorId": row["FloorId"],
            "regionName": row["RegionName"],
            "minY": row["MinY"],
            "maxY": row["MaxY"],
            "minX": row["MinX"],
            "maxX": row["MaxX"],
            "minZ": row["MinZ"],
            "maxZ": row["MaxZ"],
            "priority": row["Priority"],
        }))
    return result


def validate_export(data: dict[str, Any], counts: dict[str, int]) -> None:
    if len(data["quests"]) != counts["Quests"]:
        raise RuntimeError("quest export count does not match source")
    if len(data["items"]) != counts["Items"]:
        raise RuntimeError("item export count does not match source")
    if len(data["hideoutStations"]) != counts["HideoutStations"]:
        raise RuntimeError("hideout station export count does not match source")
    if len(data["traders"]) != counts["Traders"]:
        raise RuntimeError("trader export count does not match source")
    if len(data["mapMarkers"]) != counts["MapMarkers"]:
        raise RuntimeError("map marker export count does not match source")
    if len(data["mapFloorLocations"]) != counts["MapFloorLocations"]:
        raise RuntimeError("floor location export count does not match source")

    quest_ids = {quest["id"] for quest in data["quests"]}
    item_ids = {item["id"] for item in data["items"]}
    station_ids = {station["id"] for station in data["hideoutStations"]}
    map_keys = {config["key"] for config in data["mapConfigs"]}
    if len(quest_ids) != len(data["quests"]):
        raise RuntimeError("duplicate quest IDs in export")
    if len(item_ids) != len(data["items"]):
        raise RuntimeError("duplicate item IDs in export")
    if len(station_ids) != len(data["hideoutStations"]):
        raise RuntimeError("duplicate hideout station IDs in export")
    if len(map_keys) != len(data["mapConfigs"]):
        raise RuntimeError("duplicate map keys in export")

    nested_counts = {
        "QuestRequirements": sum(len(quest["requirements"]) for quest in data["quests"]),
        "OptionalQuests": sum(len(quest["alternativeQuestIds"]) for quest in data["quests"]),
        "QuestObjectives": sum(len(quest["objectives"]) for quest in data["quests"]),
        "QuestRequiredItems": sum(len(quest["requiredItems"]) for quest in data["quests"]),
        "HideoutLevels": sum(len(station["levels"]) for station in data["hideoutStations"]),
        "HideoutItemRequirements": sum(
            len(level["items"])
            for station in data["hideoutStations"] for level in station["levels"]
        ),
        "HideoutStationRequirements": sum(
            len(level["stations"])
            for station in data["hideoutStations"] for level in station["levels"]
        ),
        "HideoutTraderRequirements": sum(
            len(level["traders"])
            for station in data["hideoutStations"] for level in station["levels"]
        ),
        "HideoutSkillRequirements": sum(
            len(level["skills"])
            for station in data["hideoutStations"] for level in station["levels"]
        ),
    }
    for table, nested_count in nested_counts.items():
        if nested_count != counts[table]:
            raise RuntimeError(
                f"nested {table} count mismatch: expected {counts[table]}, exported {nested_count}"
            )

    for quest in data["quests"]:
        related = (
            [requirement["questId"] for requirement in quest["requirements"]]
            + quest["alternativeQuestIds"] + quest["followUpQuestIds"]
        )
        missing = [quest_id for quest_id in related if quest_id not in quest_ids]
        if missing:
            raise RuntimeError(f"quest {quest['id']} references missing quests: {missing}")
        missing_items = [
            item["itemId"] for item in quest["requiredItems"]
            if item["itemId"] and item["itemId"] not in item_ids
        ]
        if missing_items:
            raise RuntimeError(f"quest {quest['id']} references missing items: {missing_items}")
    for station in data["hideoutStations"]:
        for level in station["levels"]:
            missing_items = [item["itemId"] for item in level["items"] if item["itemId"] not in item_ids]
            missing_stations = [
                item["stationId"] for item in level["stations"]
                if item["stationId"] not in station_ids
            ]
            if missing_items or missing_stations:
                raise RuntimeError(
                    f"hideout {station['id']} level {level['level']} has missing references: "
                    f"items={missing_items}, stations={missing_stations}"
                )
    unknown_marker_maps = sorted({
        marker["mapKey"] for marker in data["mapMarkers"] if marker["mapKey"] not in map_keys
    })
    unknown_floor_maps = sorted({
        floor["mapKey"] for floor in data["mapFloorLocations"] if floor["mapKey"] not in map_keys
    })
    if unknown_marker_maps or unknown_floor_maps:
        raise RuntimeError(
            f"map-key mismatch: marker maps={unknown_marker_maps}, floor maps={unknown_floor_maps}"
        )


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def reset_managed_directory(path: Path, output_root: Path) -> None:
    resolved_root = output_root.resolve()
    resolved_path = path.resolve()
    if resolved_path == resolved_root or resolved_root not in resolved_path.parents:
        raise RuntimeError(f"refusing to reset directory outside output root: {resolved_path}")
    if path.exists():
        shutil.rmtree(path)
    path.mkdir(parents=True, exist_ok=True)


def copy_verified(source: Path, destination: Path, copied: list[tuple[Path, Path]]) -> None:
    if not source.is_file():
        raise FileNotFoundError(f"required asset not found: {source}")
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, destination)
    if not destination.is_file() or file_sha256(source) != file_sha256(destination):
        raise RuntimeError(f"copied asset verification failed: {source} -> {destination}")
    copied.append((source, destination))


def image_suffix(path: Path) -> str:
    with path.open("rb") as stream:
        header = stream.read(16)
    if header.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if header.startswith(b"RIFF") and header[8:12] == b"WEBP":
        return ".webp"
    raise ValueError(f"unsupported or invalid item icon format: {path}")


def copy_assets(
    assets: Path,
    output_root: Path,
    data: dict[str, Any],
    hideout_item_ids: set[str],
) -> dict[str, Any]:
    public_assets = output_root / "assets"
    maps_output = public_assets / "maps"
    map_icons_output = public_assets / "map-icons"
    items_output = public_assets / "items"
    hideout_output = public_assets / "hideout"
    for managed in (maps_output, map_icons_output, items_output, hideout_output):
        reset_managed_directory(managed, output_root)

    copied: list[tuple[Path, Path]] = []
    map_source = assets / "DB" / "Maps"
    for config in data["mapConfigs"]:
        source = map_source / config["svgFileName"]
        copy_verified(source, maps_output / source.name, copied)

    map_icon_source = assets / "DB" / "Icons"
    map_icon_files = sorted(path for path in map_icon_source.rglob("*") if path.is_file())
    if len(map_icon_files) != EXPECTED_MAP_ICON_FILES:
        raise RuntimeError(
            f"map icon count changed: expected {EXPECTED_MAP_ICON_FILES}, "
            f"discovered {len(map_icon_files)}"
        )
    for source in map_icon_files:
        copy_verified(source, map_icons_output / source.relative_to(map_icon_source), copied)

    quest_item_ids = {
        requirement["itemId"]
        for quest in data["quests"] for requirement in quest["requiredItems"]
        if requirement["itemId"]
    }
    referenced_item_ids = quest_item_ids | hideout_item_ids
    if len(referenced_item_ids) != EXPECTED_REFERENCED_ITEM_ICONS:
        raise RuntimeError(
            f"referenced item icon count changed: expected {EXPECTED_REFERENCED_ITEM_ICONS}, "
            f"discovered {len(referenced_item_ids)}"
        )
    item_by_id = {item["id"]: item for item in data["items"]}
    item_icon_source = assets / "Icons"
    format_counts: dict[str, int] = defaultdict(int)
    item_icon_bytes = 0
    for item_id in sorted(referenced_item_ids):
        if item_id not in item_by_id:
            raise RuntimeError(f"referenced item is absent from Items export: {item_id}")
        source = item_icon_source / f"{item_id}.png"
        suffix = image_suffix(source)
        destination = items_output / f"{item_id}{suffix}"
        copy_verified(source, destination, copied)
        item_by_id[item_id]["localIcon"] = f"/assets/items/{destination.name}"
        format_counts[suffix.removeprefix(".")] += 1
        item_icon_bytes += destination.stat().st_size

    hideout_icon_source = assets / "icons" / "hideout"
    if not hideout_icon_source.is_dir():
        # Windows folds the repository's case-only Icons/icons directories together.
        hideout_icon_source = assets / "Icons" / "hideout"
    hideout_icon_bytes = 0
    for station in data["hideoutStations"]:
        encoded_id = base64.b64encode(station["id"].encode("utf-8")).decode("ascii").rstrip("=")
        source = hideout_icon_source / f"{encoded_id}.png"
        if image_suffix(source) != ".png":
            raise ValueError(f"hideout icon is not PNG: {source}")
        destination = hideout_output / f"{station['id']}.png"
        copy_verified(source, destination, copied)
        station["localIcon"] = f"/assets/hideout/{destination.name}"
        hideout_icon_bytes += destination.stat().st_size

    for _, destination in copied:
        if not destination.is_file():
            raise RuntimeError(f"expected copied path is missing: {destination}")
    return {
        "copiedFiles": len(copied),
        "maps": {"count": len(data["mapConfigs"]), "bytes": sum(
            path.stat().st_size for path in maps_output.iterdir() if path.is_file()
        )},
        "mapIcons": {"count": len(map_icon_files), "bytes": sum(
            path.stat().st_size for path in map_icons_output.rglob("*") if path.is_file()
        )},
        "itemIcons": {
            "count": len(referenced_item_ids),
            "bytes": item_icon_bytes,
            "formats": dict(sorted(format_counts.items())),
        },
        "hideoutIcons": {"count": len(data["hideoutStations"]), "bytes": hideout_icon_bytes},
    }


def write_json(data: dict[str, Any], destination: Path) -> int:
    destination.parent.mkdir(parents=True, exist_ok=True)
    content = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    destination.write_text(content, encoding="utf-8", newline="\n")
    parsed = json.loads(destination.read_text(encoding="utf-8"))
    if parsed != data:
        raise RuntimeError(f"written JSON verification failed: {destination}")
    return destination.stat().st_size


def main() -> int:
    args = parse_args()
    assets = resolve_assets(args.source)
    config_path = assets / "DB" / "Data" / "map_configs.json"
    if not config_path.is_file():
        raise FileNotFoundError(f"map config not found: {config_path}")
    map_document = json.loads(config_path.read_text(encoding="utf-8-sig"))
    map_configs = map_document.get("maps")
    if not isinstance(map_configs, list):
        raise ValueError(f"map config must contain a maps array: {config_path}")
    with closing(open_read_only(assets / "tarkov_data.db")) as connection:
        counts = assert_source_counts(connection, len(map_configs))
        items, item_by_id, item_by_name = export_items(connection)
        quests = export_quests(connection)
        hideout_stations, hideout_item_ids = export_hideout(
            connection, item_by_id, item_by_name
        )
        data = {
            "meta": {
                "originalCommit": ORIGINAL_COMMIT,
                "modifiedCommit": MODIFIED_COMMIT,
                "exportedAt": EXPORTED_AT,
                "counts": {
                    "quests": counts["Quests"],
                    "items": counts["Items"],
                    "hideoutStations": counts["HideoutStations"],
                    "maps": len(map_configs),
                    "mapMarkers": counts["MapMarkers"],
                },
            },
            "quests": quests,
            "items": items,
            "hideoutStations": hideout_stations,
            "traders": export_traders(connection),
            "mapConfigs": export_map_configs(map_configs),
            "mapMarkers": export_map_markers(connection),
            "mapFloorLocations": export_floor_locations(connection),
        }
    validate_export(data, counts)
    asset_summary = copy_assets(assets, args.output, data, hideout_item_ids)
    json_path = args.output / "data" / "tarkov-data.json"
    json_bytes = write_json(data, json_path)
    summary = {
        "source": str(assets),
        "output": str(args.output),
        "counts": data["meta"]["counts"],
        "json": {"path": str(json_path), "bytes": json_bytes},
        "assets": asset_summary,
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (FileNotFoundError, RuntimeError, ValueError, sqlite3.Error) as error:
        print(f"export failed: {error}", file=sys.stderr)
        raise SystemExit(1)
