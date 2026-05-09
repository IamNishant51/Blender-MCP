/**
 * Search service for finding 3D models and textures online
 */

import { createLogger } from '../utils/logger.js';
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

export class SearchService {
  private config: SearchConfig;
  private logger = createLogger('search');
  private cache: Map<string, { data: SearchResults | TextureResult[]; timestamp: number }> = new Map();
  private cacheTTL = 5 * 60 * 1000; // 5 minutes

  constructor(config: SearchConfig) {
    this.config = config;
  }

  private getCache<T>(key: string): T | null {
    const cached = this.cache.get(key) as { data: T; timestamp: number } | undefined;
    if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
      return cached.data;
    }
    this.cache.delete(key);
    return null;
  }

  private setCache(key: string, data: SearchResults | TextureResult[]): void {
    this.cache.set(key, { data, timestamp: Date.now() });
  }

  async searchModels(query: string): Promise<SearchResults> {
    this.logger.info(`Searching for models: ${query}`);

    const cacheKey = `models:${query}`;
    const cached = this.getCache<SearchResults>(cacheKey);
    if (cached) {
      this.logger.debug('Using cached search results');
      return cached;
    }

    const results: SearchResults = {
      query,
      timestamp: new Date().toISOString(),
      sources: {},
      all_results: [],
    };

    // Search all sources
    results.sources.sketchfab = await this.searchSketchfab(query);
    results.sources.google = await this.searchGoogle(query);
    results.sources.databases = await this.searchPolyPizza(query);

    // Combine and sort results
    for (const source of Object.values(results.sources)) {
      results.all_results.push(...source);
    }

    results.all_results.sort((a, b) => b.score - a.score);

    this.setCache(cacheKey, results);
    this.logger.info(`Found ${results.all_results.length} models`);

    return results;
  }

  private async searchSketchfab(query: string): Promise<ModelResult[]> {
    const url = `https://api.sketchfab.com/v3/search?type=models&q=${encodeURIComponent(query)}&downloadable=true&sort_by=-likeCount&count=${this.config.sketchfabLimit}`;

    try {
      const response = await fetch(url, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(this.config.timeout * 1000),
      });

      if (!response.ok) return [];

      const data = await response.json() as { results: Array<{ name: string; uid: string; likeCount: number; isDownloadable: boolean }> };
      return data.results?.map((item) => ({
        source: 'sketchfab',
        name: item.name,
        uid: item.uid,
        url: `https://sketchfab.com/3d-models/${(item.name || 'model').replace(/ /g, '-')}-${item.uid}`,
        likes: item.likeCount,
        downloadable: item.isDownloadable,
        score: item.likeCount || 0,
      })) || [];
    } catch (error) {
      this.logger.warn(`Sketchfab search failed: ${error}`);
      return [];
    }
  }

  private async searchGoogle(query: string): Promise<ModelResult[]> {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}+3d+model+download+free+glb+site:thingiverse.com`;
    const results: ModelResult[] = [];

    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(this.config.timeout * 1000),
      });

      if (!response.ok) return [];

      const html = await response.text();
      const matches = html.matchAll(/href="(https:\/\/thingiverse\.com\/thing:[0-9][^"]*)"/g);
      const urls = new Set<string>();

      for (const match of matches) {
        urls.add(match[1]);
        if (urls.size >= this.config.googleLimit) break;
      }

      for (const url of urls) {
        results.push({
          source: 'thingiverse',
          name: `${query} Model`,
          url,
          score: 50,
        });
      }
    } catch (error) {
      this.logger.warn(`Google search failed: ${error}`);
    }

    return results;
  }

  private async searchPolyPizza(query: string): Promise<ModelResult[]> {
    const url = `https://poly.pizza/api/search?q=${encodeURIComponent(query)}&limit=${this.config.polyPizzaLimit}`;
    const results: ModelResult[] = [];

    try {
      const response = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(this.config.timeout * 1000),
      });

      if (!response.ok) return [];

      const data = await response.json() as { data: Array<{ name: string; slug: string }> };
      for (const item of data.data || []) {
        results.push({
          source: 'poly_pizza',
          name: item.name || 'Model',
          url: `https://poly.pizza/model/${item.slug || ''}`,
          score: 40,
        });
      }
    } catch (error) {
      this.logger.warn(`Poly Pizza search failed: ${error}`);
    }

    return results;
  }

  async searchTextures(query: string): Promise<TextureResult[]> {
    this.logger.info(`Searching for textures: ${query}`);

    const cacheKey = `textures:${query}`;
    const cached = this.getCache<TextureResult[]>(cacheKey);
    if (cached) {
      return cached;
    }

    const results: TextureResult[] = [];

    // Try Poly Haven
    try {
      const url = `https://api.polyhaven.com/assets?t=textures&s=${encodeURIComponent(query)}`;
      const response = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(this.config.timeout * 1000),
      });

      if (response.ok) {
        const data = await response.json() as Record<string, unknown>;
        const names = Object.keys(data).slice(0, 5);
        for (const name of names) {
          results.push({
            source: 'poly_haven',
            name,
            url: `https://polyhaven.com/textures/${name}`,
            score: 80,
          });
        }
      }
    } catch (error) {
      this.logger.warn(`Poly Haven search failed: ${error}`);
    }

    this.setCache(cacheKey, results);
    return results;
  }
}