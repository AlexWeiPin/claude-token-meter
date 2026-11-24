# token-meter

## 簡介

token-meter 是一個 Claude Code 外掛（mod），會在 Claude Code 旁邊加上一個標題為「Claude 監控」的側邊面板，即時顯示 token 剩餘量、正在執行的 subagent，以及這個 session 實際用到的 skill。

- 支援 Claude 桌面版與終端機版 Claude Code；VS Code 與行動版會顯示較精簡的備用畫面。
- 面板關掉後，輸入 `/meter` 即可重新開啟。
- 每次工具呼叫後更新一次；詳細的 context 分析最多每 4 秒更新一次。
- 不發出任何網路請求，CPU 使用量極低。

## 功能

面板分為四個區塊。點擊區塊標題的 ▾ / ▸ 即可收合或展開，收合狀態會跨 session 保留。

### 1. Token 剩餘

- 以磁貼顯示 Context window 剩餘百分比；訂閱方案另外顯示 5 小時額度與每週額度的剩餘百分比，並附即時重置倒數。
- 額度是整個帳號共用的：各 session 會互相分享最新讀到的額度，閒置的 session 每 30 秒自動同步；重置時間一過就顯示 100%（已重置）。
- 標題列右側的 **↻ Reload** 會立即重新整理面板資料，不會在對話中送出任何指令。
- 磁貼可調整順序：桌面版與終端機版可直接拖曳（流暢、類似 Miro 的手感），其他環境則用 ◀ ▶ 按鈕。排列順序會被記住。
- Context window 磁貼對應桌面版內建的 context 摘要：顯示已用 / 總 token 數、前 6 大類別的細長堆疊長條（Messages 為淺藍、MCP tools 為紫色、System prompt 為棕色，其餘沿用 `/context` 的原始配色），並以一條細紅線標出觸發 auto-compact 的位置。

### 2. Subagents

- 每個執行中的 subagent 佔一整列磁貼，包含即時動畫、類型、描述、目前使用的工具、工具呼叫次數、即時 token 用量與已執行時間。
- 同時派出的 subagent 各自用不同顏色的動畫。同一批次中提早完成的會留在原位，變成綠色並標示「已完成」，等整批都結束後，整批移到「最近完成」（最新的在最上方，最多 4 筆）。

### 3. Skills

- 只顯示 Claude 真正呼叫過的 skill。
- 當前回合使用中的 skill 會以帶動畫的「使用中」磁貼呈現，之後列入「這個 session 用過」清單，並顯示使用次數。

### 4. 輸出內容

- 列出 Claude 在這個 session 用 Write 寫出的文件（報告、筆記等），最新的在最上方，顯示檔名、所在資料夾與寫入時間。
- 只收文件類檔案：`.md`、`.txt`、`.html`、`.csv`、`.tsv`、`.json`、`.yaml`、`.xml`、`.log`、`.rst`。程式碼和 `~/.claude` 底下的設定、記憶檔不列入。
- 點檔名會在 Claude 裡開一個預覽窗：Markdown 直接排版顯示，其他格式以程式碼區塊顯示；預覽窗可重新讀取、複製路徑或關閉，不會跳到外部程式。

## 安裝

在終端機版 Claude Code 的提示列輸入以下指令，接著輸入 `y` 新增 marketplace，再按 Enter 選擇 user scope：

```
/plugin install token-meter --marketplace AlexWeiPin/claude-token-meter
```

或在 shell 中執行：

```sh
claude plugin install token-meter --marketplace AlexWeiPin/claude-token-meter
```

Claude 桌面版無法執行 `/plugin`，請改用介面操作：點擊提示框旁的 + → Plugins → Add marketplace，輸入下列名稱，再點 Add plugin：

```
AlexWeiPin/claude-token-meter
```

已經開著的 session 可用下列指令載入更新：

```
/reload-plugins
```

## 使用

安裝後面板會自動出現在 Claude Code 旁邊，不需要額外設定。

- `/meter`：重新開啟「Claude 監控」面板。
- 點擊區塊標題收合或展開該區塊。
- 按右上角的 ↻ Reload 重新整理面板資料。
- 拖曳 Token 剩餘磁貼（或按 ◀ ▶）調整順序。
- 點「輸出內容」裡的檔名，在 Claude 裡預覽那份文件。

## 開發

在 repo 根目錄執行驗證與測試：

```sh
claude plugin validate .
claude plugin test .
```

主要檔案：

| 檔案 | 用途 |
| --- | --- |
| `.claude-plugin/plugin.json` | 外掛 manifest |
| `.claude-plugin/marketplace.json` | marketplace 設定 |
| `hooks/hooks.json` | hook 設定 |
| `hooks/register.tsx` | hooks 模組 |
| `hooks/token-board.tsx` | 可拖曳磁貼面板的前端模組 |
| `hooks/live-clock.tsx` | 自動更新的計時器 |
| `hooks/meter.test.tsx` | 測試 |
| `types/index.d.ts` | 狀態資料結構（state contract） |

## 授權

MIT License。
