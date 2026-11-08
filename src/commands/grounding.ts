/**
 * Anti-hallucination grounding (Blender-MCP 1.3.1).
 *
 * TypeScript mirror of blender_mcp/grounding.py — keep the two in sync.
 * The guardrails live in the MCP itself, enforced by code:
 * research-first grounding, stated dimension sources, strict spec
 * validation (in spec.ts), and post-build verification before any
 * success is reported.
 */

export const DIMENSION_SOURCES = ['measured', 'research', 'library', 'reference_image', 'retrieved_asset'] as const;
export type DimensionSource = (typeof DIMENSION_SOURCES)[number];

export const GROUNDING_SOURCES = ['research_model', 'reference_image', 'retrieved_asset', 'dimension_library'] as const;
export type GroundingSource = (typeof GROUNDING_SOURCES)[number];

export interface LibraryPart {
  size_m: [number, number, number];
  material: string;
  note: string;
}

export interface LibraryEntry {
  overall_size_m: [number, number, number];
  source: string;
  parts: Record<string, LibraryPart>;
}

/**
 * Real-world dimension library. [S] = sourced from a named reference
 * (v1.2.0 research report §3 or the v1.3.0 product builders);
 * [E] = estimate from a sourced envelope or standard practice.
 */
export const DIMENSION_LIBRARY: Record<string, LibraryEntry> = {
  headphones: {
    overall_size_m: [0.21, 0.1, 0.23],
    source: '[E] v1.3.0 procedural builder (real over-ear dimensions)',
    parts: {
      Headband: { size_m: [0.176, 0.026, 0.086], material: 'black', note: 'Arched band, radius 0.085 m, top z = 0.21 m' },
      HeadbandCushion: { size_m: [0.156, 0.02, 0.078], material: 'smooth_leather', note: 'Inner cushion, smaller radius, touches the band' },
      EarCup: { size_m: [0.03, 0.092, 0.092], material: 'black', note: 'Cup Ø 0.092 m, 0.030 m thick, centre z = 0.047 m' },
      EarCushion: { size_m: [0.022, 0.094, 0.094], material: 'smooth_leather', note: 'Padded ring on the inner face of each cup' },
      Driver: { size_m: [0.004, 0.064, 0.064], material: 'black', note: 'Recessed driver disc Ø 0.064 m inside the cushion ring' },
      Yoke: { size_m: [0.01, 0.01, 0.056], material: 'polished_steel', note: 'Steel slider from band end to cup top' },
    },
  },
  sneaker: {
    overall_size_m: [0.28, 0.1, 0.11],
    source: '[E] standard UK 9 / EU 43 running shoe, v1.3.0 builder',
    parts: {
      Midsole: { size_m: [0.286, 0.09, 0.02], material: 'white_leather', note: 'Lofted sole, toe spring: tip rises to z = 0.018 m' },
      Outsole: { size_m: [0.286, 0.09, 0.007], material: 'rubber', note: 'Thin dark rubber under the midsole, follows the toe spring' },
      Upper: { size_m: [0.278, 0.086, 0.072], material: 'white_leather', note: 'Lofted upper, ankle opening at the heel' },
      Tongue: { size_m: [0.13, 0.03, 0.01], material: 'smooth_leather', note: 'Padded tongue, 17 deg slope, sits ~4 mm above the upper' },
      ToeCap: { size_m: [0.05, 0.06, 0.02], material: 'smooth_leather', note: 'Flattened ellipsoid on the toe only' },
      HeelCounter: { size_m: [0.058, 0.058, 0.05], material: 'smooth_leather', note: 'Curved strip wrapping the heel' },
      Laces: { size_m: [0.064, 0.032, 0.009], material: 'white_leather', note: 'One bezier tube zig-zagging across the tongue, never floating' },
    },
  },
  perfume: {
    overall_size_m: [0.08, 0.045, 0.15],
    source: '[E] standard 50 ml perfume bottle, v1.3.0 builder',
    parts: {
      BottleBody: { size_m: [0.075, 0.04, 0.105], material: 'glass', note: 'Bevelled glass body, no 90-degree edges' },
      Liquid: { size_m: [0.068, 0.033, 0.088], material: 'amber_liquid', note: 'Amber liquid inside, slightly smaller than the body' },
      Neck: { size_m: [0.022, 0.022, 0.012], material: 'glass', note: 'Glass neck Ø 0.022 m' },
      NeckRing: { size_m: [0.028, 0.028, 0.005], material: 'gold', note: 'Gold ring around the neck' },
      Cap: { size_m: [0.029, 0.029, 0.03], material: 'gold', note: 'Bevelled gold cap SEATED on the neck (overlaps the ring)' },
      Label: { size_m: [0.04, 0.0015, 0.022], material: 'white', note: 'Thin white plate on the front face, NOIR text on it' },
    },
  },
  smartwatch: {
    overall_size_m: [0.24, 0.046, 0.02],
    source: '[E] standard smartwatch, v1.3.0 builder; real asset: Poly Haven digital_wrist_watch (CC0)',
    parts: {
      WatchCase: { size_m: [0.046, 0.038, 0.012], material: 'steel', note: 'Bevelled case, face up, strap along X' },
      Dial: { size_m: [0.04, 0.032, 0.002], material: 'black', note: 'Black dial plate on the top face' },
      DialGlass: { size_m: [0.042, 0.034, 0.0015], material: 'glass', note: 'Thin glass over the dial' },
      Crown: { size_m: [0.005, 0.007, 0.007], material: 'polished_steel', note: 'Crown on the +X side of the case' },
      Strap: { size_m: [0.118, 0.022, 0.003], material: 'smooth_leather', note: 'Curved strap per side, dips to the ground, curls up at the tip' },
      Buckle: { size_m: [0.008, 0.026, 0.004], material: 'polished_steel', note: 'Buckle frame at the +X strap tip' },
    },
  },
  chair: {
    overall_size_m: [0.45, 0.45, 0.95],
    source: '[E] standard dining chair (seat height 0.45 m)',
    parts: {
      Seat: { size_m: [0.45, 0.45, 0.05], material: 'wood', note: 'Seat top z = 0.45 m' },
      Leg: { size_m: [0.04, 0.04, 0.45], material: 'wood', note: 'Four legs, Ø 0.04 m, seat height 0.45 m' },
      Backrest: { size_m: [0.45, 0.04, 0.5], material: 'wood', note: 'Backrest from seat (z 0.45) to z 0.95 m' },
    },
  },
  temple: {
    overall_size_m: [4.5, 3.5, 7.4],
    source: '[E] v1.2.0 template (Indian temple, Nagara style)',
    parts: {
      Adhishthana: { size_m: [4.5, 3.5, 0.6], material: 'sandstone', note: 'Base: 4 steps ascending, top step z = 0.6 m' },
      Garbhagriha: { size_m: [3.0, 2.5, 2.2], material: 'sandstone', note: 'Main sanctum, standing on the steps' },
      Shikhara: { size_m: [3.6, 3.6, 4.0], material: 'sandstone', note: 'Tower: 5 tiers above the sanctum, top z = 6.8 m' },
      Mandapa: { size_m: [3.0, 2.0, 0.3], material: 'sandstone', note: 'Pillared hall platform in front of the sanctum' },
      Pillar: { size_m: [0.3, 0.3, 2.5], material: 'sandstone', note: 'Mandapa pillars Ø 0.30 m, z 0.3-2.8 m' },
    },
  },
  rickshaw: {
    overall_size_m: [2.658, 1.3, 1.7],
    source: '[S] Bajaj RE4S brochure (v1.2.0 report §3.1)',
    parts: {
      Wheel: { size_m: [0.11, 0.42, 0.42], material: 'rubber', note: '[S] MRF 4.00x8 tyre, Ø 0.414-0.429 m, centre z = 0.21 m' },
      FrontFork: { size_m: [0.08, 0.08, 0.75], material: 'steel', note: '[E] steering column Ø 0.08 m, raked ~15 deg' },
      Handlebar: { size_m: [0.035, 0.55, 0.035], material: 'steel', note: '[E] width 0.55 m, grip Ø 0.035 m, z = 1.05 m' },
      Headlight: { size_m: [0.1, 0.15, 0.15], material: 'glass', note: '[E] single round centre light Ø 0.15 m at the nose' },
      FrontApron: { size_m: [0.35, 0.55, 0.55], material: 'yellow', note: '[E] nose panel, z 0.35-0.90 m' },
      Windshield: { size_m: [0.02, 0.95, 0.45], material: 'glass', note: '[E] 0.95 m wide x 0.45 m high, tilted back ~20 deg' },
      DriverSeat: { size_m: [0.45, 0.45, 0.1], material: 'black', note: '[E] seat top z = 0.62 m' },
      PassengerBench: { size_m: [0.55, 1.05, 0.12], material: 'black', note: '[E] seat top z = 0.60 m' },
      FloorPan: { size_m: [2.3, 1.15, 0.06], material: 'steel', note: '[E] chassis pan, z 0.20-0.26 m (ground clearance)' },
      Canopy: { size_m: [1.9, 1.25, 0.06], material: 'black', note: '[E] LOW gently curved sheet, top z = 1.70 m — never a dome' },
    },
  },
  thali: {
    overall_size_m: [0.32, 0.32, 0.06],
    source: '[S] GeM canteen spec (v1.2.0 report §3.2)',
    parts: {
      ThaliPlate: { size_m: [0.32, 0.32, 0.022], material: 'steel', note: '[S] bottom Ø 0.270 m, top Ø 0.320 m, depth 0.0225 m' },
      RiceMound: { size_m: [0.13, 0.13, 0.05], material: 'white', note: '[E] Ø 0.13 m dome at the centre' },
      Katori: { size_m: [0.1, 0.1, 0.04], material: 'steel', note: '[S] top Ø 0.1007 m, base Ø 0.0598 m, H 0.0393 m; ring around the rice' },
      Roti: { size_m: [0.16, 0.16, 0.003], material: 'bread', note: '[S] Ø 0.15-0.18 m, thickness 0.002-0.003 m' },
      Spoon: { size_m: [0.16, 0.02, 0.01], material: 'steel', note: '[S] 0.16 m long, on the plate rim' },
      WaterGlass: { size_m: [0.075, 0.075, 0.105], material: 'glass', note: '[S] Ø 0.075 m, H 0.105 m' },
    },
  },
  haveli: {
    overall_size_m: [12.0, 10.0, 9.4],
    source: '[E] representative haveli (v1.2.0 report §3.3); floor heights [S] NBC/SP 73:2023',
    parts: {
      Plinth: { size_m: [12.0, 10.0, 0.5], material: 'sandstone', note: '[E] base z 0-0.5 m, darker sandstone' },
      GroundFloor: { size_m: [12.0, 10.0, 3.2], material: 'sandstone', note: '[S] floor-to-floor 3.0-3.3 m; rooms on all 4 sides of a 4x4 m courtyard' },
      FirstFloor: { size_m: [12.0, 10.0, 3.2], material: 'sandstone', note: 'Second storey, z 3.7-6.9 m, set back with veranda' },
      Parapet: { size_m: [12.0, 10.0, 1.0], material: 'sandstone', note: '[S] parapet H 1.0-1.2 m, flat roof — NO temple spire' },
      Portal: { size_m: [2.4, 0.5, 4.5], material: 'sandstone', note: '[E] arched entrance 2.4 m wide x 4.5 m high, front centre' },
      Window: { size_m: [0.9, 0.1, 1.8], material: 'glass', note: '[E] arched window 0.9 x 1.8 m with cusped arch, dark recess' },
      Jharokha: { size_m: [1.2, 1.0, 2.2], material: 'sandstone', note: '[E] overhanging balcony, projects ~1.0 m from the front face' },
      Chhatri: { size_m: [1.5, 1.5, 2.5], material: 'sandstone', note: '[E] domed pavilion: 1.5 m base, 4 pillars, dome Ø 1.4 m, dome top ~9.4 m' },
      VerandaColumn: { size_m: [0.3, 0.3, 2.7], material: 'sandstone', note: '[E] column Ø 0.30 m, H 2.7 m per floor, around the courtyard' },
    },
  },
  character: {
    overall_size_m: [0.46, 0.27, 1.75],
    source: '[S] ANSUR II proportions (v1.2.0 report §3.4); H = 1.75 m, 7.5 heads',
    parts: {
      Head: { size_m: [0.16, 0.19, 0.23], material: 'skin', note: '[S] head ~0.13 of height, z 1.52-1.75 m' },
      Neck: { size_m: [0.11, 0.11, 0.1], material: 'skin', note: '[E] Ø 0.11 m, z 1.42-1.52 m' },
      Torso: { size_m: [0.42, 0.22, 0.6], material: 'kurta', note: '[S] shoulders 0.46 m wide, shoulder-to-crotch 0.60 m' },
      UpperArm: { size_m: [0.09, 0.09, 0.3], material: 'kurta', note: '[S] L 0.30 m, Ø 0.09 m, shoulder 1.45 m to elbow 1.09 m' },
      Forearm: { size_m: [0.07, 0.07, 0.3], material: 'kurta', note: '[S] L 0.30 m, elbow 1.09 m to wrist; hand 0.19 m, fingertips z 0.65 m' },
      Thigh: { size_m: [0.15, 0.15, 0.45], material: 'dhoti', note: '[S] L 0.45 m, Ø 0.15 m, hip 0.90 m to knee 0.53 m' },
      Shin: { size_m: [0.12, 0.12, 0.42], material: 'skin', note: '[S] L 0.42 m, knee 0.53 m to ankle 0.08 m' },
      Foot: { size_m: [0.1, 0.27, 0.03], material: 'leather', note: '[S] foot 0.27 m x 0.10 m, z 0-0.03 m' },
      Kurta: { size_m: [0.48, 0.24, 0.75], material: 'kurta', note: '[S] shoulder-to-hem 0.75-0.85 m, z 0.75-1.50 m' },
      Dhoti: { size_m: [0.38, 0.38, 0.93], material: 'dhoti', note: '[S] waist z ~0.95 m, ankle-length hem z ~0.02-0.05 m' },
    },
  },
  spaceship: {
    overall_size_m: [13.4, 11.76, 2.4],
    source: '[S] X-wing T-65B, starwars.com / Wikipedia (v1.2.0 report §3.5); template scales to ~2.5-3.0 m',
    parts: {
      Fuselage: { size_m: [13.4, 1.1, 1.1], material: 'metal', note: '[S] long narrow wedge, pointed nose; hull off-white with red markings' },
      CockpitCanopy: { size_m: [1.8, 0.9, 0.6], material: 'glass', note: '[E] tinted dark glass, x +1.5..+3.3 m, top z +0.7 m' },
      Engine: { size_m: [2.8, 0.85, 0.85], material: 'metal', note: '[E] Ø 0.85 m x L 2.8 m, 4x around the rear fuselage' },
      SFoil: { size_m: [1.6, 5.0, 0.12], material: 'metal', note: '[E] each wing 5.0 m span x 1.6 m chord x 0.12 m thick; 4 form an X' },
      LaserCannon: { size_m: [1.2, 0.12, 0.12], material: 'metal', note: '[E] 1.2 m long, one at each wingtip' },
    },
  },
  alien: {
    overall_size_m: [0.3, 0.26, 1.3],
    source: '[S] classic Grey alien, Wikipedia (v1.2.0 report §3.6); H = 1.30 m, 3.8 heads tall',
    parts: {
      Head: { size_m: [0.24, 0.26, 0.34], material: 'skin', note: '[S] head ~26% of height (human: 13%), z 0.96-1.30 m' },
      Eye: { size_m: [0.09, 0.045, 0.02], material: 'black', note: '[E] almond eyes 0.09 x 0.045 m, slanted ~30 deg, solid black, no whites' },
      Neck: { size_m: [0.07, 0.07, 0.09], material: 'skin', note: '[E] very thin neck Ø 0.07 m' },
      Torso: { size_m: [0.24, 0.13, 0.42], material: 'skin', note: '[S] small chest, shoulders z 0.87 m, hips z 0.45 m' },
      Arm: { size_m: [0.045, 0.045, 0.56], material: 'skin', note: '[E] upper 0.28 m + forearm 0.28 m, fingertips z ~0.28 m (below knees)' },
      Leg: { size_m: [0.06, 0.06, 0.42], material: 'skin', note: '[E] thigh 0.20 m + shin 0.22 m, hip 0.45 m to ankle 0.03 m' },
      Foot: { size_m: [0.06, 0.16, 0.03], material: 'skin', note: '[E] L 0.16 m, narrow, 3-4 toes' },
    },
  },
  robot: {
    overall_size_m: [0.55, 0.3, 1.8],
    source: '[E] standard humanoid robot proportions (no sourced spec in the v1.2.0 report — flagged estimate)',
    parts: {
      Head: { size_m: [0.22, 0.22, 0.25], material: 'metal', note: '[E] head with visor/eyes, z 1.55-1.80 m' },
      Torso: { size_m: [0.45, 0.28, 0.55], material: 'metal', note: '[E] chest with panel lines, z 0.95-1.50 m' },
      UpperArm: { size_m: [0.09, 0.09, 0.3], material: 'metal', note: '[E] L 0.30 m, shoulder to elbow' },
      Forearm: { size_m: [0.08, 0.08, 0.28], material: 'metal', note: '[E] L 0.28 m, elbow to wrist' },
      Thigh: { size_m: [0.14, 0.14, 0.42], material: 'metal', note: '[E] L 0.42 m, hip to knee' },
      Shin: { size_m: [0.12, 0.12, 0.4], material: 'metal', note: '[E] L 0.40 m, knee to ankle' },
      Foot: { size_m: [0.1, 0.26, 0.05], material: 'metal', note: '[E] foot plate 0.26 m long, z 0-0.05 m' },
    },
  },
  coffee_mug: {
    overall_size_m: [0.111, 0.082, 0.088],
    source: '[E] standard 300 ml ceramic mug (Ø 0.082 m, H 0.088 m)',
    parts: {
      MugBody: { size_m: [0.082, 0.082, 0.088], material: 'ceramic', note: '[E] cylinder Ø 0.082 m, H 0.088 m, sits on the ground' },
      Handle: { size_m: [0.035, 0.05, 0.012], material: 'ceramic', note: '[E] vertical loop on one side: rotation_deg [90, 0, 0], x 0.035-0.07 m (overlaps the body), z 0.025-0.075 m — an unrotated torus is a flat ring, not a handle' },
      Coffee: { size_m: [0.072, 0.072, 0.002], material: 'coffee', note: '[E] coffee surface disc FLUSH with the rim (top z = 0.088 m). The spec-path body is a solid cylinder, so a disc placed inside it is hidden — the surface must sit at the rim' },
    },
  },
  desk_lamp: {
    overall_size_m: [0.2, 0.15, 0.45],
    source: '[E] standard architect desk lamp',
    parts: {
      Base: { size_m: [0.2, 0.15, 0.02], material: 'metal', note: '[E] weighted base, z 0-0.02 m' },
      LowerArm: { size_m: [0.02, 0.02, 0.2], material: 'metal', note: '[E] lower arm from base joint, tilted ~30 deg' },
      UpperArm: { size_m: [0.02, 0.02, 0.2], material: 'metal', note: '[E] upper arm from elbow joint to the shade' },
      Shade: { size_m: [0.14, 0.14, 0.16], material: 'metal', note: '[E] cone shade Ø 0.14 m, angled down over the desk' },
      Bulb: { size_m: [0.05, 0.05, 0.06], material: 'glass', note: '[E] bulb inside the shade' },
    },
  },
};

