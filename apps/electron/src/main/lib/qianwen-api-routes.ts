/**
 * 千问 Token Plan 内部网关路由集中表。
 *
 * 千问 CLI 使用一组内部网关（无兼容性承诺）。所有 host、action、product 和 API 名
 * 只允许出现在本文件：查询链路禁止从渠道 baseUrl、上游响应或 renderer 输入拼装目标地址，
 * 避免把账号凭据发到用户可配置或攻击者可控的 host。
 */

/** 设备授权（device-code + PKCE）服务根地址。 */
export const QIANWEN_AUTH_ORIGIN = 'https://t.qianwenai.com'

/** 设备授权码申请地址。 */
export const QIANWEN_DEVICE_CODE_URL = `${QIANWEN_AUTH_ORIGIN}/cli/device/code`

/** 设备授权轮询地址。 */
export const QIANWEN_DEVICE_TOKEN_URL = `${QIANWEN_AUTH_ORIGIN}/cli/device/token`

/** 千问 CLI 管理接口（个人版派生凭据与团队版 BSS 查询）。 */
export const QIANWEN_CLI_API_URL = 'https://cli.qianwenai.com/data/v2/api.json'

/** 千问 cs-data 网关（个人版订阅/用量）。 */
export const QIANWEN_CS_DATA_URL = 'https://cs-data.qianwenai.com/cli/api.json'

/** 允许打开的授权页域名；打开浏览器前必须校验。 */
export const QIANWEN_VERIFICATION_HOST = 'account.qianwenai.com'

/** 官方 CLI 版本标识；部分网关按 UA 识别客户端。 */
export const QIANWEN_CLI_USER_AGENT = 'qianwen-cli/1.12.0'

/** 管理接口固定 region。 */
export const QIANWEN_REGION = 'cn-beijing'

/** 个人版 Token Plan 商品码。 */
export const QIANWEN_SOLO_COMMODITY_CODE = 'sfm_tokenplansolo_public_cn'

/** 团队版 Token Plan 商品码。 */
export const QIANWEN_TEAM_COMMODITY_CODE = 'sfm_tokenplanteams_dp_cn'

/** 个人版订阅信息 API 名。 */
export const QIANWEN_SOLO_SUBSCRIPTION_API =
  'zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/subscription'
/** 个人版用量 API 名。 */
export const QIANWEN_SOLO_USAGE_API = 'zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage'

/** cs-data 信封网关的固定 action（官方 `BroadScopeAspnGateway`）。 */
export const QIANWEN_CS_DATA_ACTION = 'BroadScopeAspnGateway'

/** cs-data 信封网关的固定 product（官方 `sfm_bailian`）。 */
export const QIANWEN_CS_DATA_PRODUCT = 'sfm_bailian'

/** 信封 `params.V` 版本号。 */
export const QIANWEN_GATEWAY_API_VERSION = '1.0'

/**
 * 信封里的 cornerstoneParam 固定上下文。
 *
 * 官方把业务参数和它一起序列化成 `params.Data`；少任何一个字段都会被网关拒绝。
 */
export const QIANWEN_CORNERSTONE_PARAM = {
  protocol: 'V2',
  console: 'ONE_CONSOLE',
  productCode: 'p_efm',
  switchUserType: 3,
  consoleSite: 'QIANWENAI',
} as const

/**
 * 构造 cs-data 信封请求地址。
 *
 * 官方实现：`POST /cli/api.json?action=BroadScopeAspnGateway&product=sfm_bailian&api=<API>`。
 * api 名含 `/`，交给 URLSearchParams 编码，避免手拼 query。
 */
export function buildQianwenCsDataUrl(api: string): string {
  const url = new URL(QIANWEN_CS_DATA_URL)
  url.search = new URLSearchParams({
    action: QIANWEN_CS_DATA_ACTION,
    product: QIANWEN_CS_DATA_PRODUCT,
    api,
  }).toString()
  return url.toString()
}

/** 单次授权请求超时（device code / token 轮询）。 */
export const QIANWEN_AUTH_REQUEST_TIMEOUT_MS = 30_000

/** 单次额度查询请求超时。 */
export const QIANWEN_QUOTA_REQUEST_TIMEOUT_MS = 15_000

/** 校验授权页是否属于千问受信任域名（HTTPS、默认端口、精确主机名）。 */
export function isQianwenVerificationUri(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:'
      && url.port === ''
      && url.hostname === QIANWEN_VERIFICATION_HOST
  } catch {
    return false
  }
}
