/**
 * Presentation rendering (Blender-MCP 1.2.0) — `render_model` support.
 *
 * Builds the Blender script that applies the presentation preset and
 * renders EEVEE PNGs, one per view:
 *
 * - 50 mm camera, auto-framed on the bounding-box centre with margin
 * - 3-point area-light rig: key ~100 W at 2 m, fill at most half the key,
 *   rim behind — plus a sun and a world light
 * - ground plane at z = 0
 *
 * The script is run as `blender --background <blend> --python <script> --
 * <output_prefix> <view...>` and prints a RENDER_DONE_JSON line. The host
 * (ModelBuilder.renderModel) verifies every PNG exists on disk and is
 * non-empty before reporting success — a missing/empty PNG is a failure,
 * never success:true.
 */
export declare const RENDER_VIEWS: readonly ["front", "side", "back", "top", "perspective"];
export type RenderView = (typeof RENDER_VIEWS)[number];
export declare function buildRenderScript(views: string[]): string;
//# sourceMappingURL=render.d.ts.map