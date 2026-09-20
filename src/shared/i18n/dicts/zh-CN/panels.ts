/** 命名空间：panels（命令面板、会话日志面板、传输面板）。归属：SSH/面板维护者。 */
const panels: Record<string, string> = {
  // 命令面板
  'panels.commands.sectionTitle': '命令',
  'panels.commands.target': '发送目标',
  'panels.commands.targetSsh': 'SSH 服务器',
  'panels.commands.targetTerminal': '终端',
  'panels.commands.tabHistory': '历史',
  'panels.commands.tabLibrary': '命令库',
  'panels.commands.historyTitle': '历史命令',
  'panels.commands.clearTitle': '清空全部命令历史？',
  'panels.commands.clear': '清空',
  'panels.commands.noHistory': '暂无历史命令',
  'panels.commands.loading': '加载中…',
  'panels.commands.libraryTitle': '命令库',
  'panels.commands.libraryEmpty': '命令库为空',
  'panels.commands.add': '新增命令',
  'panels.commands.name': '名称',
  'panels.commands.optional': '(可选)',
  'panels.commands.command': '命令',
  'panels.commands.commandPlaceholder': '如 ls -la',
  'panels.commands.note': '备注',
  'panels.commands.deleteTitle': '删除该命令？',
  'panels.commands.deleteAria': '删除命令',

  // 传输面板
  'panels.transfer.failed': '传输失败',
  'panels.transfer.cancelled': '已取消',
  'panels.transfer.done': '传输完成',
  'panels.transfer.uploading': '上传中',
  'panels.transfer.downloading': '下载中',
  'panels.transfer.zmodemUploading': 'ZMODEM 上传中',
  'panels.transfer.zmodemDownloading': 'ZMODEM 下载中'
}

export default panels
