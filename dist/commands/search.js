/**
 * Search service for finding 3D models and textures online
 */
import { createLogger } from '../utils/logger.js';
export class SearchService {
    config;
    logger = createLogger('search');
    cache = new Map();
    cacheTTL = 5 * 60 * 1000; // 5 minutes
    constructor(config) {
        this.config = config;
    }
    getCache(key) {
        const cached = this.cache.get(key);
        if (cached && Date.now() - cached.timestamp < this.cacheTTL) {
            return cached.data;
        }
        this.cache.delete(key);
        return null;
    }
    setCache(key, data) {
        this.cache.set(key, { data, timestamp: Date.now() });
    }
    async searchModels(query) {
        this.logger.info(`Searching for models: ${query}`);
        const cacheKey = `models:${query}`;
        const cached = this.getCache(cacheKey);
        if (cached) {
            this.logger.debug('Using cached search results');
            return cached;
        }
        const results = {
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
    async searchSketchfab(query) {
        const url = `https://api.sketchfab.com/v3/search?type=models&q=${encodeURIComponent(query)}&downloadable=true&sort_by=-likeCount&count=${this.config.sketchfabLimit}`;
        try {
            const response = await fetch(url, {
                headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
                signal: AbortSignal.timeout(this.config.timeout * 1000),
            });
            if (!response.ok)
                return [];
            const data = await response.json();
            return data.results?.map((item) => ({
                source: 'sketchfab',
                name: item.name,
                uid: item.uid,
                url: `https://sketchfab.com/3d-models/${(item.name || 'model').replace(/ /g, '-')}-${item.uid}`,
                likes: item.likeCount,
                downloadable: item.isDownloadable,
                score: item.likeCount || 0,
            })) || [];
        }
        catch (error) {
            this.logger.warn(`Sketchfab search failed: ${error}`);
            return [];
        }
    }
    async searchGoogle(query) {
        const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}+3d+model+download+free+glb+site:thingiverse.com`;
        const results = [];
        try {
            const response = await fetch(url, {
                headers: { 'User-Agent': 'Mozilla/5.0' },
                signal: AbortSignal.timeout(this.config.timeout * 1000),
            });
            if (!response.ok)
                return [];
            const html = await response.text();
            const matches = html.matchAll(/href="(https:\/\/thingiverse\.com\/thing:[0-9][^"]*)"/g);
            const urls = new Set();
            for (const match of matches) {
                urls.add(match[1]);
                if (urls.size >= this.config.googleLimit)
                    break;
            }
            for (const url of urls) {
                results.push({
                    source: 'thingiverse',
                    name: `${query} Model`,
                    url,
                    score: 50,
                });
            }
        }
        catch (error) {
            this.logger.warn(`Google search failed: ${error}`);
        }
        return results;
    }
    async searchPolyPizza(query) {
        const url = `https://poly.pizza/api/search?q=${encodeURIComponent(query)}&limit=${this.config.polyPizzaLimit}`;
        const results = [];
        try {
            const response = await fetch(url, {
                headers: { 'Accept': 'application/json' },
                signal: AbortSignal.timeout(this.config.timeout * 1000),
            });
            if (!response.ok)
                return [];
            const data = await response.json();
            for (const item of data.data || []) {
                results.push({
                    source: 'poly_pizza',
                    name: item.name || 'Model',
                    url: `https://poly.pizza/model/${item.slug || ''}`,
                    score: 40,
                });
            }
        }
        catch (error) {
            this.logger.warn(`Poly Pizza search failed: ${error}`);
        }
        return results;
    }
    async searchTextures(query) {
        this.logger.info(`Searching for textures: ${query}`);
        const cacheKey = `textures:${query}`;
        const cached = this.getCache(cacheKey);
        if (cached) {
            return cached;
        }
        const results = [];
        // Try Poly Haven
        try {
            const url = `https://api.polyhaven.com/assets?t=textures&s=${encodeURIComponent(query)}`;
            const response = await fetch(url, {
                headers: { 'User-Agent': 'Mozilla/5.0' },
                signal: AbortSignal.timeout(this.config.timeout * 1000),
            });
            if (response.ok) {
                const data = await response.json();
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
        }
        catch (error) {
            this.logger.warn(`Poly Haven search failed: ${error}`);
        }
        this.setCache(cacheKey, results);
        return results;
    }
}
//# sourceMappingURL=search.js.map