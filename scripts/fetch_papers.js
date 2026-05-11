#!/usr/bin/env node
/**
 * Fetch latest appearance anxiety / body image research papers from PubMed E-utilities API.
 * Targets appearance anxiety, BDD, body image, cosmetic procedure, and related topics.
 */

const https = require('https');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');

const PUBMED_SEARCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi';
const PUBMED_FETCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi';

const JOURNALS = [
  'Body Image',
  'J Am Acad Dermatol',
  'JAMA Dermatol',
  'Br J Dermatol',
  'Aesthet Surg J',
  'J Cosmet Dermatol',
  'Plast Reconstr Surg',
  'Dermatol Surg',
  'J Clin Psychol',
  'Clin Psychol Rev',
  'Psychol Med',
  'J Anxiety Disord',
  'Behav Res Ther',
  'Comput Hum Behav',
  'Cyberpsychol Behav Soc Netw',
  'Psychiatry Res',
  'BMC Psychiatry',
  'Front Psychiatry',
  'J Adolesc Health',
  'J Am Acad Child Adolesc Psychiatry',
  'Psychol Women Q',
  'Sex Roles',
  'Soc Sci Med',
  'Health Psychol',
  'Eat Behav',
  'Int J Eat Disord',
  'J Eat Disord',
  'Depress Anxiety',
  'Psychol Bull',
  'JAMA Psychiatry',
];

const TOPIC_QUERIES = [
  '"body dysmorphic disorder"[tiab] OR BDD[tiab] OR dysmorphophobia[tiab]',
  '"body image"[tiab] OR "body image disturbance"[tiab] OR "body image concern"[tiab]',
  '"body dissatisfaction"[tiab] OR "body image dissatisfaction"[tiab]',
  '"appearance anxiety"[tiab] OR "appearance concern"[tiab] OR "appearance concerns"[tiab]',
  '"appearance-related anxiety"[tiab] OR "fear of negative appearance evaluation"[tiab]',
  '"self-objectification"[tiab] OR "body surveillance"[tiab] OR "body shame"[tiab]',
  '"muscle dysmorphia"[tiab] OR "drive for muscularity"[tiab]',
  '"social media"[tiab] AND ("body image"[tiab] OR "body dissatisfaction"[tiab])',
  '"beauty filter"[tiab] OR "photo editing"[tiab] OR "selfie dysmorphia"[tiab]',
  '"cosmetic surgery"[tiab] OR "aesthetic surgery"[tiab] AND "body image"[tiab]',
  '"visible difference"[tiab] OR disfigurement[tiab] OR "facial difference"[tiab]',
];

const HEADERS = { 'User-Agent': 'AppearanceAnxietyBot/1.0 (research aggregator)' };

function fetchUrl(urlStr, timeout = 30000) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'GET',
      headers: HEADERS,
      timeout,
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.setEncoding('utf-8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.end();
  });
}

async function searchPapers(query, retmax = 20) {
  const params = new URLSearchParams({
    db: 'pubmed',
    term: query,
    retmax: String(retmax),
    sort: 'date',
    retmode: 'json',
  });
  const url = `${PUBMED_SEARCH}?${params}`;
  try {
    const raw = await fetchUrl(url);
    const data = JSON.parse(raw);
    return data?.esearchresult?.idlist || [];
  } catch (e) {
    console.error(`[ERROR] PubMed search failed: ${e.message}`);
    return [];
  }
}

async function fetchDetails(pmids) {
  if (!pmids.length) return [];
  const params = new URLSearchParams({
    db: 'pubmed',
    id: pmids.join(','),
    retmode: 'xml',
  });
  const url = `${PUBMED_FETCH}?${params}`;
  try {
    const xml = await fetchUrl(url, 60000);
    return parseXml(xml);
  } catch (e) {
    console.error(`[ERROR] PubMed fetch failed: ${e.message}`);
    return [];
  }
}

