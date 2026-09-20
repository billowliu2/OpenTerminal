/** 命名空間：terminal（終端機檢視：右鍵選單、搜尋、貼上確認、工具列、提示）。歸屬：工作區/終端機維護者。 */
const terminal: Record<string, string> = {
  'terminal.menu.find': '尋找',
  'terminal.menu.selectAll': '全選',
  'terminal.menu.clear': '清除畫面',
  'terminal.search.placeholder': '搜尋',
  'terminal.search.prev': '上一個',
  'terminal.search.next': '下一個',
  'terminal.search.found': '已找到',
  'terminal.search.notFound': '未找到',
  'terminal.suggest.hint': '↑/↓ 選擇 · Tab 接受 · Esc 關閉',
  'terminal.rec.start': '開始錄製',
  'terminal.rec.stop': '停止錄製',
  'terminal.rec.startLog': '開始錄製工作階段日誌',
  'terminal.rec.stopLog': '停止錄製工作階段日誌',
  'terminal.rec.openLogs': '開啟日誌目錄',
  'terminal.rec.openCwd': '開啟工作區目錄',
  'terminal.paste.title': '確認貼上',
  'terminal.paste.message': '偵測到多行或潛在危險命令，確定要貼到終端機嗎？',
  'terminal.paste.noPrompt': '本次工作階段不再提示',
  'terminal.paste.disableDetection': '關閉後續貼上偵測',
  'terminal.paste.hint': '可在一般終端機設定中重新開啟或切換偵測策略。',
  'terminal.dead.message': '處理程序已結束 (代碼 {code})'
}

export default terminal
