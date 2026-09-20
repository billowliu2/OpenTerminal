/** 名前空間: terminal（ターミナル表示：コンテキストメニュー、検索、貼り付け確認、ツールバー、ヒント）。担当: ワークスペース/ターミナル。 */
const terminal: Record<string, string> = {
  'terminal.menu.find': '検索',
  'terminal.menu.selectAll': 'すべて選択',
  'terminal.menu.clear': '画面クリア',
  'terminal.search.placeholder': '検索',
  'terminal.search.prev': '前へ',
  'terminal.search.next': '次へ',
  'terminal.search.found': '見つかりました',
  'terminal.search.notFound': '見つかりません',
  'terminal.suggest.hint': '↑/↓ 選択 · Tab で確定 · Esc で閉じる',
  'terminal.rec.start': '記録開始',
  'terminal.rec.stop': '記録停止',
  'terminal.rec.startLog': 'セッションログの記録を開始',
  'terminal.rec.stopLog': 'セッションログの記録を停止',
  'terminal.rec.openLogs': 'ログフォルダーを開く',
  'terminal.rec.openCwd': 'ワークスペースフォルダーを開く',
  'terminal.paste.title': '貼り付けの確認',
  'terminal.paste.message': '複数行または危険な可能性のあるコマンドを検出しました。ターミナルに貼り付けますか？',
  'terminal.paste.noPrompt': 'このセッションでは表示しない',
  'terminal.paste.disableDetection': '今後の貼り付けチェックを無効にする',
  'terminal.paste.hint': '一般のターミナル設定で再度有効にするか、検出ポリシーを変更できます。',
  'terminal.dead.message': 'プロセスが終了しました (コード {code})'
}

export default terminal
