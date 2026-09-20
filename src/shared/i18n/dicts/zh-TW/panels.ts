/** 命名空間：panels（命令面板、工作階段日誌面板、傳輸面板）。歸屬：SSH/面板維護者。 */
const panels: Record<string, string> = {
  // 命令面板
  'panels.commands.sectionTitle': '命令',
  'panels.commands.target': '傳送目標',
  'panels.commands.targetSsh': 'SSH 伺服器',
  'panels.commands.targetTerminal': '終端機',
  'panels.commands.tabHistory': '歷史',
  'panels.commands.tabLibrary': '命令庫',
  'panels.commands.historyTitle': '歷史命令',
  'panels.commands.clearTitle': '清空全部命令歷史？',
  'panels.commands.clear': '清空',
  'panels.commands.noHistory': '尚無歷史命令',
  'panels.commands.loading': '載入中…',
  'panels.commands.libraryTitle': '命令庫',
  'panels.commands.libraryEmpty': '命令庫為空',
  'panels.commands.add': '新增命令',
  'panels.commands.name': '名稱',
  'panels.commands.optional': '（選填）',
  'panels.commands.command': '命令',
  'panels.commands.commandPlaceholder': '如 ls -la',
  'panels.commands.note': '備註',
  'panels.commands.deleteTitle': '刪除該命令？',
  'panels.commands.deleteAria': '刪除命令',

  // 傳輸面板
  'panels.transfer.failed': '傳輸失敗',
  'panels.transfer.cancelled': '已取消',
  'panels.transfer.done': '傳輸完成',
  'panels.transfer.uploading': '上傳中',
  'panels.transfer.downloading': '下載中',
  'panels.transfer.zmodemUploading': 'ZMODEM 上傳中',
  'panels.transfer.zmodemDownloading': 'ZMODEM 下載中'
}

export default panels
