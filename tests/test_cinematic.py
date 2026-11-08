"""Cinematic render preset tests (Blender-MCP v1.4.0).

Covers only the new preset paths — validation errors, cinematic defaults
in the generated script, studio defaults unchanged, the new materials,
the new detail kinds, the slim-can dimension entry, and the cinematic
critique checks. The full render is exercised in real Blender separately
(see the v1.4.0 report); these tests run on generated scripts only.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest

from blender_mcp.critique import CRITIQUE_PROMPT_TEMPLATE
from blender_mcp.details import DETAIL_KINDS, get_detail_script
from blender_mcp.grounding import DIMENSION_LIBRARY, get_dimensions
from blender_mcp.materials import MaterialLibrary
from blender_mcp.render import build_render_script


# --- render preset: validation -------------------------------------------

def test_cinematic_transparent_is_refused():
    with pytest.raises(ValueError, match="transparent"):
        build_render_script(["front"], {"style": "cinematic", "transparent": True})


def test_cinematic_bad_style_is_refused():
    with pytest.raises(ValueError, match="style"):
        build_render_script(["front"], {"style": "moody"})


def test_cinematic_bad_environment_is_refused():
    with pytest.raises(ValueError, match="environment"):
        build_render_script(["front"], {"style": "cinematic", "environment": "beach"})


def test_cinematic_bad_hero_scale_is_refused():
    with pytest.raises(ValueError, match="hero_scale_m"):
        build_render_script(["front"], {"style": "cinematic", "hero_scale_m": 100})
    with pytest.raises(ValueError, match="hero_scale_m"):
        build_render_script(["front"], {"style": "cinematic", "hero_scale_m": 0.01})


def test_cinematic_bad_fog_density_is_refused():
    with pytest.raises(ValueError, match="fog_density"):
        build_render_script(["front"], {"style": "cinematic", "fog_density": 0.5})


# --- render preset: cinematic defaults ------------------------------------

def test_cinematic_defaults():
    s = build_render_script(["perspective"], {"style": "cinematic"})
    assert 'STYLE = "cinematic"' in s
    assert "AgX - Punchy" in s
    assert "CYCLES" in s
    assert "SAMPLES = 512" in s  # samples
    assert "_fog_density = FOG_DENSITY if FOG_DENSITY is not None else 0.01" in s
    assert "LENS = 85" in s
    assert "FILL_FRACTION = 0.4" in s
    assert "use_pass_mist" in s
    assert "FOG_GLOW" in s
    assert "view_layer.use_pass_mist" in s


def test_cinematic_has_rim_lights_and_no_sun():
    s = build_render_script(["perspective"], {"style": "cinematic"})
    assert "CineRimTeal" in s and "CineRimAmber" in s
    # The sun exists only in the studio branch, guarded by `if not CINEMATIC`.
    sun_at = s.index("type='SUN'")
    assert "if not CINEMATIC:" in s[max(0, sun_at - 200):sun_at]


def test_cinematic_hall_with_hero_scale_and_figure():
    s = build_render_script(
        ["perspective"],
        {"style": "cinematic", "environment": "industrial_hall",
         "hero_scale_m": 3.0, "scale_figure": True},
    )
    assert "HALL_L" in s
    assert "ScaleFigure" in s
    assert "hero_scale_m" in s.lower() or "HERO_SCALE_M = 3.0" in s


def test_cinematic_neon_has_strips():
    s = build_render_script(["perspective"], {"style": "cinematic", "environment": "neon"})
    assert "NeonStrip" in s


def test_cinematic_vignette_is_full_resolution():
    # Regression (2026-11-08 NISHANT hero): the vignette was a 256x256
    # image fed into a MULTIPLY Mix node, and the Mix node takes the
    # smaller input's size — so every cinematic render came out as a
    # centred 256x256 square, cropping the hero's lid, glow ring and
    # base at 1920x1080 (the 960x540 diag only survived because the
    # whole can fit inside 256x256). The vignette must be built at the
    # full render resolution.
    s = build_render_script(["perspective"], {"style": "cinematic"})
    assert "_vw, _vh = RES_X, RES_Y" in s
    assert "_vw, _vh = 256, 256" not in s


# --- render preset: studio defaults unchanged -----------------------------

def test_studio_defaults_unchanged():
    # NOTE: the generated script contains BOTH branches as text (the style
    # is a runtime `if CINEMATIC:`), so these assert the studio DEFAULTS,
    # not the absence of cinematic strings.
    s = build_render_script(["front", "side", "perspective"])
    assert 'STYLE = "studio"' in s
    assert "BLENDER_EEVEE_NEXT" in s
    assert "LENS = 50" in s
    assert "FILL_FRACTION = 0.7" in s
    assert "KeyLight" in s and "FillLight" in s and "RimLight" in s


# --- materials ------------------------------------------------------------

def test_weathered_stone_has_pointiness_and_ao():
    s = MaterialLibrary.get_material_script("weathered_stone")
    assert "Pointiness" in s
    assert "ShaderNodeAmbientOcclusion" in s
    assert "ShaderNodeTexVoronoi" in s


def test_brushed_aluminium_is_anisotropic():
    s = MaterialLibrary.get_material_script("brushed_aluminium")
    assert 'Anisotropic' in s
    assert "ShaderNodeTangent" in s
    assert 'Metallic' in s


def test_printed_can_rule():
    s = MaterialLibrary.get_material_script("printed_can")
    # THE printed-can rule: Metallic 0.0 + lacquer coat, never metallic.
    assert 'bsdf.inputs["Metallic"].default_value = 0.0' in s
    assert 'bsdf.inputs["Coat Weight"].default_value = 1.0' in s
    assert 'bsdf.inputs["Coat Roughness"].default_value = 0.08' in s


def test_wet_floor_has_puddle_roughness():
    s = MaterialLibrary.get_material_script("wet_floor")
    assert "(0.02, 0.02, 0.02, 1)" in s  # puddle roughness
    assert "(0.6, 0.6, 0.6, 1)" in s     # dry roughness


def test_emissive_materials():
    teal = MaterialLibrary.get_material_script("emissive_teal")
    amber = MaterialLibrary.get_material_script("emissive_amber")
    assert "Emission Strength" in teal and "Emission Strength" in amber
    assert "(0.0, 0.85, 1.0, 1)" in teal
    assert "(1.0, 0.55, 0.2, 1)" in amber


# --- details --------------------------------------------------------------

def test_new_detail_kinds_registered():
    for kind in ("condensation", "emissive_ring", "glow_strip"):
        assert kind in DETAIL_KINDS


def test_condensation_script_uses_visible_shadow_and_template():
    s = get_detail_script("condensation", "CanBody", {})
    assert "visible_shadow = False" in s
    # The old API name appears only in the NOTE comment, never as code.
    assert "_drops.cycles_visibility" not in s
    assert "create_uvsphere" in s and "radius=1.0" in s
    assert "_stamp(_m)" in s  # template stamping, not per-drop ops


def test_condensation_bad_density_is_refused():
    with pytest.raises(ValueError, match="density"):
        get_detail_script("condensation", "CanBody", {"density": "soaked"})


def test_emissive_ring_validates():
    s = get_detail_script("emissive_ring", "CanBody", {"color": "#00D8FF", "strength": 3})
    assert "EmissiveRing" in s
    assert "Emission Strength" in s
    with pytest.raises(ValueError, match="strength"):
        get_detail_script("emissive_ring", "CanBody", {"strength": 50})
    with pytest.raises(ValueError, match="color"):
        get_detail_script("emissive_ring", "CanBody", {"color": "notacolor"})


def test_glow_strip_validates():
    s = get_detail_script("glow_strip", "CanBody", {"face": "front", "strength": 5})
    assert "GlowStrip" in s
    with pytest.raises(ValueError, match="strength"):
        get_detail_script("glow_strip", "CanBody", {"strength": 0})


# --- coffee material (v1.4.0 ride-along fix) -------------------------------

def test_coffee_material_is_dark_brown_not_stone_grey():
    # The coffee_mug library part uses material "coffee". Before v1.4.0 no
    # builder existed, so it silently fell back to flat stone grey
    # (0.6, 0.58, 0.55) — the v1.3.1 demo mug rendered with a pale
    # grey/white surface that read as a lid. A coffee surface is dark brown.
    s = MaterialLibrary.get_material_script("coffee")
    assert "(0.09, 0.045, 0.02, 1)" in s
    # Roughness 0.7, not 0.35: at 0.35 the up-facing disc mirror-washed
    # to pale grey-blue (cinematic) / near-white (studio) at the grazing
    # viewing angle — the Fresnel specular of the cool fill light and fog
    # swamped the dark diffuse brown even though the colour was right.
    assert '["Roughness"].default_value = 0.7' in s
    assert MaterialLibrary.MATERIALS["coffee"]["roughness"] == 0.7
    # Specular IOR Level 0.0: the grazing Fresnel mirror of the cool
    # fill/fog must be cut at the source, not just spread by roughness.
    assert '["Specular IOR Level"].default_value = 0.0' in s
    assert "ShaderNodeTexNoise" not in s  # plain Principled, like amber_liquid
    assert MaterialLibrary.MATERIALS["coffee"]["base_color"] == (0.09, 0.045, 0.02, 1)
    # Same silent-fallback class, fixed alongside: "ceramic" (mug body) had
    # no builder either and fell back to stone grey.
    cs = MaterialLibrary.get_material_script("ceramic")
    assert "(0.95, 0.95, 0.95, 1)" in cs
    assert '["Roughness"].default_value = 0.3' in cs


def test_coffee_disc_sits_above_the_rim_not_coplanar():
    # The coffee disc top must sit ~0.5 mm ABOVE the mug rim. Exactly
    # coplanar with the solid body cap, the two discs z-fight and the
    # white body cap wins — the coffee renders grey no matter the material
    # (measured on the v1.4.0 fix round: dark-brown material + flat caps
    # still rendered grey until the disc was raised 0.5 mm).
    from blender_mcp.grounding import DIMENSION_LIBRARY
    lib = DIMENSION_LIBRARY["coffee_mug"]["parts"]
    assert "0.5 mm ABOVE" in lib["Coffee"]["note"]
    assert "coplanar" in lib["Coffee"]["note"]


# --- dimension library ----------------------------------------------------

def test_slim_can_250ml_entry():
    entry = DIMENSION_LIBRARY["slim_can_250ml"]
    assert entry["overall_size_m"] == [0.053, 0.053, 0.133]
    assert "Crown" in entry["source"]
    assert entry["parts"]["CanBody"]["material"] == "printed_can"
    assert entry["parts"]["Lid"]["material"] == "brushed_aluminium"
    assert entry["parts"]["StayTab"]["material"] == "polished_steel"
    # Neck taper and stay-tab are estimates, flagged as such.
    assert "[E]" in entry["parts"]["Neck"]["note"]
    assert "[E]" in entry["parts"]["StayTab"]["note"]


def test_slim_can_lookup():
    result = get_dimensions("slim_can_250ml")
    assert result["success"] is True
    assert result["overall_size_m"] == [0.053, 0.053, 0.133]


# --- critique -------------------------------------------------------------

def test_critique_template_has_cinematic_checks():
    for phrase in ("brightest object", "rim light", "light shafts",
                   "crushed to pure black", "human-sized", "off-centre", "banding"):
        assert phrase in CRITIQUE_PROMPT_TEMPLATE
