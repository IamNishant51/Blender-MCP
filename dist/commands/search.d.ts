/**
 * Search service for finding 3D models and textures online
 */
import type { SearchConfig } from '../config/index.js';
interface ModelResult {
    source: string;
    name: string;
    uid?: string;
    url: string;
    likes?: number;
    downloadable?: boolean;
    score: number;
}
interface SearchResults {
    query: string;
    timestamp: string;
    sources: Record<string, ModelResult[]>;
    all_results: ModelResult[];
}
interface TextureResult {
    source: string;
    name: string;
    url: string;
    score: number;
}
export declare class SearchService {
    private config;
    private logger;
    private cache;
    private cacheTTL;
    constructor(config: SearchConfig);
    private getCache;
    private setCache;
    searchModels(query: string): Promise<SearchResults>;
    private searchSketchfab;
    private searchGoogle;
    private searchPolyPizza;
    searchTextures(query: string): Promise<TextureResult[]>;
}
export {};
//# sourceMappingURL=search.d.ts.map