# Appearance Anxiety Research Daily Report

容貌焦慮研究文獻日報 - 每日自動從 PubMed 抓取最新容貌焦慮、身體意象、BDD 相關研究文獻，由 AI 分析摘要後生成日報。

## 網站

https://u8901006.github.io/appearance-anxiety/

## 運作方式

1. **GitHub Actions** 每天 GMT+8 17:55 自動執行
2. **PubMed E-utilities API** 抓取過去 7 天的最新文獻
3. **Zhipu GLM-5-Turbo** AI 分析文獻，生成繁體中文摘要與分類
4. 部署至 **GitHub Pages**

## 技術規格

- Node.js 24
- AI 模型：GLM-5-Turbo（fallback：GLM-4.7 → GLM-4.7-Flash）
- Token 上限：50,000
- API 逾時：480 秒
- 增強型 JSON 容錯處理

## 授權

MIT License
