/** 名前空間: panels（コマンドパネル、セッションログパネル、転送パネル）。担当: パネル。 */
const panels: Record<string, string> = {
  // コマンドパネル
  'panels.commands.sectionTitle': 'コマンド',
  'panels.commands.target': '送信先',
  'panels.commands.targetSsh': 'SSH サーバー',
  'panels.commands.targetTerminal': 'ターミナル',
  'panels.commands.tabHistory': '履歴',
  'panels.commands.tabLibrary': 'コマンドライブラリ',
  'panels.commands.historyTitle': '履歴コマンド',
  'panels.commands.clearTitle': 'すべてのコマンド履歴を消去しますか？',
  'panels.commands.clear': '消去',
  'panels.commands.noHistory': 'コマンド履歴はありません',
  'panels.commands.loading': '読み込み中…',
  'panels.commands.libraryTitle': 'コマンドライブラリ',
  'panels.commands.libraryEmpty': 'コマンドライブラリは空です',
  'panels.commands.add': 'コマンドを追加',
  'panels.commands.name': '名前',
  'panels.commands.optional': '（任意）',
  'panels.commands.command': 'コマンド',
  'panels.commands.commandPlaceholder': '例：ls -la',
  'panels.commands.note': 'メモ',
  'panels.commands.deleteTitle': 'このコマンドを削除しますか？',
  'panels.commands.deleteAria': 'コマンドを削除',

  // 転送パネル
  'panels.transfer.failed': '転送に失敗しました',
  'panels.transfer.cancelled': 'キャンセル済み',
  'panels.transfer.done': '転送が完了しました',
  'panels.transfer.uploading': 'アップロード中',
  'panels.transfer.downloading': 'ダウンロード中',
  'panels.transfer.zmodemUploading': 'ZMODEM アップロード中',
  'panels.transfer.zmodemDownloading': 'ZMODEM ダウンロード中'
}

export default panels
