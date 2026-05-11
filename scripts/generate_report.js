#!/usr/bin/env node
/**
 * Generate appearance anxiety daily report HTML using Zhipu AI.
 * Reads papers JSON, analyzes with AI, generates styled HTML.
 *
 * AI Model: GLM-5-Turbo (fallback: GLM-5-Turbo -> GLM-4.7 -> GLM-4.7-Flash)
 * Token limit: 50000, Timeout: 480s
 * Enhanced JSON error handling with multiple repair attempts
 */

const https = require('https');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const API_BASE = process.env.ZHIPU_API_BASE || 'https://open.bigmodel.cn/api/coding/paas/v4';
const MODELS = ['GLM-5-Turbo', 'GLM-4.7', 'GLM-4.7-Flash'];
const MAX_TOKENS = 50000;
const TIMEOUT = 480000;

const SYSTEM_PROMPT = `你是精神醫學與心理學的深度研究員及科學傳播者。你的任務是：
1. 從提供的學術文獻中，篩選出最具臨床意義和研究價值的論文
2. 對每篇論文進行繁體中文（台灣用語）摘要、分類、PICO 分析
3. 評估其臨床實用性（高/中/低）
4. 生成適合專業人員的每日文獻日報

輸出格式要求：
- 語言：繁體中文（台灣用語）
- 專業但通俗易懂
- 每篇論文包含：中文標題、一句話摘要、PICO分析、臨床實用性、分類標籤
- 最後提供「精選 TOP 3」（研究影響力/實用性/創新度）
- 回傳格式必須是 JSON，不要用 markdown code block 包裹`;

function loadPapers(inputPath) {
  if (inputPath === '-') {
    return JSON.parse(fs.readFileSync(0, 'utf-8'));
  }
  return JSON.parse(fs.readFileSync(inputPath, 'utf-8'));
}

function repairJson(text) {
  let repaired = text.trim();
  if (repaired.startsWith('```')) {
    const firstNewline = repaired.indexOf('\n');
    repaired = repaired.substring(firstNewline + 1);
    repaired = repaired.replace(/```+\s*$/, '');
    repaired = repaired.trim();
  }
  repaired = repaired.replace(/,\s*([}\]])/g, '$1');
  repaired = repaired.replace(/'/g, '"');
  const openBraces = (repaired.match(/{/g) || []).length;
  const closeBraces = (repaired.match(/}/g) || []).length;
  if (openBraces > closeBraces) {
    repaired += '}'.repeat(openBraces - closeBraces);
  }
  const openBrackets = (repaired.match(/\[/g) || []).length;
  const closeBrackets = (repaired.match(/]/g) || []).length;
  if (openBrackets > closeBrackets) {
    repaired += ']'.repeat(openBrackets - closeBrackets);
  }
  return repaired;
}

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch (_) {}
  const attempts = [
    (t) => repairJson(t),
    (t) => {
      const start = t.indexOf('{');
      const end = t.lastIndexOf('}');
      return start >= 0 && end > start ? t.substring(start, end + 1) : t;
    },
    (t) => {
      let s = repairJson(t);
      s = s.replace(/"url":\s*"([^"]*)"([^",}\]]*)"([^"]*)"/g, (_, a, b, c) => {
        return `"url": "${a}${b.replace(/"/g, '\\"')}${c}"`;
      });
      return s;
    },
  ];
  for (const fn of attempts) {
    try {
      return JSON.parse(fn(text));
    } catch (_) {}
  }
  return null;
}

