import common from './common'
import settings from './settings'
import workspace from './workspace'
import terminal from './terminal'
import ssh from './ssh'
import panels from './panels'
import main from './main'

/** 简体中文词条。命名空间文件按区域分工维护，详见 src/shared/i18n/index.ts 的归属表。 */
export default {
  ...common,
  ...settings,
  ...workspace,
  ...terminal,
  ...ssh,
  ...panels,
  ...main
}
