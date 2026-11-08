/**
 * Product render pipeline (Blender-MCP 1.3.0) — `render_model` support.
 *
 * Builds the Blender script that applies the presentation preset and
 * renders PNGs, one per view:
 *
 * - Camera auto-framed on the bounding-box centre with margin, Track-To
 *   aimed; 50 mm default, 85 mm hero, 90-105 mm macro for small products.
 *   Framing is EXACT: per view the camera pulls back until the subject's
 *   binding axis fills `fill_fraction` (default 0.7) of the frame — the
 *   old `max_dim * 2.5 + 0.5` heuristic rendered the v1.3.0 watch at ~30%
 *   of the frame.
 * - 3-point + rim area-light rig derived from the product bounding box,
 *   intensities set by RATIO (key 1.0, fill 0.2-0.4x key, rim brightest
 *   in effect) — no canonical wattage exists in the Blender manual or the
 *   tutorials read, so none is invented; validate via the look loop
 * - Studio HDRI world lighting when an HDRI path is given (Poly Haven,
 *   CC0 — licence verified at polyhaven.com/license on 2026-11-07; the
 *   auto-download falls back to the world+sun setup when it fails),
 *   otherwise the v1.2.0 world light (0.35) + sun
 * - Ground plane at z = 0 (Cycles Shadow Catcher + Film Transparent for
 *   transparent-background product shots; EEVEE has no shadow catcher)
 * - Colour: Khronos PBR Neutral for catalogue shots, AgX for hero shots
 *   (Filmic is deprecated, superseded by AgX; never Standard for finals)
 * - Cycles: CPU (this VM has no GPU), 128-256 samples + OpenImageDenoise
 *   (Albedo + Normal passes); EEVEE for fast previews / turntable drafts
 * - Turntable: exactly 360 deg about Z at constant speed, camera orbiting
 *   at fixed elevation, lights fixed
 * - Cinematic style (v1.4.0, `style: 'cinematic'`): AgX + Look "AgX - Punchy",
 *   Cycles 512 samples + OIDN, 1920x1080, low-key 8:1 rig (warm key spot,
 *   teal rim 1.5-2x key light-linked to the hero, amber rim + accent),
 *   bounded Principled-Volume fog cube (density 0.01, anisotropy 0.5,
 *   noise-modulated), Mist pass, wet reflective floor, DoF f/5.6, and a
 *   compositor chain (Mist -> Glare Fog Glow -> teal-lift/warm-gain Color
 *   Balance -> S-curve -> vignette -> film grain). Environments:
 *   dark_studio (near-black world + wet floor), industrial_hall (hall box +
 *   columns + background glow planes + fog), neon (emissive strip cards +
 *   under-glow). Optional 1.7 m silhouette scale figure and render-time
 *   monumental hero scaling (`hero_scale_m` — labelled hero-scale, not
 *   real scale). All bpy property/enum names were smoke-tested in real
 *   Blender 4.2.0 before shipping (see research report §9): the AgX Look is
 *   "AgX - Punchy" (bare "Punchy" is wrong), Principled Coat/Anisotropic
 *   inputs are Title Case, light linking works via
 *   `Object.light_linking.receiver_collection`, and
 *   `scene.cycles.volume_sampling` does NOT exist in 4.2 (dropped).
 *
 * The script is run as `blender --background <blend> --python <script> --
 * <output_prefix> <view...>` and prints a RENDER_DONE_JSON line. The host
 * (ModelBuilder.renderModel) verifies every PNG exists on disk and is
 * non-empty before reporting success — a missing/empty PNG is a failure,
 * never success:true.
 */
export declare const RENDER_VIEWS: readonly ["front", "side", "back", "top", "perspective"];
export type RenderView = (typeof RENDER_VIEWS)[number];
export type RenderEngine = 'EEVEE' | 'CYCLES';
export type ViewTransform = 'Khronos PBR Neutral' | 'AgX';
export type RenderStyle = 'studio' | 'cinematic';
export type RenderEnvironment = 'dark_studio' | 'industrial_hall' | 'neon';
export interface RenderOptions {
    engine?: RenderEngine;
    samples?: number;
    view_transform?: ViewTransform;
    lens?: number;
    fill_fraction?: number;
    transparent?: boolean;
    turntable_frames?: number;
    resolution?: [number, number];
    hdri_path?: string;
    style?: RenderStyle;
    environment?: RenderEnvironment;
    scale_figure?: boolean;
    hero_scale_m?: number;
    fog_density?: number;
}
export declare function buildRenderScript(views: string[], options?: RenderOptions): string;
//# sourceMappingURL=render.d.ts.map