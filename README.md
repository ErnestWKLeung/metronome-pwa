# 節拍器 Metronome PWA

簡潔、手機優先嘅節拍器 Progressive Web App。  
Repo：https://github.com/ErnestWKLeung/metronome-pwa

## 功能（MVP）

- BPM 控制：＋／−、±5、滑桿（40–240，預設 120）
- 點拍定速（Tap Tempo）
- 拍號：2/4、3/4、4/4、6/8
- 強拍／弱拍不同音高同音量（Web Audio 合成 click）
- 開始／停止
- 可加入主畫面：`manifest.webmanifest` + icons + service worker（離線快取 app shell）

**唔包括**：調音器、複節奏、播放清單、Rhythm Trainer、閃光、震動、MIDI。

## 本機開啟

用靜態伺服器開（service worker 需要 http／https，唔好直接雙擊 `file://`）：

```bash
cd metronome-pwa
python3 -m http.server 8080
# 瀏覽器開 http://localhost:8080
```

或者：

```bash
npx --yes serve -l 8080 .
```

## iOS 限制

iOS Safari／「加入主畫面」App 喺切去背景或鎖屏後，系統多數會暫停音訊。本 App 會用 AudioContext + 極細聲 keep-alive + Screen Wake Lock（若支援）盡力維持，但**背景播放唔保證**。練習時請保持畫面喺前景。介面底部有同樣提示。

## Cloudflare Pages 部署

本 repo 係純靜態檔，適合 Cloudflare Pages：

1. Cloudflare Dashboard → Workers & Pages → Create → Pages → Connect to Git
2. 揀 `ErnestWKLeung/metronome-pwa`，production branch `main`
3. Build 設定：Framework preset = None；Build command 留空；Output directory = `/`（或 `.`）
4. Save and Deploy

若已安裝並登入 Wrangler：

```bash
npx wrangler pages deploy . --project-name=metronome-pwa
```

（若未 `wrangler login`／未連 Cloudflare 帳號，請先完成登入再 deploy。）

## 技術

- 純 HTML / CSS / JS，無框架、無 build step
- Web Audio API 合成 click
- Service Worker：`metronome-pwa-v1` cache
