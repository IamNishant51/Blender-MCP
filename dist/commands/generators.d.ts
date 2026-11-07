/**
 * Model script generators - Python scripts for Blender
 *
 * Conventions (v1.1.0): Blender is Z-up. Z is height, ground is z = 0.
 * All dimensions are in metres and every part's lowest point is at z >= 0.
 * The five templates below are the only built-in models; anything else must
 * go through `execute_blender_code` (see src/index.ts) — there is deliberately
 * no default template.
 */
export declare function generateTempleScript(custom?: string): string;
export declare function generateRickshawScript(custom?: string): string;
export declare function generateThaliScript(_custom?: string): string;
export declare function generateBuildingScript(_custom?: string): string;
export declare function generateCharacterScript(_custom?: string): string;
export type TemplateName = 'temple' | 'rickshaw' | 'thali' | 'building' | 'character';
/** Which built-in template (if any) matches a description. Returns null for no match. */
export declare function matchTemplate(description: string): TemplateName | null;
export declare function generateModelScript(description: string, customization: string): string;
//# sourceMappingURL=generators.d.ts.map