function buildPrompt(papersData) {
  const tzOffset = 8 * 60 * 60 * 1000;
  const dateStr = papersData.date || new Date(Date.now() + tzOffset).toISOString().split('T')[0];
  const paperCount = papersData.count || 0;
  const papersText = JSON.stringify(papersData.papers || [], null, 2);

  return `以下是 ${dateStr} 從 PubMed 取得的容貌焦慮/身體意象相關研究文獻 ${paperCount} 篇。
請進行以下分析，並以 JSON 格式回傳（不要用 markdown code block）：

{
  "date": "${dateStr}",
  "market_summary": "1-2句話總結今天文獻的整體趨勢和亮點",
  "top_picks": [
    {
      "rank": 1,
      "title_zh": "中文標題",
      "title_en": "English Title",
      "journal": "期刊名稱",
      "summary": "一句話總結（繁體中文，點出重要發現和臨床意義）",
      "pico": {
        "population": "研究對象",
        "intervention": "介入措施",
        "comparison": "對照組",
        "outcome": "主要結局"
      },
      "clinical_utility": "高/中/低",
      "utility_reason": "為什麼實用，一句話說明",
      "tags": ["標籤1", "標籤2"],
      "url": "論文連結",
      "emoji": "合適的emoji"
    }
  ],
  "all_papers": [
    {
      "title_zh": "中文標題",
      "title_en": "English Title",
      "journal": "期刊名稱",
      "summary": "一句話總結",
      "clinical_utility": "高/中/低",
      "tags": ["標籤1"],
      "url": "連結",
      "emoji": "emoji"
    }
  ],
  "keywords": ["關鍵詞1", "關鍵詞2"],
  "topic_distribution": {
    "身體意象": 3,
    "容貌焦慮": 2
  }
}

文獻資料如下：
${papersText}

請篩選出最重要的 TOP 5-8 篇放入 top_picks（按重要性排序），其餘放入 all_papers。每篇 paper 的 tags 請從以下分類中選取：身體意象、身體畸形恐懼症(BDD)、容貌焦慮、社交焦慮、社交媒體、美容醫學、皮膚科學、飲食障礙、肌肉畸形、神經科學、認知行為治療、兒少心理學、性別研究、社會學、可見差異/毀容、測量工具、公共衛生。記住：回傳純 JSON，不要用 \`\`\`json\`\`\` 包裹。`;
}