export function getDimensions(product?: string): Record<string, unknown> {
  if (!product) {
    return {
      products: Object.keys(DIMENSION_LIBRARY).sort(),
      note: 'Call get_dimensions with a product name for its real dimensions (overall size + per-part sizes, with sources).',
    };
  }
  const key = product.toLowerCase().trim();
  const entry = DIMENSION_LIBRARY[key];
  if (!entry) {
    return { success: false, error: `Unknown product '${product}'. Known products: ${Object.keys(DIMENSION_LIBRARY).sort().join(', ')}.` };
  }
  return { success: true, product: key, ...entry };
}

export function libraryPartSize(product: string, partName: string): [number, number, number] | null {
  const entry = DIMENSION_LIBRARY[(product || '').toLowerCase().trim()];
  if (!entry) return null;
  for (const [name, part] of Object.entries(entry.parts)) {
    if (name.toLowerCase() === (partName || '').toLowerCase()) return part.size_m;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Grounding registry — records issued by research_model in this session.
// ---------------------------------------------------------------------------

export interface Grounding {
  grounding_id: string;
  source: GroundingSource;
  query?: string | null;
  product?: string | null;
  references?: Array<Record<string, unknown>>;
  reference?: string | null;
  observed_features?: string[];
  asset?: Record<string, unknown> | null;
}

const groundingRegistry = new Map<string, Grounding>();

export function mintGrounding(opts: {
  source: GroundingSource;
  query?: string | null;
  product?: string | null;
  references?: Array<Record<string, unknown>>;
  reference?: string | null;
  observed_features?: string[];
  asset?: Record<string, unknown> | null;
}): Grounding {
  const groundingId = `grd_${Math.random().toString(16).slice(2, 10)}${Date.now().toString(16).slice(-4)}`;
  const record: Grounding = {
    grounding_id: groundingId,
    source: opts.source,
    query: opts.query ?? null,
    product: opts.product ?? null,
    references: opts.references ?? [],
    reference: opts.reference ?? null,
    observed_features: opts.observed_features ?? [],
    asset: opts.asset ?? null,
  };
  groundingRegistry.set(groundingId, record);
  return record;
}

/** Validate a grounding record. Returns the list of failed checks (empty = grounded). */
export function checkGrounding(grounding: unknown): string[] {
  if (grounding === null || grounding === undefined) {
    return [
      'no grounding: build refused. Call research_model first (or supply a reference image / retrieved asset / dimension-library product) and pass its grounding record to build_from_spec. Builds without research are refused — dimensions must come from somewhere real, never from a guess.',
    ];
  }
  if (typeof grounding !== 'object' || Array.isArray(grounding)) {
    return ['grounding must be a JSON object (the record returned by research_model)'];
  }
  const g = grounding as Record<string, unknown>;
  const source = g.source as string;
  if (!(GROUNDING_SOURCES as readonly string[]).includes(source)) {
    return [`grounding.source ${JSON.stringify(source)} is not one of ${GROUNDING_SOURCES.join(', ')}`];
  }
  if (source === 'research_model') {
    const gid = g.grounding_id as string;
    if (gid && groundingRegistry.has(gid)) return [];
    const refs = g.references;
    if (g.query && Array.isArray(refs) && refs.length >= 1) return [];
    return [
      'grounding is not a record this server issued (unknown grounding_id, no references). Call research_model again and use the grounding record it returns.',
    ];
  }
  if (source === 'reference_image') {
    const errors: string[] = [];
    if (!g.reference) errors.push("grounding.source is 'reference_image' but no 'reference' (path or URL) is given");
    const features = g.observed_features;
    if (!Array.isArray(features) || features.length === 0) {
      errors.push(
        "grounding.source is 'reference_image' but 'observed_features' is empty: list the features you actually observed in the image (part names) — the post-build check confirms each one exists in the model",
      );
    }
    return errors;
  }
  if (source === 'retrieved_asset') {
    const asset = g.asset as Record<string, unknown> | undefined;
    if (!asset || typeof asset !== 'object' || !(asset.gltf_path || asset.url)) {
      return ["grounding.source is 'retrieved_asset' but no asset gltf_path/url is given"];
    }
    return [];
  }
  if (source === 'dimension_library') {
    const product = String(g.product ?? '').toLowerCase().trim();
    if (!(product in DIMENSION_LIBRARY)) {
      return [
        `grounding.product ${JSON.stringify(product)} is not in the dimension library. Known products: ${Object.keys(DIMENSION_LIBRARY).sort().join(', ')}`,
      ];
    }
    return [];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Post-build verification — runs inside Blender against the saved .blend.
// ---------------------------------------------------------------------------

export interface VerifyCheck {
  check: string;
  passed: boolean;
  detail: string;
}

/** Blender script that checks the built scene against the spec and prints a VERIFY_JSON line. */
export function buildVerifyScript(specJson: string): string {
  return `
import bpy, json
from mathutils import Vector

_spec = json.loads(${JSON.stringify(specJson)})
_expected = {o.get("name"): o for o in _spec.get("objects", []) if o.get("name")}
_features = list((_spec.get("grounding") or {}).get("observed_features") or [])

bpy.context.view_layer.update()
meshes = [o for o in bpy.data.objects if o.type == 'MESH']
checks = []

def _bounds(o):
    corners = [o.matrix_world @ Vector(c) for c in o.bound_box]
    lo = Vector((min(c.x for c in corners), min(c.y for c in corners), min(c.z for c in corners)))
    hi = Vector((max(c.x for c in corners), max(c.y for c in corners), max(c.z for c in corners)))
    return lo, hi

_bounds_map = {}
for o in meshes:
    lo, hi = _bounds(o)
    _bounds_map[o.name] = (lo, hi)

# 1. Every expected spec part is present.
for name in _expected:
    found = any(name in o.name for o in meshes)
    checks.append({"check": f"part_present:{name}", "passed": found,
                   "detail": "present" if found else f"missing: no object named {name}"})

# 2. Part count vs spec (a build that drops or duplicates parts is a failure).
checks.append({"check": "part_count", "passed": len(meshes) == len(_expected) or not _expected,
               "detail": f"{len(meshes)} mesh objects vs {len(_expected)} spec parts"})

# 3. Nothing below the ground; nothing degenerate; every part has a material.
for o in meshes:
    lo, hi = _bounds_map[o.name]
    checks.append({"check": f"min_z:{o.name}", "passed": lo.z >= -0.001,
                   "detail": f"min z = {lo.z:.4f} m"})
    ext = (hi.x - lo.x, hi.y - lo.y, hi.z - lo.z)
    # Flat parts (converted label text, decal plates) legitimately have
    # zero volume — they are planes, not degenerate objects. Fail only a
    # part with no extent at all (a point).
    checks.append({"check": f"non_degenerate:{o.name}", "passed": max(ext) > 1e-6,
                   "detail": f"bbox extents = {[round(v, 4) for v in ext]} m"})
    mats = [m for m in o.data.materials if m is not None]
    checks.append({"check": f"has_material:{o.name}", "passed": len(mats) > 0,
                   "detail": ("material: " + ", ".join(m.name for m in mats)) if mats else "NO MATERIAL — part would render flat grey"})

# 4. Dimensions vs spec (when the spec gives sizes), within 10% (sorted compare).
for name, item in _expected.items():
    size = item.get("size_m")
    if not size:
        continue
    match = next((o for o in meshes if name in o.name), None)
    if not match:
        continue
    lo, hi = _bounds_map[match.name]
    actual = (hi.x - lo.x, hi.y - lo.y, hi.z - lo.z)
    actual_s = sorted(actual)
    size_s = sorted(size)
    ok = all(abs(actual_s[i] - size_s[i]) / max(size_s[i], 1e-6) < 0.10 for i in range(3))
    checks.append({"check": f"dimensions:{name}", "passed": ok,
                   "detail": f"spec={size} actual={[round(v, 3) for v in actual]} (sorted compare)"})

# 5. Connectivity / grounding: each part must touch the ground or touch
#    another part's bounding box (within 0.01 m).
def _touches(a_lo, a_hi, b_lo, b_hi, tol=0.01):
    overlap = [min(a_hi[i], b_hi[i]) - max(a_lo[i], b_lo[i]) for i in range(3)]
    return all(v >= -tol for v in overlap)

names = list(_bounds_map)
for i, name in enumerate(names):
    lo, hi = _bounds_map[name]
    grounded = lo.z <= 0.001
    connected = grounded
    if not connected:
        for j, other in enumerate(names):
            if i == j:
                continue
            o_lo, o_hi = _bounds_map[other]
            if _touches(lo, hi, o_lo, o_hi):
                connected = True
                break
    checks.append({"check": f"connected:{name}", "passed": connected,
                   "detail": "grounded" if grounded else ("touches another part" if connected else "FLOATING / DISCONNECTED: touches nothing and is not on the ground")})

# 6. Observed reference features must exist in the model (name match).
for feat in _features:
    found = any(feat.lower() in o.name.lower() for o in meshes)
    checks.append({"check": f"observed_feature:{feat}", "passed": found,
                   "detail": "present in the model" if found else f"missing: reference showed '{feat}' but the model has no such part"})

# 7. Scene min z (whole scene, not per part).
if meshes:
    scene_min_z = min(_bounds_map[n][0].z for n in names)
    checks.append({"check": "scene_min_z", "passed": scene_min_z >= -0.001,
                   "detail": f"scene min z = {scene_min_z:.4f} m"})

print("VERIFY_JSON:" + json.dumps({"checks": checks}))
`;
}

export function parseVerifyJson(stdout: string): { checks: VerifyCheck[] } | null {
  for (const line of (stdout || '').split('\n')) {
    if (line.startsWith('VERIFY_JSON:')) {
      try {
        return JSON.parse(line.slice('VERIFY_JSON:'.length)) as { checks: VerifyCheck[] };
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** Host-side verdict from a parsed VERIFY_JSON payload. A missing payload is itself a failure. */
export function verifyBuildReport(spec: unknown, verify: { checks: VerifyCheck[] } | null): { passed: boolean; checks: VerifyCheck[] } {
  if (!verify || !Array.isArray(verify.checks)) {
    return {
      passed: false,
      checks: [{ check: 'verification_ran', passed: false, detail: 'Blender ran but reported no verification checks — the build cannot be confirmed' }],
    };
  }
  return { passed: verify.checks.every((c) => c.passed), checks: verify.checks };
}

/**
 * Cross-check for `dimension_source == 'library'` parts: the part must
 * exist in the library for the spec's product and its size must match
 * within 10% (sorted compare). Returns the list of failed checks.
 */
export function specMatchesLibrary(spec: unknown): string[] {
  const errors: string[] = [];
  if (typeof spec !== 'object' || spec === null) return errors;
  const s = spec as Record<string, unknown>;
  const product = String(s.product ?? '').toLowerCase().trim();
  const objects = s.objects as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(objects)) return errors;
  for (const obj of objects) {
    if (typeof obj !== 'object' || obj === null) continue;
    if (obj.dimension_source !== 'library') continue;
    const name = String(obj.name ?? '?');
    if (!product) {
      errors.push(
        `${name}: dimension_source is 'library' but the spec names no 'product' — name the library product (get_dimensions lists them) so the numbers can be checked`,
      );
      continue;
    }
    const libSize = libraryPartSize(product, name);
    if (!libSize) {
      errors.push(
        `${name}: dimension_source is 'library' but '${name}' is not a part of '${product}' in the dimension library — use 'research' or 'measured' and cite the real source instead`,
      );
      continue;
    }
    const size = obj.size_m as unknown;
    if (!Array.isArray(size) || size.length !== 3 || !size.every((v) => typeof v === 'number' && Number.isFinite(v))) continue;
    const actual = [...(size as number[])].sort((a, b) => a - b);
    const expected = [...libSize].sort((a, b) => a - b);
    const ok = actual.every((v, i) => Math.abs(v - expected[i]) / Math.max(expected[i], 1e-6) < 0.1);
    if (!ok) {
      errors.push(
        `${name}: dimension_source is 'library' but size_m ${JSON.stringify(size)} does not match the library size ${JSON.stringify(libSize)} for '${product}' (within 10%) — copy the library numbers or change the source to 'research' with a citation`,
      );
    }
  }
  return errors;
}
