/** 命名空间：terminal（终端视图：右键菜单、搜索、粘贴确认、工具条、提示）。归属：工作区/终端维护者。 */
const terminal: Record<string, string> = {
  'terminal.menu.find': '查找',
  'terminal.menu.selectAll': '全选',
  'terminal.menu.clear': '清屏',
  'terminal.search.placeholder': '搜索',
  'terminal.search.prev': '上一个',
  'terminal.search.next': '下一个',
  'terminal.search.found': '已找到',
  'terminal.search.notFound': '未找到',
  'terminal.suggest.hint': '↑/↓ 选择 · Tab 接受 · Esc 关闭',
  'terminal.rec.start': '开始记录',
  'terminal.rec.stop': '停止记录',
  'terminal.rec.startLog': '开始记录会话日志',
  'terminal.rec.stopLog': '停止记录会话日志',
  'terminal.rec.openLogs': '打开日志目录',
  'terminal.rec.openCwd': '打开工作区目录',
  'terminal.paste.title': '确认粘贴',
  'terminal.paste.message': '检测到多行或潜在危险命令，确定要粘贴到终端吗？',
  'terminal.paste.noPrompt': '本次会话不再提示',
  'terminal.paste.disableDetection': '关闭后续粘贴检测',
  'terminal.paste.hint': '可在通用终端设置中重新开启或切换检测策略。',
  'terminal.dead.message': '进程已退出 (代码 {code})'
}

export default terminal