function parseXml(xmlData) {
  const papers = [];
  const articleRegex = /<PubmedArticle>([\s\S]*?)<\/PubmedArticle>/g;
  let match;
  while ((match = articleRegex.exec(xmlData)) !== null) {
    const block = match[1];
    const titleMatch = block.match(/<ArticleTitle>([\s\S]*?)<\/ArticleTitle>/);
    let title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : '';

    const abstractParts = [];
    const abstractRegex = /<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g;
    let absMatch;
    while ((absMatch = abstractRegex.exec(block)) !== null) {
      const labelMatch = absMatch[0].match(/Label="([^"]+)"/);
      const label = labelMatch ? labelMatch[1] : '';
      const text = absMatch[1].replace(/<[^>]+>/g, '').trim();
      if (text) {
        abstractParts.push(label ? `${label}: ${text}` : text);
      }
    }
    const abstract = abstractParts.join(' ').substring(0, 2000);

    const journalMatch = block.match(/<Title>([\s\S]*?)<\/Title>/);
    const journal = journalMatch ? journalMatch[1].trim() : '';

    const yearMatch = block.match(/<Year>(\d{4})<\/Year>/);
    const monthMatch = block.match(/<Month>([^<]+)<\/Month>/);
    const dayMatch = block.match(/<Day>(\d+)<\/Day>/);
    const dateParts = [yearMatch?.[1], monthMatch?.[1], dayMatch?.[1]].filter(Boolean);
    const dateStr = dateParts.join(' ');

    const pmidMatch = block.match(/<PMID[^>]*>(\d+)<\/PMID>/);
    const pmid = pmidMatch ? pmidMatch[1] : '';
    const link = pmid ? `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` : '';

    const keywords = [];
    const kwRegex = /<Keyword>([\s\S]*?)<\/Keyword>/g;
    let kwMatch;
    while ((kwMatch = kwRegex.exec(block)) !== null) {
      keywords.push(kwMatch[1].trim());
    }

    if (title) {
      papers.push({ pmid, title, journal, date: dateStr, abstract, url: link, keywords });
    }
  }
  return papers;
}

function buildQuery(days) {
  const now = new Date();
  const lookback = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const dateStr = `${lookback.getFullYear()}/${String(lookback.getMonth() + 1).padStart(2, '0')}/${String(lookback.getDate()).padStart(2, '0')}`;
  const datePart = `"${dateStr}"[Date - Publication] : "3000"[Date - Publication]`;

  const topicPart = `(${TOPIC_QUERIES.join(' OR ')})`;

  return `(${topicPart}) AND ${datePart}`;
}

async function main() {
  const args = process.argv.slice(2);
  let days = 7;
  let maxPapers = 40;
  let outputFile = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days' && args[i + 1]) { days = parseInt(args[i + 1], 10); i++; }
    else if (args[i] === '--max-papers' && args[i + 1]) { maxPapers = parseInt(args[i + 1], 10); i++; }
    else if (args[i] === '--output' && args[i + 1]) { outputFile = args[i + 1]; i++; }
  }

  const query = buildQuery(days);
  console.error(`[INFO] Searching PubMed for appearance anxiety papers from last ${days} days...`);

  const pmids = await searchPapers(query, maxPapers);
  console.error(`[INFO] Found ${pmids.length} papers`);

  if (!pmids.length) {
    const tzOffset = 8 * 60 * 60 * 1000;
    const taipeiDate = new Date(Date.now() + tzOffset).toISOString().split('T')[0];
    const emptyResult = { date: taipeiDate, count: 0, papers: [] };
    const json = JSON.stringify(emptyResult, null, 2);
    if (outputFile && outputFile !== '-') {
      fs.writeFileSync(outputFile, json, 'utf-8');
    } else {
      console.log(json);
    }
    return;
  }

  const uniquePmids = [...new Set(pmids)];
  const papers = await fetchDetails(uniquePmids);
  console.error(`[INFO] Fetched details for ${papers.length} papers`);

  const tzOffset = 8 * 60 * 60 * 1000;
  const taipeiDate = new Date(Date.now() + tzOffset).toISOString().split('T')[0];
  const result = { date: taipeiDate, count: papers.length, papers };
  const json = JSON.stringify(result, null, 2);

  if (outputFile && outputFile !== '-') {
    fs.writeFileSync(outputFile, json, 'utf-8');
    console.error(`[INFO] Saved to ${outputFile}`);
  } else {
    console.log(json);
  }
}

main().catch((e) => {
  console.error(`[FATAL] ${e.message}`);
  process.exit(1);
});