function callApi(apiKey, payload) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${API_BASE}/chat/completions`);
    const body = JSON.stringify(payload);
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: TIMEOUT,
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.setEncoding('utf-8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 429) {
          reject({ status: 429, body: data });
          return;
        }
        if (res.statusCode >= 400) {
          reject({ status: res.statusCode, body: data.substring(0, 500) });
          return;
        }
        try {
          const parsed = JSON.parse(data);
          resolve(parsed);
        } catch (e) {
          reject({ status: 0, body: `JSON parse error: ${e.message}` });
        }
      });
    });
    req.on('error', (e) => reject({ status: 0, body: e.message }));
    req.on('timeout', () => { req.destroy(); reject({ status: 0, body: 'Request timeout' }); });
    req.write(body);
    req.end();
  });
}

async function analyzePapers(apiKey, papersData) {
  const prompt = buildPrompt(papersData);
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ];

  for (const model of MODELS) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        console.error(`[INFO] Trying ${model} (attempt ${attempt + 1})...`);
        const payload = {
          model,
          messages,
          temperature: 0.3,
          top_p: 0.9,
          max_tokens: MAX_TOKENS,
        };
        const data = await callApi(apiKey, payload);
        const text = data.choices?.[0]?.message?.content?.trim();
        if (!text) {
          console.error(`[WARN] Empty response from ${model}`);
          continue;
        }
        const result = safeJsonParse(text);
        if (!result) {
          console.error(`[WARN] JSON parse failed on attempt ${attempt + 1}`);
          if (attempt < 2) await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        console.error(`[INFO] Analysis complete: ${(result.top_picks || []).length} top picks, ${(result.all_papers || []).length} total`);
        return result;
      } catch (err) {
        if (err.status === 429) {
          const wait = 60000 * (attempt + 1);
          console.error(`[WARN] Rate limited, waiting ${wait / 1000}s...`);
          await new Promise((r) => setTimeout(r, wait));
          continue;
        }
        console.error(`[ERROR] ${model} failed: ${err.body || err.message}`);
        break;
      }
    }
  }

  console.error('[ERROR] All models and attempts failed');
  return null;
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function generateHtml(analysis) {
  const tzOffset = 8 * 60 * 60 * 1000;
  const dateStr = analysis.date || new Date(Date.now() + tzOffset).toISOString().split('T')[0];
  const parts = dateStr.split('-');
  const dateDisplay = parts.length === 3
    ? `${parts[0]}年${parseInt(parts[1])}月${parseInt(parts[2])}日`
    : dateStr;

  const summary = escapeHtml(analysis.market_summary || '');
  const topPicks = analysis.top_picks || [];
  const allPapers = analysis.all_papers || [];
  const keywords = analysis.keywords || [];
  const topicDist = analysis.topic_distribution || {};
  const total = topPicks.length + allPapers.length;

  let topPicksHtml = '';
  for (const pick of topPicks) {
    const tags = (pick.tags || []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('');
    const util = pick.clinical_utility || '中';
    const utilityClass = util === '高' ? 'utility-high' : util === '中' ? 'utility-mid' : 'utility-low';
    const pico = pick.pico || {};
    let picoHtml = '';
    if (pico.population || pico.intervention || pico.comparison || pico.outcome) {
      picoHtml = `
            <div class="pico-grid">
              <div class="pico-item"><span class="pico-label">P</span><span class="pico-text">${escapeHtml(pico.population || '-')}</span></div>
              <div class="pico-item"><span class="pico-label">I</span><span class="pico-text">${escapeHtml(pico.intervention || '-')}</span></div>
              <div class="pico-item"><span class="pico-label">C</span><span class="pico-text">${escapeHtml(pico.comparison || '-')}</span></div>
              <div class="pico-item"><span class="pico-label">O</span><span class="pico-text">${escapeHtml(pico.outcome || '-')}</span></div>
            </div>`;
    }
    topPicksHtml += `
        <div class="news-card featured">
          <div class="card-header">
            <span class="rank-badge">#${pick.rank || ''}</span>
            <span class="emoji-icon">${pick.emoji || '&#128196;'}</span>
            <span class="${utilityClass}">${escapeHtml(util)}實用性</span>
          </div>
          <h3>${escapeHtml(pick.title_zh || pick.title_en || '')}</h3>
          <p class="journal-source">${escapeHtml(pick.journal || '')} &middot; ${escapeHtml(pick.title_en || '')}</p>
          <p>${escapeHtml(pick.summary || '')}</p>
          ${picoHtml}
          <div class="card-footer">
            ${tags}
            <a href="${escapeHtml(pick.url || '#')}" target="_blank" rel="noopener">閱讀原文 &rarr;</a>
          </div>
        </div>`;
  }

  let allPapersHtml = '';
  for (const paper of allPapers) {
    const tags = (paper.tags || []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('');
    const util = paper.clinical_utility || '中';
    const utilityClass = util === '高' ? 'utility-high' : util === '中' ? 'utility-mid' : 'utility-low';
    allPapersHtml += `
        <div class="news-card">
          <div class="card-header-row">
            <span class="emoji-sm">${paper.emoji || '&#128196;'}</span>
            <span class="${utilityClass} utility-sm">${escapeHtml(util)}</span>
          </div>
          <h3>${escapeHtml(paper.title_zh || paper.title_en || '')}</h3>
          <p class="journal-source">${escapeHtml(paper.journal || '')}</p>
          <p>${escapeHtml(paper.summary || '')}</p>
          <div class="card-footer">
            ${tags}
            <a href="${escapeHtml(paper.url || '#')}" target="_blank" rel="noopener">PubMed &rarr;</a>
          </div>
        </div>`;
  }

  const keywordsHtml = keywords.map((k) => `<span class="keyword">${escapeHtml(k)}</span>`).join('');
  let topicBarsHtml = '';
  if (Object.keys(topicDist).length > 0) {
    const maxCount = Math.max(...Object.values(topicDist), 1);
    for (const [topic, count] of Object.entries(topicDist)) {
      const widthPct = Math.round((count / maxCount) * 100);
      topicBarsHtml += `
            <div class="topic-row">
              <span class="topic-name">${escapeHtml(topic)}</span>
              <div class="topic-bar-bg"><div class="topic-bar" style="width:${widthPct}%"></div></div>
              <span class="topic-count">${count}</span>
            </div>`;
    }
  }

  const modelUsed = MODELS[0];

  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Appearance Anxiety &middot; 容貌焦慮研究文獻日報 &middot; ${dateDisplay}</title>
<meta name="description" content="${dateDisplay} 容貌焦慮研究文獻日報，由 AI 自動彙整 PubMed 最新論文"/>
<style>
  :root { --bg: #f6f1e8; --surface: #fffaf2; --line: #d8c5ab; --text: #2b2118; --muted: #766453; --accent: #8c4f2b; --accent-soft: #ead2bf; --card-bg: color-mix(in srgb, var(--surface) 92%, white); }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: radial-gradient(circle at top, #fff6ea 0, var(--bg) 55%, #ead8c6 100%); color: var(--text); font-family: "Noto Sans TC", "PingFang TC", "Helvetica Neue", Arial, sans-serif; min-height: 100vh; overflow-x: hidden; }
  .container { position: relative; z-index: 1; max-width: 880px; margin: 0 auto; padding: 60px 32px 80px; }
  header { display: flex; align-items: center; gap: 16px; margin-bottom: 52px; animation: fadeDown 0.6s ease both; }
  .logo { width: 48px; height: 48px; border-radius: 14px; background: var(--accent); display: flex; align-items: center; justify-content: center; font-size: 22px; flex-shrink: 0; box-shadow: 0 4px 20px rgba(140,79,43,0.25); }
  .header-text h1 { font-size: 22px; font-weight: 700; color: var(--text); letter-spacing: -0.3px; }
  .header-meta { display: flex; gap: 8px; margin-top: 6px; flex-wrap: wrap; align-items: center; }
  .badge { display: inline-block; padding: 3px 10px; border-radius: 20px; font-size: 11px; letter-spacing: 0.3px; }
  .badge-date { background: var(--accent-soft); border: 1px solid var(--line); color: var(--accent); }
  .badge-count { background: rgba(140,79,43,0.06); border: 1px solid var(--line); color: var(--muted); }
  .badge-source { background: transparent; color: var(--muted); font-size: 11px; padding: 0 4px; }
  .summary-card { background: var(--card-bg); border: 1px solid var(--line); border-radius: 24px; padding: 28px 32px; margin-bottom: 32px; box-shadow: 0 20px 60px rgba(61,36,15,0.06); animation: fadeUp 0.5s ease 0.1s both; }
  .summary-card h2 { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 1.6px; color: var(--accent); margin-bottom: 16px; }
  .summary-text { font-size: 15px; line-height: 1.8; color: var(--text); }
  .section { margin-bottom: 36px; animation: fadeUp 0.5s ease both; }
  .section-title { display: flex; align-items: center; gap: 10px; font-size: 17px; font-weight: 700; color: var(--text); margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid var(--line); }
  .section-icon { width: 28px; height: 28px; border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 14px; flex-shrink: 0; background: var(--accent-soft); }
  .news-card { background: var(--card-bg); border: 1px solid var(--line); border-radius: 24px; padding: 22px 26px; margin-bottom: 12px; box-shadow: 0 8px 30px rgba(61,36,15,0.04); transition: background 0.2s, border-color 0.2s, transform 0.2s; }
  .news-card:hover { transform: translateY(-2px); box-shadow: 0 12px 40px rgba(61,36,15,0.08); }
  .news-card.featured { border-left: 3px solid var(--accent); }
  .news-card.featured:hover { border-color: var(--accent); }
  .card-header { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
  .rank-badge { background: var(--accent); color: #fff7f0; font-weight: 700; font-size: 12px; padding: 2px 8px; border-radius: 6px; }
  .emoji-icon { font-size: 18px; }
  .card-header-row { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
  .emoji-sm { font-size: 14px; }
  .news-card h3 { font-size: 15px; font-weight: 600; color: var(--text); margin-bottom: 8px; line-height: 1.5; }
  .journal-source { font-size: 12px; color: var(--accent); margin-bottom: 8px; opacity: 0.8; }
  .news-card p { font-size: 13.5px; line-height: 1.75; color: var(--muted); }
  .card-footer { margin-top: 12px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .tag { padding: 2px 9px; background: var(--accent-soft); border-radius: 999px; font-size: 11px; color: var(--accent); }
  .news-card a { font-size: 12px; color: var(--accent); text-decoration: none; opacity: 0.7; margin-left: auto; }
  .news-card a:hover { opacity: 1; }
  .utility-high { color: #5a7a3a; font-size: 11px; font-weight: 600; padding: 2px 8px; background: rgba(90,122,58,0.1); border-radius: 4px; }
  .utility-mid { color: #9f7a2e; font-size: 11px; font-weight: 600; padding: 2px 8px; background: rgba(159,122,46,0.1); border-radius: 4px; }
  .utility-low { color: var(--muted); font-size: 11px; font-weight: 600; padding: 2px 8px; background: rgba(118,100,83,0.08); border-radius: 4px; }
  .utility-sm { font-size: 10px; }
  .pico-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-top: 12px; padding: 12px; background: rgba(255,253,249,0.8); border-radius: 14px; border: 1px solid var(--line); }
  .pico-item { display: flex; gap: 8px; align-items: baseline; }
  .pico-label { font-size: 10px; font-weight: 700; color: #fff7f0; background: var(--accent); padding: 2px 6px; border-radius: 4px; flex-shrink: 0; }
  .pico-text { font-size: 12px; color: var(--muted); line-height: 1.4; }
  .keywords-section { margin-bottom: 36px; }
  .keywords { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
  .keyword { padding: 5px 14px; background: var(--accent-soft); border: 1px solid var(--line); border-radius: 20px; font-size: 12px; color: var(--accent); cursor: default; transition: background 0.2s; }
  .keyword:hover { background: rgba(140,79,43,0.18); }
  .topic-section { margin-bottom: 36px; }
  .topic-row { display: flex; align-items: center; gap: 10px; margin-bottom: 8px; }
  .topic-name { font-size: 13px; color: var(--muted); width: 100px; flex-shrink: 0; text-align: right; }
  .topic-bar-bg { flex: 1; height: 8px; background: var(--line); border-radius: 4px; overflow: hidden; }
  .topic-bar { height: 100%; background: linear-gradient(90deg, var(--accent), #c47a4a); border-radius: 4px; transition: width 0.6s ease; }
  .topic-count { font-size: 12px; color: var(--accent); width: 24px; }
  .banner-section { margin-top: 36px; animation: fadeUp 0.5s ease 0.4s both; }
  .banner-link { display: flex; align-items: center; gap: 14px; padding: 18px 24px; background: var(--card-bg); border: 1px solid var(--line); border-radius: 24px; text-decoration: none; color: var(--text); transition: all 0.2s; box-shadow: 0 8px 30px rgba(61,36,15,0.04); }
  .banner-link:hover { border-color: var(--accent); transform: translateY(-2px); box-shadow: 0 12px 40px rgba(61,36,15,0.08); }
  .banner-icon { font-size: 28px; flex-shrink: 0; }
  .banner-name { font-size: 15px; font-weight: 700; color: var(--text); flex: 1; }
  .banner-arrow { font-size: 18px; color: var(--accent); font-weight: 700; }
  .banner-desc { font-size: 12px; color: var(--muted); margin-top: 2px; }
  footer { margin-top: 32px; padding-top: 22px; border-top: 1px solid var(--line); font-size: 11.5px; color: var(--muted); display: flex; justify-content: space-between; animation: fadeUp 0.5s ease 0.5s both; }
  footer a { color: var(--muted); text-decoration: none; }
  footer a:hover { color: var(--accent); }
  @keyframes fadeDown { from { opacity: 0; transform: translateY(-16px); } to { opacity: 1; transform: translateY(0); } }
  @keyframes fadeUp { from { opacity: 0; transform: translateY(16px); } to { opacity: 1; transform: translateY(0); } }
  @media (max-width: 600px) { .container { padding: 36px 18px 60px; } .summary-card, .news-card { padding: 20px 18px; } .pico-grid { grid-template-columns: 1fr; } footer { flex-direction: column; gap: 6px; text-align: center; } .topic-name { width: 70px; font-size: 11px; } }
</style>
</head>
<body>
<div class="container">
  <header>
    <div class="logo">&#129300;</div>
    <div class="header-text">
      <h1>Appearance Anxiety &middot; 容貌焦慮研究文獻日報</h1>
      <div class="header-meta">
        <span class="badge badge-date">&#128197; ${dateDisplay}</span>
        <span class="badge badge-count">&#128218; ${total} 篇文獻</span>
        <span class="badge badge-source">Powered by PubMed + Zhipu AI</span>
      </div>
    </div>
  </header>

  <div class="summary-card">
    <h2>&#128200; 今日文獻趨勢</h2>
    <p class="summary-text">${summary}</p>
  </div>

  ${topPicksHtml ? `<div class="section"><div class="section-title"><span class="section-icon">&#11088;</span>今日精選 TOP Picks</div>${topPicksHtml}</div>` : ''}

  ${allPapersHtml ? `<div class="section"><div class="section-title"><span class="section-icon">&#128196;</span>其他值得關注的文獻</div>${allPapersHtml}</div>` : ''}

  ${topicBarsHtml ? `<div class="topic-section section"><div class="section-title"><span class="section-icon">&#128202;</span>主題分佈</div>${topicBarsHtml}</div>` : ''}

  ${keywordsHtml ? `<div class="keywords-section section"><div class="section-title"><span class="section-icon">&#127991;</span>關鍵字</div><div class="keywords">${keywordsHtml}</div></div>` : ''}

  <div class="banner-section">
    <a href="https://www.leepsyclinic.com/" class="banner-link" target="_blank" rel="noopener">
      <span class="banner-icon">&#127973;</span>
      <div>
        <div class="banner-name">李政洋身心診所首頁</div>
      </div>
      <span class="banner-arrow">&rarr;</span>
    </a>
  </div>

  <div class="banner-section">
    <a href="https://blog.leepsyclinic.com/" class="banner-link" target="_blank" rel="noopener">
      <span class="banner-icon">&#128231;</span>
      <div>
        <div class="banner-name">訂閱電子報</div>
      </div>
      <span class="banner-arrow">&rarr;</span>
    </a>
  </div>

  <div class="banner-section">
    <a href="https://buymeacoffee.com/CYlee" class="banner-link" target="_blank" rel="noopener">
      <span class="banner-icon">&#9749;</span>
      <div>
        <div class="banner-name">Buy Me a Coffee</div>
      </div>
      <span class="banner-arrow">&rarr;</span>
    </a>
  </div>

  <footer>
    <span>資料來源：PubMed &middot; 分析模型：${modelUsed}</span>
    <span><a href="https://github.com/u8901006/appearance-anxiety">GitHub</a></span>
  </footer>
