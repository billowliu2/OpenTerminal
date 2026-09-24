/** 命名空间：main（主进程文案：托盘、关闭询问、更新器）。归属：主进程维护者。 */
const main: Record<string, string> = {
  'main.tray.showWindow': '显示主窗口',
  'main.tray.closeAction': '关闭按钮行为',
  'main.tray.askEveryTime': '每次询问',
  'main.tray.minimizeToTray': '最小化到托盘',
  'main.tray.exitDirectly': '直接退出',
  'main.tray.exit': '退出',
  'main.tray.balloonTitle': '已最小化到托盘',
  'main.tray.balloonContent': '终端会话仍在后台运行，点击托盘图标可恢复窗口。',
  'main.tray.closeTitle': '关闭 OpenTerminal',
  'main.tray.closeMessage': '最小化到托盘，还是直接退出？',
  'main.tray.closeDetail': '最小化到托盘时终端会话保持运行。',
  'main.tray.rememberChoice': '记住我的选择，不再询问',

  'main.updater.feedFailed': '国内源: {gitea}；GitHub: {github}',

  'main.ssh.connectTimeout': '连接超时 ({host}:{port})',
  'main.ssh.saveFingerprintFailed': '保存主机指纹失败: {detail}',
  'main.ssh.knownHostsUnreadable': '已知主机文件 (ssh_known_hosts.json) 存在但无法读取，为避免覆盖已保存的指纹，本次连接被拒绝。请修复或删除该文件后重试。',
  'main.ssh.hostKeyRejected': '用户拒绝了主机指纹',
  'main.ssh.connectFailed': '连接失败 {host}:{port}: {detail}',
  'main.ssh.shellOpenFailed': '无法打开 SSH shell ({host}:{port}): {detail}',
  'main.ssh.initFailed': 'SSH 连接初始化失败 ({host}:{port}): {detail}',
  'main.ssh.readKeyFailed': '无法读取私钥文件 {path}: {detail}',

  'main.sftp.sessionGone': 'SSH 会话不存在或已断开',
  'main.sftp.deleteFailed': '删除失败: {detail}',
  'main.sftp.invalidMode': '非法权限值: {mode}',
  'main.sftp.invalidUidGid': '非法 uid/gid',
  'main.sftp.commandTimeout': '命令执行超时',
  'main.sftp.commandExitCode': '命令退出码 {code}',
  'main.sftp.cancelled': '已取消',

  'main.zmodem.transferFailed': '传输失败',
  'main.zmodem.transferTimeout': '传输超时',
  'main.zmodem.sendFailed': '发送失败',
  'main.zmodem.uploadFailed': '上传失败',
  'main.zmodem.receiveFailed': '接收失败',
  'main.zmodem.abnormal': 'ZMODEM 传输异常',
  'main.zmodem.cancelled': '已取消',
  'main.zmodem.offerTimedOut': '未选择文件，已取消',
  'main.zmodem.sessionInvalid': '会话已失效',
  'main.zmodem.sessionCreateFailed': '无法建立 ZMODEM 会话',
  'main.zmodem.noSaveDir': '未指定保存目录',
  'main.zmodem.noFiles': '未选择文件',

  'main.ipc.connectionMissing': '连接书签不存在 ({id})',

  'main.sysinfo.sessionGone': 'SSH 会话不存在或已断开',
  'main.sysinfo.execFailed': 'SSH exec 失败',
  'main.sysinfo.pollTimeout': '监控命令响应超时',
  'main.sysinfo.parseFailed': '解析失败: {message}',
  'main.pty.serviceNotReady': 'SSH 会话服务尚未初始化',
  'main.pty.missingConnectionId': 'SSH 会话缺少 connectionId',
  'main.log.tuiOmitted': '全屏界面(TUI)输出已省略'
}

export default main
