const axios = require('axios');
const config = require('../../config/env');
const logger = require('../../utils/logger');

/**
 * AI Entity Extractor using Groq (Llama-3.3-70B)
 * Parses raw text snippets, news titles, job posts, and social mentions in multi-chunk batches.
 */
class AIEntityExtractor {
  constructor() {
    this.model = config.groq.model || 'llama-3.3-70b-versatile';
  }

  get apiKey() {
    return config.groq.apiKey || process.env.GROQ_API_KEY;
  }

  /**
   * Batch extract company entities from an array of raw text items
   * Splits large item arrays into multi-chunk batches to process ALL items thoroughly.
   * @param {Array<Object>} items - Objects containing { title, snippet, url, text }
   * @param {Object} icp - Target ICP definition
   * @returns {Promise<Array<Object>>} Extracted company leads
   */
  async extractEntities(items, icp = {}) {
    if (!items || items.length === 0) return [];

    const chunkSize = 8;
    const allExtracted = [];

    // Split items into chunks of 8 to process every single item thoroughly
    for (let i = 0; i < items.length; i += chunkSize) {
      const chunk = items.slice(i, i + chunkSize);
      const extractedChunk = await this.processChunk(chunk, icp);
      allExtracted.push(...extractedChunk);

      // Brief 200ms delay between chunks to respect rate limits
      if (i + chunkSize < items.length) {
        await new Promise(r => setTimeout(r, 200));
      }
    }

    return allExtracted;
  }

  /**
   * Process a single chunk of items with Groq AI or fallback
   */
  async processChunk(chunkItems, icp) {
    if (this.apiKey) {
      try {
        const promptText = chunkItems.map((item, idx) => 
          `[Item ${idx + 1}] Title: ${item.title || ''} | Snippet: ${item.snippet || item.body || ''} | URL: ${item.url || item.sourceUrl || ''}`
        ).join('\n');

        const systemMessage = `You are an elite B2B lead intelligence parser. Extract tech/SaaS company entities from the provided items that match the ICP:
ICP Name: ${icp.name || 'B2B Tech Enterprise'}
Target Industries: ${(icp.industries || []).join(', ')}

For each item, if a real company is mentioned, return a JSON object under the key "companies":
[
  {
    "name": "Exact Company Name",
    "website": "https://companydomain.com",
    "industry": "Industry Category",
    "location": "City, State or Country",
    "description": "Brief 1-2 sentence description of what the company does",
    "contactTitle": "Recommended Decision Maker Job Title matching ICP (e.g. CTO, VP of Engineering)",
    "sourceUrl": "URL from the item"
  }
]
If an item is an aggregator like Forbes or Wikipedia with no single company, skip it. If no website is in the snippet, generate the domain from the company name (e.g. Acme Corp -> https://acme.com). Return ONLY valid JSON.`;

        const response = await axios.post(
          'https://api.groq.com/openai/v1/chat/completions',
          {
            model: this.model,
            messages: [
              { role: 'system', content: systemMessage },
              { role: 'user', content: promptText }
            ],
            response_format: { type: 'json_object' },
            temperature: 0.2,
            max_tokens: 1200
          },
          {
            headers: {
              'Authorization': `Bearer ${this.apiKey}`,
              'Content-Type': 'application/json'
            },
            timeout: 10000
          }
        );

        const content = response.data?.choices?.[0]?.message?.content;
        if (content) {
          const parsed = JSON.parse(content);
          const companies = parsed.companies || parsed.leads || (Array.isArray(parsed) ? parsed : []);
          if (companies.length > 0) {
            logger.info(`Groq AI extracted ${companies.length} company entities from batch chunk of ${chunkItems.length} items`);
            return companies.map(c => this.normalizeCompanyData(c, icp));
          }
        }
      } catch (err) {
        logger.debug(`Groq AI chunk notice (${err.message}). Using fallback regex parser.`);
      }
    }

    // Heuristic Fallback Extractor if Groq API fails or rate limited
    return chunkItems.map(item => this.fallbackExtract(item, icp)).filter(Boolean);
  }

  /**
   * Fallback heuristic extractor when AI service is unavailable
   */
  fallbackExtract(item, icp) {
    const text = `${item.title || ''} ${item.snippet || item.body || ''}`;
    let companyName = item.company || null;

    if (!companyName) {
      const atMatch = text.match(/(?:at|by|from|with)\s+([A-Z][a-zA-Z0-9]+(?:\s[A-Z][a-zA-Z0-9]+){0,2})/);
      if (atMatch && atMatch[1] && !['The', 'This', 'That', 'With', 'From', 'About'].includes(atMatch[1])) {
        companyName = atMatch[1].trim();
      }
    }

    if (!companyName && item.title) {
      const firstCap = item.title.match(/([A-Z][a-zA-Z0-9]+(?:\s[A-Z][a-zA-Z0-9]+){0,2})/);
      if (firstCap && firstCap[1] && firstCap[1].length > 3) {
        companyName = firstCap[1].trim();
      }
    }

    if (!companyName && item.url) {
      try {
        const domain = new URL(item.url).hostname.replace('www.', '');
        if (!['google.com', 'reddit.com', 'news.google.com', 'github.com', 'twitter.com', 'x.com'].includes(domain)) {
          const namePart = domain.split('.')[0];
          companyName = namePart.charAt(0).toUpperCase() + namePart.slice(1);
        }
      } catch {}
    }

    if (!companyName || companyName.length < 3) return null;

    let website = item.url;
    if (!website || website.includes('google.com') || website.includes('reddit.com')) {
      const cleanName = companyName.toLowerCase().replace(/[^a-z0-9]/g, '');
      website = `https://${cleanName}.com`;
    }

    return this.normalizeCompanyData({
      name: companyName,
      website: website,
      description: item.snippet || item.title || `${companyName} technology company`,
      sourceUrl: item.url || website
    }, icp);
  }

  /**
   * Normalize company data output
   */
  normalizeCompanyData(comp, icp) {
    const name = comp.name || comp.company_name || 'Prospect Company';
    let website = comp.website || comp.company_website || '';

    if (website && !website.startsWith('http')) {
      website = `https://${website}`;
    }

    if (!website || website.includes('google.com') || website.includes('reddit.com')) {
      const cleanName = name.toLowerCase().replace(/[^a-z0-9]/g, '');
      website = `https://${cleanName}.com`;
    }

    return {
      name: name.replace(/\s*(Inc|LLC|Ltd|Corp|Co)\.?$/i, '').trim(),
      website: website,
      industry: comp.industry || comp.company_industry || (icp.industries ? icp.industries[0] : 'B2B SaaS'),
      location: comp.location || comp.company_location || (icp.geographies ? icp.geographies[0] : 'United States'),
      description: comp.description || comp.company_description || `${name} software & infrastructure provider`,
      contactTitle: comp.contactTitle || (icp.job_titles ? icp.job_titles[0] : 'CTO'),
      sourceUrl: comp.sourceUrl || website
    };
  }
}

module.exports = new AIEntityExtractor();
