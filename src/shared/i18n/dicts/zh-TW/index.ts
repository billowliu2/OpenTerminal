import common from './common'
import settings from './settings'
import workspace from './workspace'
import terminal from './terminal'
import ssh from './ssh'
import panels from './panels'
import main from './main'

/** 繁體中文詞條。命名空間檔案依區域分工維護，詳見 src/shared/i18n/index.ts 的歸屬表。 */
export default {
  ...common,
  ...settings,
  ...workspace,
  ...terminal,
  ...ssh,
  ...panels,
  ...main
}
