import common from './common'
import settings from './settings'
import workspace from './workspace'
import terminal from './terminal'
import ssh from './ssh'
import panels from './panels'
import main from './main'

/** English entries. Namespace files are owned per area — see the ownership map
 *  in src/shared/i18n/index.ts. */
export default {
  ...common,
  ...settings,
  ...workspace,
  ...terminal,
  ...ssh,
  ...panels,
  ...main
}