</div>
</body>
</html>`;
}

async function main() {
  const args = process.argv.slice(2);
  let inputPath = '';
  let outputPath = '';
  let apiKey = process.env.ZHIPU_API_KEY || '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' && args[i + 1]) { inputPath = args[i + 1]; i++; }
    else if (args[i] === '--output' && args[i + 1]) { outputPath = args[i + 1]; i++; }
    else if (args[i] === '--api-key' && args[i + 1]) { apiKey = args[i + 1]; i++; }
  }

  if (!inputPath || !outputPath) {
    console.error('[ERROR] --input and --output are required');
    process.exit(1);
  }
  if (!apiKey) {
    console.error('[ERROR] No API key. Set ZHIPU_API_KEY env var or use --api-key');
    process.exit(1);
  }

  const papersData = loadPapers(inputPath);
  if (!papersData || !papersData.papers || !papersData.papers.length) {
    console.error('[WARN] No papers found, generating empty report');
    const tzOffset = 8 * 60 * 60 * 1000;
    const analysis = {
      date: new Date(Date.now() + tzOffset).toISOString().split('T')[0],
      market_summary: '今日 PubMed 暫無新的容貌焦慮相關文獻更新。請明天再查看。',
      top_picks: [],
      all_papers: [],
      keywords: [],
      topic_distribution: {},
    };
    const html = generateHtml(analysis);
    const dir = path.dirname(outputPath);
    if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(outputPath, html, 'utf-8');
    console.error(`[INFO] Empty report saved to ${outputPath}`);
    return;
  }

  const analysis = await analyzePapers(apiKey, papersData);
  if (!analysis) {
    console.error('[ERROR] Analysis failed, cannot generate report');
    process.exit(1);
  }

  const html = generateHtml(analysis);
  const dir = path.dirname(outputPath);
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outputPath, html, 'utf-8');
  console.error(`[INFO] Report saved to ${outputPath}`);
}

main().catch((e) => {
  console.error(`[FATAL] ${e.message}`);
  process.exit(1);
});
